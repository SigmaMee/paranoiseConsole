import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  signingEscapePath: false,
});

const BUCKET = process.env.R2_BUCKET_NAME!;
const URL_TTL_SECONDS = 900;

// Files larger than this threshold use multipart upload (10 MB)
const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;
// Default and bounds for multipart part sizing
const DEFAULT_PART_SIZE_BYTES = 20 * 1024 * 1024;
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_SIZE_BYTES = 50 * 1024 * 1024;

const UNSIGNABLE_HEADERS = new Set([
  "x-amz-content-sha256",
  "x-amz-checksum-crc32",
  "x-amz-sdk-checksum-algorithm",
]);

type FileDescriptor = {
  field: "audio" | "image";
  filename: string;
  contentType: string;
  size: number;
  partSizeBytes?: number;
};

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as { files?: FileDescriptor[] };
    const files = body.files;

    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "No files requested." }, { status: 400 });
    }

    if (files.length > 2) {
      return NextResponse.json({ error: "Maximum 2 files per request." }, { status: 400 });
    }

    const results: Array<{
      field: string;
      objectKey: string;
      presignedUrl?: string;
      uploadId?: string;
      partUrls?: string[];
      partSize?: number;
    }> = [];

    for (const file of files) {
      if (file.field !== "audio" && file.field !== "image") {
        return NextResponse.json({ error: `Invalid field: ${file.field}` }, { status: 400 });
      }

      const requestedPartSize =
        typeof file.partSizeBytes === "number" && Number.isFinite(file.partSizeBytes)
          ? Math.max(MIN_PART_SIZE_BYTES, Math.min(MAX_PART_SIZE_BYTES, Math.floor(file.partSizeBytes)))
          : DEFAULT_PART_SIZE_BYTES;

      const objectKey = `staging/${user.id}/${file.field}/${randomUUID()}-${file.filename}`;

      if (file.size > MULTIPART_THRESHOLD_BYTES) {
        // --- Multipart path ---
        const createCmd = new CreateMultipartUploadCommand({
          Bucket: BUCKET,
          Key: objectKey,
          ContentType: file.contentType,
        });
        const { UploadId } = await r2.send(createCmd);

        if (!UploadId) {
          throw new Error("Failed to initiate multipart upload.");
        }

        const partCount = Math.ceil(file.size / requestedPartSize);
        const partUrls: string[] = [];

        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
          const partCmd = new UploadPartCommand({
            Bucket: BUCKET,
            Key: objectKey,
            UploadId,
            PartNumber: partNumber,
          });
          const partUrl = await getSignedUrl(r2, partCmd, {
            expiresIn: URL_TTL_SECONDS,
            unsignableHeaders: UNSIGNABLE_HEADERS,
            unhoistableHeaders: UNSIGNABLE_HEADERS,
          });
          partUrls.push(partUrl);
        }

        results.push({
          field: file.field,
          objectKey,
          uploadId: UploadId,
          partUrls,
          partSize: requestedPartSize,
        });
      } else {
        // --- Single-part path ---
        const command = new PutObjectCommand({
          Bucket: BUCKET,
          Key: objectKey,
          ContentType: file.contentType,
        });
        const presignedUrl = await getSignedUrl(r2, command, {
          expiresIn: URL_TTL_SECONDS,
          unsignableHeaders: UNSIGNABLE_HEADERS,
          unhoistableHeaders: UNSIGNABLE_HEADERS,
        });
        results.push({ field: file.field, objectKey, presignedUrl });
      }
    }

    return NextResponse.json({ files: results });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to generate upload URLs: ${error.message}`
            : "Failed to generate upload URLs.",
      },
      { status: 500 },
    );
  }
}