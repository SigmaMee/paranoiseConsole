import { Client } from "basic-ftp";
import { randomUUID } from "crypto";
import { google } from "googleapis";
import { Readable } from "stream";
import { createClient } from "@supabase/supabase-js";
import { getGoogleDriveOAuthClientFromStoredToken } from "@/lib/google-drive-oauth";

const MAX_AUDIO_BYTES = 900 * 1024 * 1024;

export type RouteResult = {
  success: boolean;
  destination: "ftp" | "google-drive";
  message: string;
};

export type PersistPayload = {
  producerProfileId?: string | null;
  producerEmail: string;
  audioFilename: string;
  imageFilename: string;
  showStartAt?: string | null;
  airingDate?: string | null;
  submittedDescription?: string | null;
  submittedTags?: string[];
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

function getOptionalEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" ? value : null;
}

export function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeDescriptionToFilenameBase(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function uploadBytesToFtpProducerFolder(
  bytes: Buffer,
  uploadName: string,
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
    await client.uploadFrom(Readable.from(bytes), uploadName);

    return {
      success: true,
      destination: "ftp",
      message: `File uploaded to FTP folder ${targetDir} as ${uploadName}`,
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

export function validateSubmission(
  audio: File | null,
  image: File | null,
  description: string,
  tags: string[],
  uploadType: "audio" | "cover" | "description" | "all",
): string | null {
  const hasTextPayload = Boolean(description.trim()) || tags.length > 0;

  if (uploadType === "all") {
    if (audio) {
      const isMp3 =
        audio.type === "audio/mpeg" || audio.name.toLowerCase().endsWith(".mp3");
      if (!isMp3) {
        return "Audio must be an MP3 file.";
      }

      if (audio.size > MAX_AUDIO_BYTES) {
        return "Audio exceeds 900 MB maximum size.";
      }
    }

    if (image && !image.type.startsWith("image/")) {
      return "Cover must be a standard image file type.";
    }

    return null;
  }

  if (uploadType === "audio") {
    if (!audio) {
      return "Audio file is required.";
    }

    const isMp3 =
      audio.type === "audio/mpeg" || audio.name.toLowerCase().endsWith(".mp3");
    if (!isMp3) {
      return "Audio must be an MP3 file.";
    }

    if (audio.size > MAX_AUDIO_BYTES) {
      return "Audio exceeds 900 MB maximum size.";
    }

    if (!hasTextPayload) {
      return "Show description or tags are required.";
    }
  }

  if (uploadType === "description" && !hasTextPayload) {
    return "Show description or tags are required.";
  }

  if (uploadType === "cover" && !image) {
    return "Cover image is required.";
  }

  if (image && !image.type.startsWith("image/")) {
    return "Cover must be a standard image file type.";
  }

  return null;
}

export async function routeAudioToFtp(
  audio: File,
  producerFolderName: string,
  uploadNameOverride?: string,
): Promise<RouteResult> {
  const uploadName = uploadNameOverride || audio.name;
  const bytes = Buffer.from(await audio.arrayBuffer());
  const result = await uploadBytesToFtpProducerFolder(bytes, uploadName, producerFolderName);

  return {
    ...result,
    message: result.success
      ? `Audio uploaded to FTP as ${uploadName}`
      : `Audio upload failed: ${result.message}`,
  };
}

export async function routeDescriptionToFtp(
  description: string,
  producerFolderName: string,
  baseNameHint?: string,
): Promise<RouteResult> {
  const hintBase = sanitizeDescriptionToFilenameBase(baseNameHint || "show-description");
  const fallbackBase = `show-description-${randomUUID().slice(0, 8)}`;
  const filenameBase = hintBase || fallbackBase;
  const uploadName = `${filenameBase}.txt`;
  const bytes = Buffer.from(description, "utf8");

  const result = await uploadBytesToFtpProducerFolder(bytes, uploadName, producerFolderName);
  return {
    ...result,
    message: result.success
      ? `Description uploaded to FTP as ${uploadName}`
      : `Description upload failed: ${result.message}`,
  };
}

export async function routeCoverToFtp(
  image: File,
  producerFolderName: string,
  uploadName: string,
): Promise<RouteResult> {
  const safeName = sanitizeFilename(uploadName || image.name || `cover-${randomUUID()}`);
  const bytes = Buffer.from(await image.arrayBuffer());

  const result = await uploadBytesToFtpProducerFolder(bytes, safeName, producerFolderName);
  return {
    ...result,
    message: result.success
      ? `Cover uploaded to FTP as ${safeName}`
      : `Cover upload failed: ${result.message}`,
  };
}

type DriveAuthSelection = {
  auth: InstanceType<typeof google.auth.JWT> | InstanceType<typeof google.auth.OAuth2>;
  source: "oauth" | "service-account";
  oauthInvalidGrant: boolean;
};

async function getDriveAuth(): Promise<DriveAuthSelection> {
  const oauthClient = await getGoogleDriveOAuthClientFromStoredToken();
  if (oauthClient) {
    try {
      await oauthClient.getAccessToken();
      return { auth: oauthClient, source: "oauth", oauthInvalidGrant: false };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("invalid_grant")) {
        throw error;
      }

      const allowServiceAccountFallback =
        process.env.GOOGLE_DRIVE_ALLOW_SERVICE_ACCOUNT_FALLBACK === "true";
      if (!allowServiceAccountFallback) {
        throw new Error(
          "Stored Google Drive OAuth refresh token is invalid. Reconnect Google Drive in this same environment, or set GOOGLE_DRIVE_ALLOW_SERVICE_ACCOUNT_FALLBACK=true to allow service-account fallback.",
        );
      }
    }
  }

  const serviceAccountEmail = getOptionalEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyRaw = getOptionalEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  if (!serviceAccountEmail || !privateKeyRaw) {
    throw new Error(
      "Google Drive auth is not configured. Connect Google Drive in Dashboard or provide service account credentials.",
    );
  }

  const serviceAccountAuth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKeyRaw.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return {
    auth: serviceAccountAuth,
    source: "service-account",
    oauthInvalidGrant: Boolean(oauthClient),
  };
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

  const authSelection = await getDriveAuth();
  const drive = google.drive({ version: "v3", auth: authSelection.auth });

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
  filenamePrefix?: string,
  uploadNameOverride?: string,
): Promise<RouteResult> {
  const folderId = destinationFolderId || getRequiredEnv("GOOGLE_DRIVE_FOLDER_ID");

  try {
    const authSelection = await getDriveAuth();
    const drive = google.drive({ version: "v3", auth: authSelection.auth });
    const originalName = image.name || `cover-${randomUUID()}`;
    const uploadName = uploadNameOverride
      ? uploadNameOverride
      : filenamePrefix
        ? `${filenamePrefix}-${originalName}`
        : originalName;
    const bytes = Buffer.from(await image.arrayBuffer());

    if (authSelection.source === "service-account") {
      const folderResponse = await drive.files.get({
        fileId: folderId,
        fields: "id,driveId",
        supportsAllDrives: true,
      });

      if (!folderResponse.data.driveId) {
        const oauthReason = authSelection.oauthInvalidGrant
          ? "Stored OAuth token is invalid or expired. Reconnect Google Drive from Dashboard."
          : "No Google Drive OAuth token is connected.";

        return {
          success: false,
          destination: "google-drive",
          message: `Google Drive upload failed: service accounts can only upload reliably to Shared Drives. ${oauthReason}`,
        };
      }
    }

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
    const message = error instanceof Error ? error.message : "Google Drive upload failed";
    if (message.toLowerCase().includes("service accounts do not have storage quota")) {
      return {
        success: false,
        destination: "google-drive",
        message:
          "Google Drive upload failed: target folder appears to be in My Drive while using a service account. Use a Shared Drive folder for GOOGLE_DRIVE_FOLDER_ID (and weekday folders) or reconnect Google Drive OAuth.",
      };
    }

    return {
      success: false,
      destination: "google-drive",
      message,
    };
  }
}

export async function routeTextToDrive(
  content: string,
  uploadName: string,
  destinationFolderId?: string,
): Promise<RouteResult> {
  const folderId = destinationFolderId || getRequiredEnv("GOOGLE_DRIVE_FOLDER_ID");

  try {
    const authSelection = await getDriveAuth();
    const drive = google.drive({ version: "v3", auth: authSelection.auth });
    const bytes = Buffer.from(content, "utf8");

    if (authSelection.source === "service-account") {
      const folderResponse = await drive.files.get({
        fileId: folderId,
        fields: "id,driveId",
        supportsAllDrives: true,
      });

      if (!folderResponse.data.driveId) {
        const oauthReason = authSelection.oauthInvalidGrant
          ? "Stored OAuth token is invalid or expired. Reconnect Google Drive from Dashboard."
          : "No Google Drive OAuth token is connected.";

        return {
          success: false,
          destination: "google-drive",
          message: `Google Drive upload failed: service accounts can only upload reliably to Shared Drives. ${oauthReason}`,
        };
      }
    }

    await drive.files.create({
      requestBody: {
        name: uploadName,
        parents: [folderId],
      },
      media: {
        mimeType: "text/plain",
        body: Readable.from(bytes),
      },
      fields: "id,name",
      supportsAllDrives: true,
    });

    return {
      success: true,
      destination: "google-drive",
      message: `Description uploaded to Google Drive as ${uploadName}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Drive upload failed";
    if (message.toLowerCase().includes("service accounts do not have storage quota")) {
      return {
        success: false,
        destination: "google-drive",
        message:
          "Google Drive upload failed: target folder appears to be in My Drive while using a service account. Use a Shared Drive folder for GOOGLE_DRIVE_FOLDER_ID (and weekday folders) or reconnect Google Drive OAuth.",
      };
    }

    return {
      success: false,
      destination: "google-drive",
      message,
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

  // Determine Mixcloud readiness
  let mixcloudStatus = "not ready";
  const hasAudio = !!payload.audioFilename;
  const hasImage = !!payload.imageFilename;
  const hasTags = Array.isArray(payload.submittedTags) && payload.submittedTags.length > 0;
  const isContentReady = hasAudio && hasImage && hasTags && payload.ftpStatus === "success" && payload.driveStatus === "success";
  let isAiringPast = false;
  if (payload.airingDate) {
    const now = new Date();
    const airing = new Date(payload.airingDate);
    isAiringPast = now >= airing;
  }
  if (isContentReady && isAiringPast) {
    mixcloudStatus = "ready";
  }
  // You can set to "published" after Mixcloud upload elsewhere
  const baseInsert = {
    producer_profile_id: payload.producerProfileId || null,
    producer_email: payload.producerEmail,
    audio_filename: payload.audioFilename,
    image_filename: payload.imageFilename,
    show_start_at: payload.showStartAt || null,
    airing_date: payload.airingDate || null,
    submitted_description:
      typeof payload.submittedDescription === "string" && payload.submittedDescription.trim()
        ? payload.submittedDescription.trim()
        : null,
    submitted_tags:
      Array.isArray(payload.submittedTags) && payload.submittedTags.length > 0
        ? payload.submittedTags
        : null,
    ftp_status: payload.ftpStatus,
    drive_status: payload.driveStatus,
    ftp_message: payload.ftpMessage,
    drive_message: payload.driveMessage,
    mixcloud: mixcloudStatus,
  };

  const { error } = await supabase.from("submissions").insert(baseInsert);

  const missingAiringColumns =
    error?.message?.toLowerCase().includes('column "producer_profile_id"') ||
    error?.message?.toLowerCase().includes('column "show_start_at"') ||
    error?.message?.toLowerCase().includes('column "airing_date"') ||
    error?.message?.toLowerCase().includes('column "submitted_tags"') ||
    error?.message?.toLowerCase().includes('column "submitted_description"');

  if (missingAiringColumns) {
    const {
      producer_profile_id: _producerProfileId,
      show_start_at: _showStartAt,
      airing_date: _airingDate,
      submitted_description: _submittedDescription,
      ...legacyInsert
    } = baseInsert;
    const { error: legacyColumnsError } = await supabase.from("submissions").insert(legacyInsert);

    if (!legacyColumnsError) {
      return;
    }

    throw new Error(legacyColumnsError.message);
  }

  const requiresLegacyTitle =
    error?.message?.toLowerCase().includes('null value in column "title"') ?? false;

  if (requiresLegacyTitle) {
    const { error: legacyError } = await supabase.from("submissions").insert({
      ...baseInsert,
      title: payload.audioFilename,
    });

    if (!legacyError) {
      return;
    }

    throw new Error(legacyError.message);
  }

  if (error) {
    throw new Error(error.message);
  }
}
