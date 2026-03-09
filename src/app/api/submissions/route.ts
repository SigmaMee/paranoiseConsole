import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getDriveWeekdayFolderIdForShowStart,
  persistSubmissionStatus,
  routeAudioToFtp,
  routeCoverToFtp,
  routeDescriptionToFtp,
  routeImageToDrive,
  validateSubmission,
  sanitizeFilename,
} from "@/lib/submission-routing";
import {
  getUpcomingShowsByProducerEmail,
  getNextUpcomingShowStartByProducerEmail,
} from "@/lib/google-calendar";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "stream";
import { getReferenceNow } from "@/lib/reference-time";

export const runtime = "nodejs";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// R2 client (server-side download of staged files)
// ---------------------------------------------------------------------------

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

async function downloadFromR2(
  objectKey: string,
  contentType: string,
  filename: string,
): Promise<File> {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME!,
    Key: objectKey,
  });
  const response = await r2.send(command);
  if (!response.Body) {
    throw new Error(`R2 object not found: ${objectKey}`);
  }
  const stream = response.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const buffer = Buffer.concat(chunks);
  return new File([buffer], filename, { type: contentType });
}

// ---------------------------------------------------------------------------
// Helpers (unchanged)
// ---------------------------------------------------------------------------

function parseSubmittedTags(value: unknown) {
  if (!value || typeof value !== "string") {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => Boolean(item));
    }
  } catch {}

  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => Boolean(item));
}

function buildDescriptionFileContent(description: string, tags: string[]) {
  const parts: string[] = [];
  const trimmedDescription = description.trim();

  if (trimmedDescription) {
    parts.push(trimmedDescription);
  }

  if (tags.length > 0) {
    const tagsBlock = `Tags: ${tags.join(", ")}`;
    parts.push(tagsBlock);
  }

  return parts.join("\n\n").trim();
}

