import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import archiver from "archiver";
import { PassThrough } from "node:stream";
import { Writable } from "node:stream";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/admin-access";
import { google } from "googleapis";
import { getGoogleDriveOAuthClientFromStoredToken } from "@/lib/google-drive-oauth";
import { getDriveWeekdayFolderIdForShowStart } from "@/lib/submission-routing";
import { Client } from "basic-ftp";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function r2Client() {
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

async function getImage(objectKey: string) {
  const response = await r2Client().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: objectKey,
  }));
  if (!response.Body) throw new Error("Image body is empty");
  return {
    bytes: Buffer.from(await response.Body.transformToByteArray()),
    contentType: response.ContentType || "application/octet-stream",
  };
}

function escapeDriveQueryLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function getDriveAuth() {
  const oauthClient = await getGoogleDriveOAuthClientFromStoredToken();
  if (oauthClient) return oauthClient;
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
    key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

async function getImageFromFtp(objectKey: string, producerFolder: string) {
  const client = new Client();
  try {
    await client.access({
      host: process.env.FTP_HOST!,
      user: process.env.FTP_USER!,
      password: process.env.FTP_PASSWORD!,
      secure: process.env.FTP_SECURE === "true",
    });
    await client.cd(process.env.FTP_PRODUCER_ROOT_DIR!);
    await client.cd(producerFolder.trim());
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    try {
      await client.downloadTo(output, objectKey);
    } catch {
      const sanitized = safeFilename(objectKey);
      if (sanitized === objectKey) throw new Error("Picture was not found on FTP");
      await client.downloadTo(output, sanitized);
    }
    const extension = objectKey.toLowerCase().split(".").pop();
    const contentType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
    return { bytes: Buffer.concat(chunks), contentType };
  } finally {
    client.close();
  }
}

async function getImageFromMixcloud(mixcloudUrl: string) {
  const parsed = new URL(mixcloudUrl);
  const metadataResponse = await fetch(`https://api.mixcloud.com${parsed.pathname}`);
  if (!metadataResponse.ok) throw new Error("Mixcloud metadata was unavailable");
  const metadata = (await metadataResponse.json()) as { pictures?: { extra_large?: string; large?: string } };
  const pictureUrl = metadata.pictures?.extra_large || metadata.pictures?.large;
  if (!pictureUrl) throw new Error("Mixcloud cover was unavailable");
  const pictureResponse = await fetch(pictureUrl);
  if (!pictureResponse.ok) throw new Error("Mixcloud cover download failed");
  return {
    bytes: Buffer.from(await pictureResponse.arrayBuffer()),
    contentType: pictureResponse.headers.get("content-type") || "image/jpeg",
  };
}

async function getImageWithFallbacks(
  r2ObjectKey: string,
  filename: string,
  airingDate: string,
  producerFolder: string,
  mixcloudUrl: string,
) {
  try {
    if (!r2ObjectKey) throw new Error("No retained R2 cover key");
    return await getImage(r2ObjectKey);
  } catch {
    try {
      const folderId = await getDriveWeekdayFolderIdForShowStart(`${airingDate}T12:00:00Z`);
      const drive = google.drive({ version: "v3", auth: await getDriveAuth() });
      const files = await drive.files.list({
        q: `'${folderId}' in parents and name='${escapeDriveQueryLiteral(filename)}' and trashed=false`,
        fields: "files(id,mimeType,createdTime)",
        orderBy: "createdTime desc",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      let file = files.data.files?.[0];
      if (!file?.id) {
        const globalFiles = await drive.files.list({
          q: `name='${escapeDriveQueryLiteral(filename)}' and trashed=false`,
          fields: "files(id,mimeType,createdTime)",
          orderBy: "createdTime desc",
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        file = globalFiles.data.files?.[0];
      }
      if (!file?.id) throw new Error("Picture was not found in Google Drive");
      const media = await drive.files.get(
        { fileId: file.id, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      return {
        bytes: Buffer.from(media.data as ArrayBuffer),
        contentType: file.mimeType || "application/octet-stream",
      };
    } catch {
      if (mixcloudUrl) {
        try {
          return await getImageFromMixcloud(mixcloudUrl);
        } catch {}
      }
      return getImageFromFtp(filename, producerFolder);
    }
  }
}

async function getProducerFolder(producerEmail: string) {
  const { data } = await adminClient()
    .from("profiles")
    .select("full_name")
    .ilike("producer_email", producerEmail)
    .maybeSingle();
  return typeof data?.full_name === "string" ? data.full_name.trim() : "";
}

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function retainLegacyImage(
  submissionId: string,
  filename: string,
  image: { bytes: Buffer; contentType: string },
) {
  const objectKey = `covers/legacy/${submissionId}/${safeFilename(filename)}`;
  await r2Client().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: objectKey,
    Body: image.bytes,
    ContentType: image.contentType,
    CacheControl: "private, max-age=31536000, immutable",
  }));
  const { error } = await adminClient()
    .from("submissions")
    .update({ image_object_key: objectKey })
    .eq("id", submissionId);
  if (error) throw error;
}

export async function GET(request: Request) {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Missing picture id." }, { status: 400 });

  const { data } = await adminClient()
    .from("submissions")
    .select("image_filename,image_object_key,airing_date,producer_email,mixcloud_url")
    .eq("id", id)
    .maybeSingle();
  const filename = typeof data?.image_filename === "string" ? data.image_filename.trim() : "";
  const airingDate = typeof data?.airing_date === "string" ? data.airing_date : "";
  if (!filename || !airingDate) return NextResponse.json({ error: "Picture not found." }, { status: 404 });

  try {
    const producerFolder = await getProducerFolder(String(data?.producer_email || ""));
    const image = await getImageWithFallbacks(
      String(data?.image_object_key || ""),
      filename,
      airingDate,
      producerFolder,
      String(data?.mixcloud_url || ""),
    );
    if (!data?.image_object_key) {
      await retainLegacyImage(id, filename, image).catch((error) => {
        console.warn(`Could not retain legacy cover ${id} in R2:`, error);
      });
    }
    return new NextResponse(new Uint8Array(image.bytes), {
      headers: {
        "Content-Type": image.contentType,
        "Content-Disposition": `inline; filename="${safeFilename(filename)}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Picture is no longer available." }, { status: 404 });
  }
}

export async function POST(request: Request) {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  const payload = (await request.json()) as { submissionIds?: unknown };
  if (!Array.isArray(payload.submissionIds) || payload.submissionIds.length === 0) {
    return NextResponse.json({ error: "Select at least one picture." }, { status: 400 });
  }

  const ids = payload.submissionIds.filter((id): id is string => typeof id === "string").slice(0, 100);
  const { data: rows, error } = await adminClient()
    .from("submissions")
    .select("id,image_filename,image_object_key,airing_date,producer_email,mixcloud_url")
    .in("id", ids);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const available: Array<{ bytes: Buffer; filename: string; date: string }> = [];
  for (const row of rows || []) {
    const filename = typeof row.image_filename === "string" ? row.image_filename.trim() : "";
    if (!filename) continue;
    try {
      const producerFolder = await getProducerFolder(String(row.producer_email || ""));
      const image = await getImageWithFallbacks(
        String(row.image_object_key || ""),
        filename,
        String(row.airing_date || ""),
        producerFolder,
        String(row.mixcloud_url || ""),
      );
      if (!row.image_object_key) {
        await retainLegacyImage(row.id, filename, image).catch((retentionError) => {
          console.warn(`Could not retain legacy cover ${row.id} in R2:`, retentionError);
        });
      }
      available.push({ bytes: image.bytes, filename: safeFilename(filename), date: row.airing_date || "undated" });
    } catch {}
  }
  if (available.length === 0) {
    return NextResponse.json({ error: "The selected pictures are no longer available." }, { status: 404 });
  }

  if (available.length === 1) {
    const picture = available[0];
    return new NextResponse(new Uint8Array(picture.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${picture.filename}"`,
      },
    });
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  archive.pipe(output);
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    output.on("end", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  for (const picture of available) {
    archive.append(picture.bytes, { name: `${picture.date}/${picture.filename}` });
  }
  await archive.finalize();
  await finished;
  const zip = Buffer.concat(chunks);
  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="paranoise-pictures.zip"',
      "Content-Length": String(zip.length),
    },
  });
}
