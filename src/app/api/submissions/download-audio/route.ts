import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "basic-ftp";
import { PassThrough, Writable } from "stream";
import * as archiver from "archiver";

export const runtime = "nodejs";
export const maxDuration = 300;

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Format date as DDMMYY
 */
function formatDateDDMMYY(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

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

async function downloadFromR2(objectKey: string): Promise<Buffer | null> {
  try {
    const client = getR2Client();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: objectKey,
      }),
    );

    if (!response.Body) {
      return null;
    }

    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

/**
 * Download file from FTP as Buffer
 */
async function downloadFromFtp(filename: string, producerFolderName: string): Promise<Buffer | null> {
  const client = new Client();
  client.ftp.verbose = true;

  try {
    const host = getRequiredEnv("FTP_HOST");
    const user = getRequiredEnv("FTP_USER");
    const password = getRequiredEnv("FTP_PASSWORD");
    const producerRootDir = getRequiredEnv("FTP_PRODUCER_ROOT_DIR");
    const secure = process.env.FTP_SECURE === "true";

    console.log(`FTP: Downloading ${filename} from ${producerFolderName}`);
    
    await client.access({ host, user, password, secure });
    await client.cd(producerRootDir);
    await client.cd(producerFolderName.trim());

    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await client.downloadTo(writable, filename);
    const buffer = Buffer.concat(chunks);
    console.log(`FTP: Downloaded ${filename}, size: ${buffer.length} bytes`);
    return buffer;
  } catch (err) {
    console.error(`FTP Error downloading ${filename}:`, err);
    return null;
  } finally {
    client.close();
  }
}

async function downloadFromFtpWithFallback(filename: string, producerFolderName: string): Promise<Buffer | null> {
  const direct = await downloadFromFtp(filename, producerFolderName);
  if (direct) {
    return direct;
  }

  const sanitized = sanitizeFilename(filename);
  if (sanitized !== filename) {
    return downloadFromFtp(sanitized, producerFolderName);
  }

  return null;
}

