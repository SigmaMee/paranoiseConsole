import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { uploadToMixcloud } from "@/lib/mixcloud-api";
import { getSignedR2Url, fileExistsInR2 } from "@/lib/r2-utils";
import { getDriveWeekdayFolderIdForShowStart } from "@/lib/submission-routing";
import { getGoogleDriveOAuthClientFromStoredToken } from "@/lib/google-drive-oauth";
import { google } from "googleapis";
import { Client } from "basic-ftp";
import { Writable } from "stream";
import { requireAdminUser } from "@/lib/admin-access";
import { downloadAudioFromFtp } from "@/lib/ftp-media";
import { formatInTimeZone } from "date-fns-tz";

export const runtime = "nodejs";
export const maxDuration = 300;

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isMissingMixcloudErrorColumn(error: { code?: string; message?: string } | null) {
  return Boolean(error && (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    error.message?.includes("mixcloud_error")
  ));
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

    const authorization = await requireAdminUser();
    if (authorization.response) return authorization.response;

    const adminSupabase = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    
    // Fetch the initial submissions to get producer_email + airing_date combinations
    const { data: initialSubmissions, error: initialError } = await adminSupabase
      .from("submissions")
      .select("id, producer_email, airing_date")
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
    type MixcloudSubmission = {
      id: string;
      producer_email: string;
      mixcloud: string | null;
      audio_filename: string | null;
      image_filename: string | null;
      image_object_key: string | null;
      airing_date: string;
      submitted_tags: string[] | null;
      ftp_status: string | null;
      drive_status: string | null;
      ftp_message: string | null;
    };
    const allShowSubmissions: MixcloudSubmission[] = [];
    for (const key of showKeys) {
      const [producerEmail, airingDate] = key.split("|");
      const { data: showSubs, error: showError } = await adminSupabase
        .from("submissions")
        .select("id, producer_email, mixcloud, audio_filename, image_filename, image_object_key, airing_date, submitted_tags, ftp_status, drive_status, ftp_message")
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
      submissionId: string;
      airingDate: string;
      audioFilename: string | null;
      imageFilename: string | null;
      imageObjectKey: string | null;
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
        if (!existing.imageObjectKey && sub.image_object_key) {
          existing.imageObjectKey = sub.image_object_key;
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
          submissionId: initialSubmissions.find((selected) => selected.producer_email === sub.producer_email && selected.airing_date === sub.airing_date)?.id || sub.id,
          airingDate: sub.airing_date,
          audioFilename: sub.audio_filename || null,
          imageFilename: sub.image_filename || null,
          imageObjectKey: sub.image_object_key || null,
          submittedTags: Array.isArray(sub.submitted_tags) ? sub.submitted_tags : [],
          hasDescription,
          mixcloudStatuses: sub.mixcloud ? [sub.mixcloud] : [],
          ftpStatus: sub.ftp_status,
          driveStatus: sub.drive_status,
        });
      }
    }

    // Filter only ready shows (audio required)
    const readyShows = Array.from(aggregatedShows.values()).filter((show) => {
      const hasAudio = Boolean(show.audioFilename);
      const notPublished = !show.mixcloudStatuses.includes("published");
      const isEligibleDay = show.airingDate < formatInTimeZone(new Date(), "Europe/Brussels", "yyyy-MM-dd");
      return hasAudio && notPublished && isEligibleDay;
    });

    console.log("Ready shows:", readyShows);
    
    if (readyShows.length === 0) {
      return NextResponse.json({ 
        error: "No ready shows to publish.",
        debug: { 
          receivedIds: submissionIds, 
          aggregatedShows: Array.from(aggregatedShows.values()),
          reason: "Shows must have audio and not be already published"
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

        // Images may still use retained R2 storage. Audio is always verified and read from FTP.
        const imageR2Key = show.imageObjectKey || (show.imageFilename
          ? await resolveR2KeyWithFallback(show.imageFilename)
          : null);
        const imageInR2 = Boolean(imageR2Key);

        console.log(`[${name}] Image in R2: ${imageInR2}`);
        console.log(`[${name}] FTP status: ${show.ftpStatus}, Drive status: ${show.driveStatus}`);

        if (show.audioFilename) {
          console.log(`[${name}] Downloading audio from FTP...`);
          audioBuffer = (await downloadAudioFromFtp(show.audioFilename, producerFolderName)) || undefined;
          if (!audioBuffer) {
            throw new Error(`Audio file is not available on FTP: ${show.audioFilename}`);
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
        let { error: publishingStateError } = await adminSupabase
          .from("submissions")
          .update({ mixcloud: "publishing", mixcloud_error: null })
          .eq("producer_email", show.producerEmail)
          .eq("airing_date", show.airingDate);
        if (isMissingMixcloudErrorColumn(publishingStateError)) {
          ({ error: publishingStateError } = await adminSupabase
            .from("submissions")
            .update({ mixcloud: "publishing" })
            .eq("producer_email", show.producerEmail)
            .eq("airing_date", show.airingDate));
        }
        if (publishingStateError) throw publishingStateError;
        const mixcloudRes = await uploadToMixcloud({
          audioUrl,
          audioBuffer,
          name,
          tags,
          pictureUrl,
          pictureBuffer,
        });
        console.log(`[${name}] Mixcloud upload successful, ID: ${mixcloudRes.key}`);

        const mixcloudUrl = new URL(mixcloudRes.key, "https://www.mixcloud.com").toString();

        // Mark ALL submissions for this show as published
        let { error: updateError } = await adminSupabase
          .from("submissions")
          .update({
            mixcloud: "published",
            mixcloud_key: mixcloudRes.key,
            mixcloud_url: mixcloudUrl,
            mixcloud_error: null,
            webflow_status: "ready",
            webflow_error: null,
          })
          .eq("producer_email", show.producerEmail)
          .eq("airing_date", show.airingDate);
        if (isMissingMixcloudErrorColumn(updateError)) {
          ({ error: updateError } = await adminSupabase
            .from("submissions")
            .update({
              mixcloud: "published",
              mixcloud_key: mixcloudRes.key,
              mixcloud_url: mixcloudUrl,
              webflow_status: "ready",
              webflow_error: null,
            })
            .eq("producer_email", show.producerEmail)
            .eq("airing_date", show.airingDate));
        }
        
        if (updateError) throw new Error(`Mixcloud upload succeeded but its URL could not be saved: ${updateError.message}`);
        console.log(`[${name}] All submissions for this show updated to published`);

        // Keep the cover in R2 until the Webflow CMS publication succeeds.

        results.push({ 
          submissionId: show.submissionId,
          producer: show.producerEmail, 
          airingDate: show.airingDate,
          status: "published", 
          mixcloudUrl,
          mixcloud: mixcloudRes 
        });
      } catch (err) {
        console.error(`Error processing show for ${show.producerEmail} on ${show.airingDate}:`, err);
        const message = err instanceof Error ? err.message : "Unknown publishing error";
        const failedUpdate = adminSupabase
          .from("submissions")
          .update({ mixcloud: "failed", mixcloud_error: message })
          .eq("producer_email", show.producerEmail)
          .eq("airing_date", show.airingDate);
        const { error: failedUpdateError } = await failedUpdate;
        if (isMissingMixcloudErrorColumn(failedUpdateError)) {
          await adminSupabase
            .from("submissions")
            .update({ mixcloud: "failed" })
            .eq("producer_email", show.producerEmail)
            .eq("airing_date", show.airingDate);
        }
        results.push({ 
          submissionId: show.submissionId,
          producer: show.producerEmail, 
          airingDate: show.airingDate,
          status: "error", 
          error: message,
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
