/**
 * R2 connection test
 * Run with: npx tsx scripts/test-r2.ts
 *
 * Requires your .env.local to be present, or env vars set in your shell.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.local
config({ path: resolve(process.cwd(), ".env.local") });

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME;

function checkEnvVars() {
  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!bucketName) missing.push("R2_BUCKET_NAME");

  if (missing.length > 0) {
    console.error("❌ Missing environment variables:", missing.join(", "));
    process.exit(1);
  }

  console.log("✅ All env vars present");
}

async function runTests() {
  checkEnvVars();

  const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
    },
  });

  const testKey = `test-connection/${Date.now()}.txt`;
  const testContent = "r2 connection test";

  // 1. Write a small object
  process.stdout.write("→ Writing test object... ");
  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: testKey,
        Body: testContent,
        ContentType: "text/plain",
      }),
    );
    console.log("✅ OK");
  } catch (error) {
    console.error("❌ Failed to write:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // 2. Read it back
  process.stdout.write("→ Reading test object... ");
  try {
    const response = await r2.send(
      new GetObjectCommand({ Bucket: bucketName, Key: testKey }),
    );
    const chunks: Buffer[] = [];
    // @ts-expect-error Body is a readable stream in Node
    for await (const chunk of response.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf-8");
    if (body !== testContent) {
      console.error(`❌ Content mismatch — got: "${body}"`);
      process.exit(1);
    }
    console.log("✅ OK");
  } catch (error) {
    console.error("❌ Failed to read:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // 3. Delete the test object
  process.stdout.write("→ Deleting test object... ");
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: bucketName, Key: testKey }));
    console.log("✅ OK");
  } catch (error) {
    console.error("❌ Failed to delete:", error instanceof Error ? error.message : error);
    process.exit(1);
  }

  console.log("\n✅ R2 connection successful — read, write, and delete all working.");
}

runTests().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
