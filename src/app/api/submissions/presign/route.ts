import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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
});

const BUCKET = process.env.R2_BUCKET_NAME!;

// Each presigned URL is valid for 15 minutes — enough for the client to start
// the upload; the object itself is cleaned up by the submissions route after
// it has been forwarded to FTP / Google Drive.
const URL_TTL_SECONDS = 900;

type FileDescriptor = {
  field: "audio" | "image";
  filename: string;
  contentType: string;
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
      presignedUrl: string;
    }> = [];

    for (const file of files) {
      if (file.field !== "audio" && file.field !== "image") {
        return NextResponse.json(
          { error: `Invalid field: ${file.field}` },
          { status: 400 },
        );
      }

      // Namespace by user so keys are predictable and easy to clean up
      const objectKey = `staging/${user.id}/${file.field}/${randomUUID()}-${file.filename}`;

      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: objectKey,
        ContentType: file.contentType,
      });

      const presignedUrl = await getSignedUrl(r2, command, {
        expiresIn: URL_TTL_SECONDS,
      });

      results.push({ field: file.field, objectKey, presignedUrl });
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