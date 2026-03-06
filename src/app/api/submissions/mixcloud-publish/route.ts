import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { uploadToMixcloud } from "@/lib/mixcloud-api";
import { getSignedR2Url, deleteFromR2, fileExistsInR2 } from "@/lib/r2-utils";
import { getDriveWeekdayFolderIdForShowStart } from "@/lib/submission-routing";
import { getGoogleDriveOAuthClientFromStoredToken } from "@/lib/google-drive-oauth";
import { google } from "googleapis";
import { Client } from "basic-ftp";
import { Writable } from "stream";

export const runtime = "nodejs";
export const maxDuration = 300;

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function getDriveAuth() {
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");

  const serviceAccountAuth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  const oauthClient = await getGoogleDriveOAuthClientFromStoredToken();
  if (oauthClient) {
    try {
      await oauthClient.getAccessToken();
      return oauthClient;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("invalid_grant")) {
        throw error;
      }
      return serviceAccountAuth;
    }
  }

  return serviceAccountAuth;
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Download file from FTP as Buffer
 */
async function downloadFromFtp(filename: string, producerFolderName: string): Promise<Buffer | null> {
  const client = new Client();
  client.ftp.verbose = true; // Enable verbose logging

  try {
    const host = getRequiredEnv("FTP_HOST");
    const user = getRequiredEnv("FTP_USER");
    const password = getRequiredEnv("FTP_PASSWORD");
    const producerRootDir = getRequiredEnv("FTP_PRODUCER_ROOT_DIR");
    const secure = process.env.FTP_SECURE === "true";

    // Sanitize filename to match what was uploaded
    const sanitizedFilename = sanitizeFilename(filename);

    console.log(`FTP: Connecting to ${host}`);
    console.log(`FTP: Original filename: "${filename}", sanitized: "${sanitizedFilename}"`);
    
    await client.access({ host, user, password, secure });
    console.log(`FTP: Connected, navigating to: ${producerRootDir}/${producerFolderName}`);
    
    // Navigate step by step
    await client.cd(producerRootDir);
    console.log(`FTP: Changed to ${producerRootDir}`);
    
    await client.cd(producerFolderName.trim());
    console.log(`FTP: Changed to producer folder, downloading: ${sanitizedFilename}`);

    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await client.downloadTo(writable, sanitizedFilename);
    const buffer = Buffer.concat(chunks);
    console.log(`FTP: Download complete, size: ${buffer.length} bytes`);
    return buffer;
  } catch (err) {
    console.error(`FTP Error - Producer: "${producerFolderName}", File: "${filename}"`, err);
    return null;
  } finally {
    client.close();
  }
}

/**
 * Download file from Google Drive as Buffer
 */
