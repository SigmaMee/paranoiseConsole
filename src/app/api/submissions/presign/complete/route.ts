import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";

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

type CompletedPart = {
  PartNumber: number;
  ETag: string;
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

    const body = (await request.json()) as {
      objectKey?: string;
      uploadId?: string;
      parts?: CompletedPart[];
    };

    if (!body.objectKey || !body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
      return NextResponse.json({ error: "Missing objectKey, uploadId, or parts." }, { status: 400 });
    }

    // Verify the object belongs to this user
    if (!body.objectKey.startsWith(`staging/${user.id}/`)) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
    }

    await r2.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: body.objectKey,
        UploadId: body.uploadId,
        MultipartUpload: {
          Parts: body.parts.map((p) => ({
            PartNumber: p.PartNumber,
            ETag: p.ETag,
          })),
        },
      }),
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to complete multipart upload: ${error.message}`
            : "Failed to complete multipart upload.",
      },
      { status: 500 },
    );
  }
}