import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/**
 * Generate a signed URL for accessing a file in R2 (valid for 1 hour)
 */
export async function getSignedR2Url(objectKey: string): Promise<string> {
  const client = getR2Client();
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: objectKey,
  });
  return getSignedUrl(client, command, { expiresIn: 3600 }); // 1 hour
}

/**
 * Delete a file from R2
 */
export async function deleteFromR2(objectKey: string): Promise<void> {
  const client = getR2Client();
  const command = new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: objectKey,
  });
  await client.send(command);
}

/**
 * Check if a file exists in R2
 */
export async function fileExistsInR2(objectKey: string): Promise<boolean> {
  const client = getR2Client();
  const command = new HeadObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: objectKey,
  });
  try {
    await client.send(command);
    return true;
  } catch {
    return false;
  }
}