async function downloadFromDrive(filename: string, showStart: string): Promise<Buffer | null> {
  try {
    const folderId = await getDriveWeekdayFolderIdForShowStart(showStart);
    const auth = await getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const escapedName = escapeDriveQueryLiteral(filename);
    const fileListResponse = await drive.files.list({
      q: `'${folderId}' in parents and name='${escapedName}' and trashed=false`,
      fields: "files(id)",
      pageSize: 1,
      orderBy: "createdTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const file = fileListResponse.data.files?.[0];
    if (!file?.id) return null;

    const response = await drive.files.get(
      { fileId: file.id, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );

    return Buffer.from(response.data as ArrayBuffer);
  } catch (err) {
    console.error(`Failed to download ${filename} from Drive:`, err);
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const { submissionIds } = await request.json();
    console.log("Received submissionIds:", submissionIds);
    
    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
      return NextResponse.json({ error: "No submissions selected." }, { status: 400 });
    }

    // Verify user is authenticated
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const adminSupabase = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    // Fetch submissions with producer info
    const { data: submissions, error } = await adminSupabase
      .from("submissions")
      .select("id, producer_email, mixcloud, audio_filename, image_filename, airing_date, submitted_tags, ftp_status, drive_status")
      .in("id", submissionIds);

    console.log("Fetched submissions:", submissions);
    console.log("Supabase error:", error);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Filter only ready submissions
    const readySubs = (submissions || []).filter((s) => s.mixcloud === "ready");
    console.log("Ready submissions:", readySubs);
    
    if (readySubs.length === 0) {
      return NextResponse.json({ 
        error: "No ready submissions to publish.",
        debug: { 
          receivedIds: submissionIds, 
          fetchedCount: submissions?.length || 0,
          submissions: submissions 
        }
      }, { status: 400 });
    }

    // Mixcloud API publishing
    const results = [];
    for (const sub of readySubs) {
      try {
        // Use audio filename as the show title, removing extension and date suffix
        let name = "Show";
        if (sub.audio_filename) {
          // Remove file extension
          let basename = sub.audio_filename.replace(/\.[^.]+$/, '');
          // Remove date suffix pattern (-DDMMYY at the end)
          basename = basename.replace(/-\d{6}$/, '');
          name = basename;
        }
        
        const tags = (sub.submitted_tags as string[]) || [];
        const description = "Uploaded via Paranoise Console";

        // Get producer folder name from profiles
        const { data: profile } = await adminSupabase
          .from("profiles")
          .select("full_name")
          .eq("producer_email", sub.producer_email)
          .single();

        if (!profile?.full_name) {
          throw new Error(`Producer folder name not found for ${sub.producer_email}`);
        }

        const producerFolderName = profile.full_name.trim();

        // Determine storage location and get files
        let audioBuffer: Buffer | undefined;
        let audioUrl: string | undefined;
        let pictureBuffer: Buffer | undefined;
        let pictureUrl: string | undefined;

        // Check if files are in R2 (new workflow)
        const audioInR2 = sub.audio_filename ? await fileExistsInR2(sub.audio_filename) : false;
        const imageInR2 = sub.image_filename ? await fileExistsInR2(sub.image_filename) : false;

        console.log(`Audio in R2: ${audioInR2}, Image in R2: ${imageInR2}`);
        console.log(`FTP status: ${sub.ftp_status}, Drive status: ${sub.drive_status}`);

        // Audio: R2 (new) or FTP (legacy)
        if (audioInR2 && sub.audio_filename) {
          audioUrl = await getSignedR2Url(sub.audio_filename);
        } else if (sub.audio_filename) {
          console.log(`Downloading audio from FTP: ${sub.audio_filename}`);
          audioBuffer = await downloadFromFtp(sub.audio_filename, producerFolderName) || undefined;
          if (!audioBuffer) throw new Error(`Failed to download audio file from FTP: ${sub.audio_filename}`);
        } else {
          throw new Error("Missing audio file");
        }

        // Image: R2 (new), Drive (legacy upcoming), or FTP (legacy past)
        if (imageInR2 && sub.image_filename) {
          pictureUrl = await getSignedR2Url(sub.image_filename);
        } else if (sub.image_filename) {
          // Try Google Drive first (for upcoming shows), then FTP
          if (sub.drive_status === "success" && sub.airing_date) {
            console.log(`Downloading image from Drive: ${sub.image_filename}`);
            pictureBuffer = await downloadFromDrive(sub.image_filename, sub.airing_date) || undefined;
          }
          
          // Fall back to FTP if not in Drive
          if (!pictureBuffer) {
            console.log(`Downloading image from FTP: ${sub.image_filename}`);
            pictureBuffer = await downloadFromFtp(sub.image_filename, producerFolderName) || undefined;
          }
          // Picture is optional, so don't throw if missing
        }

        console.log(`Uploading to Mixcloud: ${name}`);
        const mixcloudRes = await uploadToMixcloud({
          audioUrl,
          audioBuffer,
          name,
          tags,
          description,
          pictureUrl,
          pictureBuffer,
        });

        // Mark as published (use admin client)
        await adminSupabase
          .from("submissions")
          .update({ mixcloud: "published" })
          .eq("id", sub.id);

        // Delete files from R2 after successful upload (only if they were in R2)
        if (audioInR2 && sub.audio_filename) {
          try {
            await deleteFromR2(sub.audio_filename);
            console.log(`Deleted audio from R2: ${sub.audio_filename}`);
          } catch (err) {
            console.warn(`Failed to delete audio file ${sub.audio_filename} from R2:`, err);
          }
        }
        
        if (imageInR2 && sub.image_filename) {
          try {
            await deleteFromR2(sub.image_filename);
            console.log(`Deleted image from R2: ${sub.image_filename}`);
          } catch (err) {
            console.warn(`Failed to delete image file ${sub.image_filename} from R2:`, err);
          }
        }

        results.push({ id: sub.id, status: "published", mixcloud: mixcloudRes });
      } catch (err: any) {
        results.push({ id: sub.id, status: "error", error: err.message });
      }
    }
    return NextResponse.json({ success: true, results });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
