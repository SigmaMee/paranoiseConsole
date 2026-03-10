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

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function downloadFromFtpWithFallback(
  filename: string,
  producerFolderName: string,
): Promise<Buffer | null> {
  const exact = await downloadFromFtp(filename, producerFolderName);
  if (exact) {
    return exact;
  }

  const sanitized = sanitizeFilename(filename);
  if (sanitized !== filename) {
    return downloadFromFtp(sanitized, producerFolderName);
  }

  return null;
}

async function resolveR2KeyWithFallback(filename: string): Promise<string | null> {
  const exactExists = await fileExistsInR2(filename);
  if (exactExists) {
    return filename;
  }

  const sanitized = sanitizeFilename(filename);
  if (sanitized !== filename) {
    const sanitizedExists = await fileExistsInR2(sanitized);
    if (sanitizedExists) {
      return sanitized;
    }
  }

  return null;
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

    console.log(`FTP: Connecting to ${host}`);
    console.log(`FTP: Downloading file: "${filename}"`);
    
    await client.access({ host, user, password, secure });
    console.log(`FTP: Connected, navigating to: ${producerRootDir}/${producerFolderName}`);
    
    // Navigate step by step
    await client.cd(producerRootDir);
    console.log(`FTP: Changed to ${producerRootDir}`);
    
    await client.cd(producerFolderName.trim());
    console.log(`FTP: Changed to producer folder, downloading: ${filename}`);

    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await client.downloadTo(writable, filename);
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
    
    // Fetch the initial submissions to get producer_email + airing_date combinations
    const { data: initialSubmissions, error: initialError } = await adminSupabase
      .from("submissions")
      .select("producer_email, airing_date")
      .in("id", submissionIds);

    console.log("Initial submissions:", initialSubmissions);

    if (initialError) {
      return NextResponse.json({ error: initialError.message }, { status: 500 });
    }

    if (!initialSubmissions || initialSubmissions.length === 0) {
      return NextResponse.json({ error: "No submissions found." }, { status: 404 });
    }

    // Get unique producer_email + airing_date combinations
    const showKeys = new Set<string>();
    for (const sub of initialSubmissions) {
      if (sub.producer_email && sub.airing_date) {
        showKeys.add(`${sub.producer_email}|${sub.airing_date}`);
      }
    }

    // Fetch ALL submissions for these shows (not just the selected IDs)
    const allShowSubmissions: any[] = [];
    for (const key of showKeys) {
      const [producerEmail, airingDate] = key.split("|");
      const { data: showSubs, error: showError } = await adminSupabase
        .from("submissions")
        .select("id, producer_email, mixcloud, audio_filename, image_filename, airing_date, submitted_tags, ftp_status, drive_status, ftp_message")
        .eq("producer_email", producerEmail)
        .eq("airing_date", airingDate);

      if (showError) {
        console.error(`Error fetching submissions for ${producerEmail} on ${airingDate}:`, showError);
        continue;
      }

      if (showSubs && showSubs.length > 0) {
        allShowSubmissions.push(...showSubs);
      }
    }

    console.log("All submissions for selected shows:", allShowSubmissions);

    // Group submissions by producer_email + airing_date and aggregate
    const aggregatedShows = new Map<string, {
      producerEmail: string;
      airingDate: string;
      audioFilename: string | null;
      imageFilename: string | null;
      submittedTags: string[];
      hasDescription: boolean;
      mixcloudStatuses: string[];
      ftpStatus: string | null;
      driveStatus: string | null;
    }>();

    for (const sub of allShowSubmissions) {
      const key = `${sub.producer_email}|${sub.airing_date}`;
      const existing = aggregatedShows.get(key);
      const ftpMessage = typeof sub.ftp_message === "string" ? sub.ftp_message.toLowerCase() : "";
      const hasDescription = ftpMessage.includes("description uploaded") || ftpMessage.includes("description upload failed");

      if (existing) {
        // Aggregate: take first non-null audio/image, merge tags
        if (!existing.audioFilename && sub.audio_filename) {
          existing.audioFilename = sub.audio_filename;
        }
        if (!existing.imageFilename && sub.image_filename) {
          existing.imageFilename = sub.image_filename;
        }
        if (Array.isArray(sub.submitted_tags) && sub.submitted_tags.length > 0) {
          existing.submittedTags = [...new Set([...existing.submittedTags, ...sub.submitted_tags])];
        }
        if (hasDescription) {
          existing.hasDescription = true;
        }
        if (sub.mixcloud) {
          existing.mixcloudStatuses.push(sub.mixcloud);
        }
      } else {
        aggregatedShows.set(key, {
          producerEmail: sub.producer_email,
          airingDate: sub.airing_date,
          audioFilename: sub.audio_filename || null,
          imageFilename: sub.image_filename || null,
          submittedTags: Array.isArray(sub.submitted_tags) ? sub.submitted_tags : [],
          hasDescription,
          mixcloudStatuses: sub.mixcloud ? [sub.mixcloud] : [],
          ftpStatus: sub.ftp_status,
          driveStatus: sub.drive_status,
        });
      }
    }

    // Filter only ready shows (must have audio, image, and tags)
    const readyShows = Array.from(aggregatedShows.values()).filter((show) => {
      const hasAudio = Boolean(show.audioFilename);
      const hasImage = Boolean(show.imageFilename);
      const hasTags = show.submittedTags.length > 0;
      const notPublished = !show.mixcloudStatuses.includes("published");
      
      return hasAudio && hasImage && hasTags && notPublished;
    });

    console.log("Ready shows:", readyShows);
    
    if (readyShows.length === 0) {
      return NextResponse.json({ 
        error: "No ready shows to publish.",
        debug: { 
          receivedIds: submissionIds, 
          aggregatedShows: Array.from(aggregatedShows.values()),
          reason: "Shows must have audio, image, and tags, and not be already published"
        }
      }, { status: 400 });
    }

    // Mixcloud API publishing
    const results = [];
    for (const show of readyShows) {
      let audioBuffer: Buffer | undefined;
      let pictureBuffer: Buffer | undefined;
      
      try {
        // Use audio filename as the show title, removing extension and date suffix
        let name = "Show";
        if (show.audioFilename) {
          // Remove file extension
          let basename = show.audioFilename.replace(/\.[^.]+$/, '');
          // Remove date suffix pattern (-DDMMYY at the end)
          basename = basename.replace(/-\d{6}$/, '');
          name = basename;
        }
        
        const tags = show.submittedTags || [];

        // Get producer folder name from profiles
        const { data: profile } = await adminSupabase
          .from("profiles")
          .select("full_name")
          .eq("producer_email", show.producerEmail)
          .single();

        if (!profile?.full_name) {
          throw new Error(`Producer folder name not found for ${show.producerEmail}`);
        }

        const producerFolderName = profile.full_name.trim();
        console.log(`Processing: ${name} from ${producerFolderName}`);

        // Determine storage location and get files
        let audioUrl: string | undefined;
        let pictureUrl: string | undefined;

        // Check if files are in R2 (new workflow)
        const audioR2Key = show.audioFilename
          ? await resolveR2KeyWithFallback(show.audioFilename)
          : null;
        const imageR2Key = show.imageFilename
          ? await resolveR2KeyWithFallback(show.imageFilename)
          : null;
        const audioInR2 = Boolean(audioR2Key);
        const imageInR2 = Boolean(imageR2Key);

        console.log(`[${name}] Audio in R2: ${audioInR2}, Image in R2: ${imageInR2}`);
        console.log(`[${name}] FTP status: ${show.ftpStatus}, Drive status: ${show.driveStatus}`);

        // Audio: R2 (new) or FTP (legacy)
        if (audioInR2 && audioR2Key) {
          console.log(`[${name}] Getting signed URL for audio from R2`);
          audioUrl = await getSignedR2Url(audioR2Key);
        } else if (show.audioFilename) {
          console.log(`[${name}] Downloading audio from FTP...`);
          audioBuffer = (await downloadFromFtpWithFallback(show.audioFilename, producerFolderName)) || undefined;
          if (!audioBuffer) {
            throw new Error(`Failed to download audio file from FTP/R2: ${show.audioFilename}`);
          }
          console.log(`[${name}] Audio downloaded, size: ${audioBuffer.length} bytes`);
        } else {
          throw new Error("Missing audio file");
        }

        // Image: R2 (new), Drive (legacy upcoming), or FTP (legacy past)
        if (imageInR2 && imageR2Key) {
          console.log(`[${name}] Getting signed URL for image from R2`);
          pictureUrl = await getSignedR2Url(imageR2Key);
        } else if (show.imageFilename) {
          // Try Google Drive first (for upcoming shows), then FTP
          if (show.driveStatus === "success" && show.airingDate) {
            console.log(`[${name}] Downloading image from Drive...`);
            pictureBuffer = await downloadFromDrive(show.imageFilename, show.airingDate) || undefined;
          }
          
          // Fall back to FTP if not in Drive
          if (!pictureBuffer) {
            console.log(`[${name}] Downloading image from FTP...`);
            pictureBuffer = (await downloadFromFtpWithFallback(show.imageFilename, producerFolderName)) || undefined;
          }
          if (pictureBuffer) {
            console.log(`[${name}] Image downloaded, size: ${pictureBuffer.length} bytes`);
          }
          // Picture is optional, so don't throw if missing
        }

        console.log(`[${name}] Uploading to Mixcloud...`);
        const mixcloudRes = await uploadToMixcloud({
          audioUrl,
          audioBuffer,
          name,
          tags,
          pictureUrl,
          pictureBuffer,
        });
        console.log(`[${name}] Mixcloud upload successful, ID: ${mixcloudRes.key}`);

        // Mark ALL submissions for this show as published
        const { error: updateError } = await adminSupabase
          .from("submissions")
          .update({ mixcloud: "published" })
          .eq("producer_email", show.producerEmail)
          .eq("airing_date", show.airingDate);
        
        if (updateError) {
          console.warn(`[${name}] Failed to update submissions to published:`, updateError);
        } else {
          console.log(`[${name}] All submissions for this show updated to published`);
        }

        // Delete files from R2 after successful upload (only if they were in R2)
        if (audioInR2 && audioR2Key) {
          try {
            await deleteFromR2(audioR2Key);
            console.log(`[${name}] Deleted audio from R2: ${audioR2Key}`);
          } catch (err) {
            console.warn(`[${name}] Failed to delete audio from R2:`, err);
          }
        }
        
        if (imageInR2 && imageR2Key) {
          try {
            await deleteFromR2(imageR2Key);
            console.log(`[${name}] Deleted image from R2: ${imageR2Key}`);
          } catch (err) {
            console.warn(`[${name}] Failed to delete image from R2:`, err);
          }
        }

        results.push({ 
          producer: show.producerEmail, 
          airingDate: show.airingDate,
          status: "published", 
          mixcloud: mixcloudRes 
        });
      } catch (err: any) {
        console.error(`Error processing show for ${show.producerEmail} on ${show.airingDate}:`, err);
        results.push({ 
          producer: show.producerEmail, 
          airingDate: show.airingDate,
          status: "error", 
          error: err.message 
        });
      } finally {
        // Explicitly free memory
        audioBuffer = undefined;
        pictureBuffer = undefined;
      }
    }
    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error("Unexpected error in bulk publish:", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