function formatShowDateDdMmYy(showStart: string) {
  const directMatch = showStart.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (directMatch) {
    const [, year, month, day] = directMatch;
    return `${day}${month}${year.slice(-2)}`;
  }

  const parsed = new Date(showStart);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Could not parse show date for cover image filename.");
  }

  const day = String(parsed.getDate()).padStart(2, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const year = String(parsed.getFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

function applyShowDateSuffixToFilename(filename: string, showStart: string, fallbackBase: string) {
  const suffix = formatShowDateDdMmYy(showStart);
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf(".");

  if (lastDot > 0) {
    const base = trimmed.slice(0, lastDot);
    const extension = trimmed.slice(lastDot);
    return `${base}-${suffix}${extension}`;
  }

  const base = trimmed || fallbackBase;
  return `${base}-${suffix}`;
}

function isValidShowStart(value: string) {
  return !Number.isNaN(new Date(value).getTime());
}

function isUpcomingShowStart(value: string | null) {
  if (!value) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.getTime() >= getReferenceNow().getTime();
}

function buildCoverFilenamePrefix(producerName: string, showStart: string) {
  const safeProducer = producerName
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const producerPart = safeProducer || "producer";
  const datePart = formatShowDateDdMmYy(showStart);
  return `${producerPart}-${datePart}`;
}

function toAiringDateIso(showStart: string | null) {
  if (!showStart) {
    return null;
  }

  const directMatch = showStart.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) {
    return directMatch[1];
  }

  const parsed = new Date(showStart);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

async function getProducerFolderNameFromProfilesTable(userEmail: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("full_name")
    .ilike("producer_email", userEmail.toLowerCase())
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read producer profile: ${error.message}`);
  }

  const fullName = data?.full_name;
  if (typeof fullName !== "string" || !fullName.trim()) {
    return null;
  }

  return fullName.trim();
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userEmail = user.email;

    // Parse JSON body (files are already in R2; we receive object keys)
    const body = (await request.json()) as Record<string, unknown>;

    const uploadTypeRaw = typeof body.uploadType === "string" ? body.uploadType.toLowerCase() : "";
    const uploadType =
      uploadTypeRaw === "cover" ||
      uploadTypeRaw === "description" ||
      uploadTypeRaw === "all"
        ? uploadTypeRaw
        : "audio";

    const description = typeof body.description === "string" ? body.description : "";
    const selectedShowStartRaw =
      typeof body.selectedShowStart === "string" ? body.selectedShowStart.trim() : "";
    const selectedShowTitleRaw =
      typeof body.selectedShowTitle === "string" ? body.selectedShowTitle.trim() : "";

    // Tags can arrive as an array (JSON body) or comma-separated string
    const tagsRaw = Array.isArray(body.tags)
      ? (body.tags as string[])
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : parseSubmittedTags(typeof body.tags === "string" ? body.tags : "");
    const tags = tagsRaw;

    const descriptionFileContent = buildDescriptionFileContent(description, tags);

    // Download staged files from R2 if object keys were provided
    const audioObjectKey =
      typeof body.audioObjectKey === "string" ? body.audioObjectKey : null;
    const audioFilename =
      typeof body.audioFilename === "string" ? body.audioFilename : "audio.mp3";
    const audioContentType =
      typeof body.audioContentType === "string" ? body.audioContentType : "audio/mpeg";

    const imageObjectKey =
      typeof body.imageObjectKey === "string" ? body.imageObjectKey : null;
    const imageFilename =
      typeof body.imageFilename === "string" ? body.imageFilename : "cover.jpg";
    const imageContentType =
      typeof body.imageContentType === "string" ? body.imageContentType : "image/jpeg";

    const [optionalAudio, optionalImage] = await Promise.all([
      audioObjectKey ? downloadFromR2(audioObjectKey, audioContentType, audioFilename) : null,
      imageObjectKey ? downloadFromR2(imageObjectKey, imageContentType, imageFilename) : null,
    ]);

    const hasAnyPayload =
      Boolean(optionalAudio) || Boolean(optionalImage) || Boolean(descriptionFileContent);
    if (!hasAnyPayload) {
      return NextResponse.json({ error: "At least one upload input is required." }, { status: 400 });
    }

    const validationError = validateSubmission(
      optionalAudio,
      optionalImage,
      description,
      tags,
      uploadType,
    );
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const producerFolderName = await getProducerFolderNameFromProfilesTable(userEmail);
    if (!producerFolderName) {
      return NextResponse.json(
        {
          error:
            "Producer full name is missing in profiles table for your email. Update profiles.full_name before uploading.",
        },
        { status: 400 },
      );
    }

    let ftpResult;
    let driveResult;
    let uploadedImageFilename = optionalImage?.name || "";
    let uploadedAudioFilename = optionalAudio?.name || "";

    const upcomingShows = await getUpcomingShowsByProducerEmail(userEmail);
    const nextShow = upcomingShows[0];
    const showStart = nextShow?.startsAt || null;
    const selectedShowStart =
      selectedShowStartRaw && isValidShowStart(selectedShowStartRaw) ? selectedShowStartRaw : null;
    const selectedShowTitle = selectedShowTitleRaw || nextShow?.title || "show-description";
    let persistedShowStart = selectedShowStart || showStart;
    const dateForSuffix = selectedShowStart || showStart;
    const descriptionFilenameHint = dateForSuffix
      ? `${selectedShowTitle}-${formatShowDateDdMmYy(dateForSuffix)}`
      : optionalAudio?.name || "show-description";

    if (uploadType === "audio") {
      const audioUploadName = (optionalAudio as File).name;
      const audioResult = await routeAudioToFtp(
        optionalAudio as File,
        producerFolderName,
        audioUploadName,
      );
      uploadedAudioFilename = audioUploadName;

      ftpResult = {
        success: audioResult.success,
        destination: "ftp" as const,
        message: audioResult.message,
      };

      driveResult = {
        success: true,
        destination: "google-drive" as const,
        message: "Cover upload skipped for audio action.",
      };
    } else if (uploadType === "description") {
      const descriptionResult = await routeDescriptionToFtp(
        descriptionFileContent,
        producerFolderName,
        descriptionFilenameHint,
      );

      ftpResult = descriptionResult;
      driveResult = {
        success: true,
        destination: "google-drive" as const,
        message: "Cover upload skipped for description action.",
      };
    } else if (uploadType === "all") {
      const ftpMessages: string[] = [];
      let ftpSuccess = true;

      if (optionalAudio) {
        const audioUploadName = optionalAudio.name;
        const audioResult = await routeAudioToFtp(optionalAudio, producerFolderName, audioUploadName);
        uploadedAudioFilename = audioUploadName;
        ftpSuccess = ftpSuccess && audioResult.success;
        ftpMessages.push(audioResult.message);
      }

      if (descriptionFileContent) {
        const descriptionResult = await routeDescriptionToFtp(
          descriptionFileContent,
          producerFolderName,
          descriptionFilenameHint,
        );
        ftpSuccess = ftpSuccess && descriptionResult.success;
        ftpMessages.push(descriptionResult.message);
      }

      let driveSuccess = true;
      let driveMessage = "Cover upload skipped.";

      if (optionalImage) {
        const coverShowStart =
          selectedShowStart || showStart || (await getNextUpcomingShowStartByProducerEmail(userEmail));
        persistedShowStart = coverShowStart;

        if (!coverShowStart) {
          throw new Error("No upcoming calendar shows found for this producer.");
        }

        const coverFilenamePrefix = buildCoverFilenamePrefix(producerFolderName, coverShowStart);
        uploadedImageFilename = sanitizeFilename(applyShowDateSuffixToFilename(
          optionalImage.name,
          coverShowStart,
          "show-cover",
        ));

        const shouldUploadToDrive = isUpcomingShowStart(coverShowStart);

        const ftpCoverResult = await routeCoverToFtp(
          optionalImage,
          producerFolderName,
          uploadedImageFilename,
        );
        const driveCoverResult = shouldUploadToDrive
          ? await (async () => {
              const weekdayFolderId = await getDriveWeekdayFolderIdForShowStart(coverShowStart);
              return routeImageToDrive(
                optionalImage,
                weekdayFolderId,
                coverFilenamePrefix,
                uploadedImageFilename,
              );
            })()
          : {
              success: true,
              destination: "google-drive" as const,
              message: "Cover upload to Google Drive skipped for previous show selection.",
            };

        ftpSuccess = ftpSuccess && ftpCoverResult.success;
        ftpMessages.push(ftpCoverResult.message);

        driveSuccess = driveCoverResult.success;
        driveMessage = driveCoverResult.message;
      }

      ftpResult = {
        success: ftpSuccess,
        destination: "ftp" as const,
        message: ftpMessages.length > 0 ? ftpMessages.join(" ").trim() : "No FTP payload uploaded.",
      };
      driveResult = {
        success: driveSuccess,
        destination: "google-drive" as const,
        message: driveMessage,
      };
    } else {
      const coverShowStart =
        selectedShowStart || showStart || (await getNextUpcomingShowStartByProducerEmail(userEmail));
      persistedShowStart = coverShowStart;

      if (!coverShowStart) {
        throw new Error("No upcoming calendar shows found for this producer.");
      }

      const coverFilenamePrefix = buildCoverFilenamePrefix(producerFolderName, coverShowStart);
      uploadedImageFilename = sanitizeFilename(applyShowDateSuffixToFilename(
        (optionalImage as File).name,
        coverShowStart,
        "show-cover",
      ));

      const shouldUploadToDrive = isUpcomingShowStart(coverShowStart);

      const ftpCoverResult = await routeCoverToFtp(
        optionalImage as File,
        producerFolderName,
        uploadedImageFilename,
      );
      const driveCoverResult = shouldUploadToDrive
        ? await (async () => {
            const weekdayFolderId = await getDriveWeekdayFolderIdForShowStart(coverShowStart);
            return routeImageToDrive(
              optionalImage as File,
              weekdayFolderId,
              coverFilenamePrefix,
              uploadedImageFilename,
            );
          })()
        : {
            success: true,
            destination: "google-drive" as const,
            message: "Cover upload to Google Drive skipped for previous show selection.",
          };

      ftpResult = ftpCoverResult;
      driveResult = driveCoverResult;
    }

    try {
      const airingDate = toAiringDateIso(persistedShowStart);
      await persistSubmissionStatus({
        producerEmail: userEmail,
        audioFilename: uploadedAudioFilename,
        imageFilename: uploadedImageFilename,
        showStartAt: persistedShowStart,
        airingDate,
        submittedDescription: description,
        submittedTags: tags,
        ftpStatus: ftpResult.success ? "success" : "failed",
        driveStatus: driveResult.success ? "success" : "failed",
        ftpMessage: ftpResult.message,
        driveMessage: driveResult.message,
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? `Upload routed but status persistence failed: ${error.message}`
              : "Upload routed but status persistence failed.",
          ftp: ftpResult,
          drive: driveResult,
        },
        { status: 500 },
      );
    }

    const allSucceeded = ftpResult.success && driveResult.success;

    return NextResponse.json(
      {
        success: allSucceeded,
        ftp: ftpResult,
        drive: driveResult,
      },
      { status: allSucceeded ? 200 : 207 },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    if (errorMessage.toLowerCase().includes("multipart")) {
      return NextResponse.json(
        {
          error:
            "Upload stream was interrupted while receiving files. Please retry and keep the tab open until submission finishes.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Submission request failed: ${error.message}`
            : "Submission request failed unexpectedly.",
      },
      { status: 500 },
    );
  }
}