async function downloadFileBuffer(filename: string, producerFolderName: string): Promise<Buffer | null> {
  const fromFtp = await downloadFromFtpWithFallback(filename, producerFolderName);
  if (fromFtp) {
    return fromFtp;
  }

  const fromR2Direct = await downloadFromR2(filename);
  if (fromR2Direct) {
    console.log(`R2: Downloaded ${filename}`);
    return fromR2Direct;
  }

  const sanitized = sanitizeFilename(filename);
  if (sanitized !== filename) {
    const fromR2Sanitized = await downloadFromR2(sanitized);
    if (fromR2Sanitized) {
      console.log(`R2: Downloaded ${sanitized} (fallback for ${filename})`);
      return fromR2Sanitized;
    }
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const { submissionIds } = await request.json();
    console.log("Received submissionIds for download:", submissionIds);
    
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

    // Fetch ALL submissions for these shows
    const allShowSubmissions: any[] = [];
    for (const key of showKeys) {
      const [producerEmail, airingDate] = key.split("|");
      const { data: showSubs, error: showError } = await adminSupabase
        .from("submissions")
        .select(
          "producer_email,airing_date,audio_filename,image_filename,submitted_description,submitted_tags,ftp_message",
        )
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

    // Group by show and aggregate all required assets
    const showsWithAudio = new Map<string, {
      producerEmail: string;
      airingDate: string;
      audioFilename: string | null;
      imageFilename: string | null;
      submittedDescription: string | null;
      submittedTags: string[];
      hasDescription: boolean;
    }>();

    for (const sub of allShowSubmissions) {
      const key = `${sub.producer_email}|${sub.airing_date}`;
      const ftpMessage = typeof sub.ftp_message === "string" ? sub.ftp_message.toLowerCase() : "";
      const rowHasDescription =
        (typeof sub.submitted_description === "string" && sub.submitted_description.trim().length > 0) ||
        ftpMessage.includes("description uploaded") ||
        ftpMessage.includes("description upload failed");

      if (!showsWithAudio.has(key)) {
        showsWithAudio.set(key, {
          producerEmail: sub.producer_email,
          airingDate: sub.airing_date,
          audioFilename: sub.audio_filename || null,
          imageFilename: sub.image_filename || null,
          submittedDescription:
            typeof sub.submitted_description === "string" && sub.submitted_description.trim()
              ? sub.submitted_description.trim()
              : null,
          submittedTags: Array.isArray(sub.submitted_tags) ? sub.submitted_tags : [],
          hasDescription: rowHasDescription,
        });
        continue;
      }

      const existing = showsWithAudio.get(key)!;
      if (!existing.audioFilename && sub.audio_filename) {
        existing.audioFilename = sub.audio_filename;
      }
      if (!existing.imageFilename && sub.image_filename) {
        existing.imageFilename = sub.image_filename;
      }
      if (!existing.submittedDescription && typeof sub.submitted_description === "string" && sub.submitted_description.trim()) {
        existing.submittedDescription = sub.submitted_description.trim();
      }
      if (Array.isArray(sub.submitted_tags) && sub.submitted_tags.length > 0) {
        existing.submittedTags = [...new Set([...existing.submittedTags, ...sub.submitted_tags])];
      }
      if (rowHasDescription) {
        existing.hasDescription = true;
      }
    }

    const eligibleShows = Array.from(showsWithAudio.values()).filter(
      (show) => Boolean(show.audioFilename),
    );

    if (eligibleShows.length === 0) {
      return NextResponse.json({ error: "No shows with audio found for download." }, { status: 400 });
    }

    console.log(`Found ${eligibleShows.length} audio-eligible shows to download`);

    // Create ZIP archive and collect output bytes via stream
    const archive = archiver.default("zip", { zlib: { level: 0 } }); // No compression for faster processing
    const zipStream = new PassThrough();
    const chunks: Buffer[] = [];
    archive.pipe(zipStream);
    zipStream.on("data", (chunk: Buffer) => chunks.push(chunk));

    const archiveDone = new Promise<void>((resolve, reject) => {
      zipStream.on("end", () => resolve());
      zipStream.on("error", (err) => reject(err));
      archive.on("warning", (err) => {
        console.warn("Archive warning:", err);
      });
      archive.on("error", (err) => reject(err));
    });

    // Download each show package (audio + cover + metadata) and add to archive
    let appendedCount = 0;
    for (const show of eligibleShows) {
      try {
        // Get producer folder name
        const { data: profile } = await adminSupabase
          .from("profiles")
          .select("full_name")
          .eq("producer_email", show.producerEmail)
          .single();

        if (!profile?.full_name) {
          console.warn(`Skipping ${show.producerEmail}: no producer folder name found`);
          continue;
        }

        const producerFolderName = profile.full_name.trim();
        const producerName = profile.full_name.trim();
        const showDateFormatted = formatDateDDMMYY(show.airingDate);
        const showFolder = `${showDateFormatted} - ${producerName}`;

        if (show.audioFilename) {
          const audioBuffer = await downloadFileBuffer(show.audioFilename, producerFolderName);
          if (audioBuffer) {
            archive.append(audioBuffer, { name: `${showFolder}/${show.audioFilename}` });
            appendedCount += 1;
            console.log(`Added audio ${show.audioFilename} to archive`);
          } else {
            console.warn(`Failed to download audio ${show.audioFilename} from FTP or R2`);
          }
        }

        if (show.imageFilename) {
          const imageBuffer = await downloadFileBuffer(show.imageFilename, producerFolderName);
          if (imageBuffer) {
            archive.append(imageBuffer, { name: `${showFolder}/${show.imageFilename}` });
            appendedCount += 1;
            console.log(`Added image ${show.imageFilename} to archive`);
          } else {
            console.warn(`Failed to download image ${show.imageFilename} from FTP or R2`);
          }
        }

        const metadata = [
          `Producer: ${show.producerEmail}`,
          `Airing Date: ${show.airingDate}`,
          `Tags: ${show.submittedTags.join(", ")}`,
          "",
          "Description:",
          show.submittedDescription || "(No description text stored in database)",
        ].join("\n");

        archive.append(Buffer.from(metadata, "utf8"), { name: `${showFolder}/show-metadata.txt` });
        appendedCount += 1;
      } catch (err) {
        console.error(`Error processing ${show.producerEmail} ${show.airingDate}:`, err);
      }
    }

    if (appendedCount === 0) {
      return NextResponse.json(
        { error: "No show files could be downloaded from FTP or R2 for the selected shows." },
        { status: 400 },
      );
    }

    await archive.finalize();
    await archiveDone;
    const zipBuffer = Buffer.concat(chunks);

    console.log(`ZIP created, size: ${zipBuffer.length} bytes`);

    // Return ZIP file
    const downloadDate = formatDateDDMMYY(new Date());
    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="paranoise-shows-${downloadDate}.zip"`,
        "Content-Length": zipBuffer.length.toString(),
      },
    });
  } catch (err) {
    console.error("Error in bulk download:", err);
    return NextResponse.json({ error: "Failed to download show files." }, { status: 500 });
  }
}
