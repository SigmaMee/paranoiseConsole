import { Client } from "basic-ftp";
import { randomUUID } from "crypto";
import { google } from "googleapis";
import { Readable } from "stream";
import { createClient } from "@supabase/supabase-js";
import { getGoogleDriveOAuthClientFromStoredToken } from "@/lib/google-drive-oauth";

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

export type RouteResult = {
  success: boolean;
  destination: "ftp" | "google-drive";
  message: string;
};

export type PersistPayload = {
  producerEmail: string;
  title: string;
  audioFilename: string;
  imageFilename: string;
  ftpStatus: "success" | "failed";
  driveStatus: "success" | "failed";
  ftpMessage: string;
  driveMessage: string;
};

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildUploadName(prefix: string, originalName: string) {
  const safeOriginal = sanitizeFilename(originalName);
  return `${prefix}-${randomUUID()}-${safeOriginal}`;
}

export function validateSubmission(
  title: string,
  audio: File,
  image: File | null,
): string | null {
  if (!title.trim()) {
    return "Show title is required.";
  }

  const isMp3 =
    audio.type === "audio/mpeg" || audio.name.toLowerCase().endsWith(".mp3");
  if (!isMp3) {
    return "Audio must be an MP3 file.";
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    return "Audio exceeds 200 MB maximum size.";
  }

  if (image && !image.type.startsWith("image/")) {
    return "Cover must be a standard image file type.";
  }

  return null;
}

export async function routeAudioToFtp(
  audio: File,
  producerFolderName: string,
): Promise<RouteResult> {
  const host = getRequiredEnv("FTP_HOST");
  const user = getRequiredEnv("FTP_USER");
  const password = getRequiredEnv("FTP_PASSWORD");
  const secure = process.env.FTP_SECURE === "true";
  const producerRootDir = process.env.FTP_PRODUCER_ROOT_DIR || "/";

  if (!producerFolderName.trim()) {
    return {
      success: false,
      destination: "ftp",
      message: "Producer folder name is missing.",
    };
  }

  if (producerFolderName.includes("/") || producerFolderName.includes("..")) {
    return {
      success: false,
      destination: "ftp",
      message: "Producer folder name contains invalid path characters.",
    };
  }

  const targetDir = `${producerRootDir.replace(/\/$/, "")}/${producerFolderName.trim()}`;

  const client = new Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host, user, password, secure });
    await client.cd(targetDir);

    const uploadName = sanitizeFilename(audio.name);
    const bytes = Buffer.from(await audio.arrayBuffer());
    await client.uploadFrom(Readable.from(bytes), uploadName);

    return {
      success: true,
      destination: "ftp",
      message: `Audio uploaded to FTP folder ${targetDir} as ${uploadName}`,
    };
  } catch (error) {
    return {
      success: false,
      destination: "ftp",
      message:
        error instanceof Error
          ? `FTP upload failed for folder ${targetDir}: ${error.message}`
          : `FTP upload failed for folder ${targetDir}`,
    };
  } finally {
    client.close();
  }
}

async function getDriveAuth() {
  const oauthClient = await getGoogleDriveOAuthClientFromStoredToken();
  if (oauthClient) {
    return oauthClient;
  }

  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );

  return new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

function getWeekdayFolderName(showStart: string) {
  const parsed = new Date(showStart);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const map = [
    "07 Sunday",
    "01 Monday",
    "02 Tuesday",
    "03 Wednesday",
    "04 Thursday",
    "05 Friday",
    "06 Saturday",
  ];

  return map[parsed.getDay()] || null;
}

function normalizeWeekdayFolderName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function getDriveWeekdayFolderIdForShowStart(showStart: string) {
  const parentFolderId = getRequiredEnv("GOOGLE_DRIVE_FOLDER_ID");
  const expectedFolderName = getWeekdayFolderName(showStart);

  if (!expectedFolderName) {
    throw new Error("Could not determine show weekday from calendar start time.");
  }

  const auth = await getDriveAuth();
  const drive = google.drive({ version: "v3", auth });

  const foldersResponse = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const folders = foldersResponse.data.files ?? [];
  const normalizedExpected = normalizeWeekdayFolderName(expectedFolderName);
  const match = folders.find(
    (folder) =>
      typeof folder.name === "string" &&
      normalizeWeekdayFolderName(folder.name) === normalizedExpected,
  );

  if (!match?.id) {
    throw new Error(
      `Could not find Google Drive weekday folder '${expectedFolderName}' under the configured parent folder.`,
    );
  }

  return match.id;
}

export async function routeImageToDrive(
  image: File,
  destinationFolderId?: string,
): Promise<RouteResult> {
  const folderId = destinationFolderId || getRequiredEnv("GOOGLE_DRIVE_FOLDER_ID");

  try {
    const auth = await getDriveAuth();
    const drive = google.drive({ version: "v3", auth });
    const uploadName = buildUploadName("cover", image.name);
    const bytes = Buffer.from(await image.arrayBuffer());

    await drive.files.create({
      requestBody: {
        name: uploadName,
        parents: [folderId],
      },
      media: {
        mimeType: image.type || "application/octet-stream",
        body: Readable.from(bytes),
      },
      fields: "id,name",
      supportsAllDrives: true,
    });

    return {
      success: true,
      destination: "google-drive",
      message: `Cover uploaded to Google Drive as ${uploadName}`,
    };
  } catch (error) {
    return {
      success: false,
      destination: "google-drive",
      message: error instanceof Error ? error.message : "Google Drive upload failed",
    };
  }
}

function createAdminSupabaseClient() {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRoleKey);
}

export async function persistSubmissionStatus(payload: PersistPayload) {
  const supabase = createAdminSupabaseClient();

  const { error } = await supabase.from("submissions").insert({
    producer_email: payload.producerEmail,
    title: payload.title,
    audio_filename: payload.audioFilename,
    image_filename: payload.imageFilename,
    ftp_status: payload.ftpStatus,
    drive_status: payload.driveStatus,
    ftp_message: payload.ftpMessage,
    drive_message: payload.driveMessage,
  });

  if (error) {
    throw new Error(error.message);
  }
}
