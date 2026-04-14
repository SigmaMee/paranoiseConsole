import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getDriveWeekdayFolderIdForShowStart,
  persistSubmissionStatus,
  routeAudioToFtp,
  routeCoverToFtp,
  routeDescriptionToFtp,
  routeImageToDrive,
  routeTextToDrive,
  validateSubmission,
  sanitizeFilename,
} from "@/lib/submission-routing";
import {
  getUpcomingShowsByProducerEmail,
  getNextUpcomingShowStartByProducerEmail,
} from "@/lib/google-calendar";
import { updateShowPlaylist } from "@/lib/centova-api";
import { sendSubmissionConfirmationEmail } from "@/lib/email";
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

function buildDescriptionDriveFilename(producerName: string, showStart: string) {
  const safeProducer = producerName
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim();
  const producerPart = safeProducer || "Producer";
  return `${producerPart} - ${formatShowDateDdMmYy(showStart)}.txt`;
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

function getDefaultFullNameFromUser(user: {
  email: string;
  user_metadata?: Record<string, unknown>;
}) {
  const fromMetadata = user.user_metadata?.full_name;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    return fromMetadata.trim();
  }

  const localPart = user.email.split("@")[0]?.trim();
  return localPart || "Producer";
}

async function getProducerFolderNameFromProfilesTable(user: {
  id: string;
  email: string;
  user_metadata?: Record<string, unknown>;
}) {
  const supabase = await createClient();
  const normalizedEmail = user.email.toLowerCase();

  const fallbackFullName = getDefaultFullNameFromUser(user);

  const { data: byUserId, error: byUserIdError } = await supabase
    .from("profiles")
    .select("id, producer_email, full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (byUserIdError) {
    throw new Error(`Failed to read producer profile: ${byUserIdError.message}`);
  }

  if (byUserId) {
    const fullName =
      typeof byUserId.full_name === "string" && byUserId.full_name.trim()
        ? byUserId.full_name.trim()
        : fallbackFullName;

    const needsEmailUpdate =
      typeof byUserId.producer_email === "string"
        ? byUserId.producer_email.toLowerCase() !== normalizedEmail
        : true;
    const needsNameUpdate =
      typeof byUserId.full_name !== "string" || !byUserId.full_name.trim();

    if (!needsEmailUpdate && !needsNameUpdate) {
      return {
        profileId: byUserId.id,
        folderName: fullName,
      };
    }

    const { data: patched, error: patchError } = await supabase
      .from("profiles")
      .update({
        producer_email: normalizedEmail,
        full_name: fullName,
      })
      .eq("id", byUserId.id)
      .select("id, full_name")
      .single();

    if (patchError) {
      throw new Error(`Failed to update producer profile: ${patchError.message}`);
    }

    return {
      profileId: patched.id,
      folderName: patched.full_name,
    };
  }

  const { data: byEmail, error: byEmailError } = await supabase
    .from("profiles")
    .select("id, full_name")
    .ilike("producer_email", normalizedEmail)
    .maybeSingle();

  if (byEmailError) {
    throw new Error(`Failed to read producer profile by email: ${byEmailError.message}`);
  }

  if (!byEmail) {
    const { data: inserted, error: insertError } = await supabase
      .from("profiles")
      .insert({
        user_id: user.id,
        producer_email: normalizedEmail,
        full_name: fallbackFullName,
      })
      .select("id, full_name")
      .single();

    if (insertError) {
      throw new Error(`Failed to create producer profile: ${insertError.message}`);
    }

    return {
      profileId: inserted.id,
      folderName: inserted.full_name,
    };
  }

  const fullName = byEmail.full_name;
  if (typeof fullName !== "string" || !fullName.trim()) {
    const { data: updated, error: updateError } = await supabase
      .from("profiles")
      .update({
        user_id: user.id,
        producer_email: normalizedEmail,
        full_name: fallbackFullName,
      })
      .eq("id", byEmail.id)
      .select("id, full_name")
      .single();

    if (updateError) {
      throw new Error(`Failed to update producer profile full_name: ${updateError.message}`);
    }

    return {
      profileId: updated.id,
      folderName: updated.full_name.trim(),
    };
  }

  const { error: linkError } = await supabase
    .from("profiles")
    .update({
      user_id: user.id,
      producer_email: normalizedEmail,
    })
    .eq("id", byEmail.id);

  if (linkError) {
    throw new Error(`Failed to link producer profile to user: ${linkError.message}`);
  }

  return {
    profileId: byEmail.id,
    folderName: fullName.trim(),
  };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const traceId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let stage = "init";

  const logContext: {
    uploadType?: "audio" | "cover" | "description" | "all";
    userId?: string;
    userEmail?: string;
    hasAudioObjectKey?: boolean;
    hasImageObjectKey?: boolean;
    hasDescription?: boolean;
    tagsCount?: number;
    selectedShowStart?: string | null;
  } = {};

  try {
    stage = "auth:get-user";
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user || !user.email) {
      console.warn("[SUBMISSIONS_TRACE_UNAUTHORIZED]", { traceId, stage });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userEmail = user.email;
    logContext.userId = user.id;
    logContext.userEmail = userEmail;

    // Parse JSON body (files are already in R2; we receive object keys)
    stage = "request:parse-body";
    const body = (await request.json()) as Record<string, unknown>;

    const uploadTypeRaw = typeof body.uploadType === "string" ? body.uploadType.toLowerCase() : "";
    const uploadType =
      uploadTypeRaw === "cover" ||
      uploadTypeRaw === "description" ||
      uploadTypeRaw === "all"
        ? uploadTypeRaw
        : "audio";
    logContext.uploadType = uploadType;

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
    logContext.hasDescription = Boolean(description.trim());
    logContext.tagsCount = tags.length;
    logContext.selectedShowStart = selectedShowStartRaw || null;

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

    logContext.hasAudioObjectKey = Boolean(audioObjectKey);
    logContext.hasImageObjectKey = Boolean(imageObjectKey);

    console.info("[SUBMISSIONS_TRACE_START]", {
      traceId,
      stage,
      ...logContext,
    });

    stage = "staging:download-from-r2";
    const [optionalAudio, optionalImage] = await Promise.all([
      audioObjectKey ? downloadFromR2(audioObjectKey, audioContentType, audioFilename) : null,
      imageObjectKey ? downloadFromR2(imageObjectKey, imageContentType, imageFilename) : null,
    ]);

    const hasAnyPayload =
      Boolean(optionalAudio) || Boolean(optionalImage) || Boolean(descriptionFileContent);
    if (!hasAnyPayload) {
      console.warn("[SUBMISSIONS_TRACE_NO_PAYLOAD]", { traceId, stage, ...logContext });
      return NextResponse.json({ error: "At least one upload input is required." }, { status: 400 });
    }

    stage = "validation:submission";
    const validationError = validateSubmission(
      optionalAudio,
      optionalImage,
      description,
      tags,
      uploadType,
    );
    if (validationError) {
      console.warn("[SUBMISSIONS_TRACE_VALIDATION_ERROR]", {
        traceId,
        stage,
        validationError,
        ...logContext,
      });
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    stage = "profile:resolve-producer";
    const producerProfile = await getProducerFolderNameFromProfilesTable({
      id: user.id,
      email: userEmail,
      user_metadata: user.user_metadata,
    });
    const producerFolderName = producerProfile.folderName;

    let ftpResult;
    let driveResult;
    let centovaResult: { success: boolean; message: string } | null = null;
    let uploadedImageFilename = optionalImage?.name || "";
    let uploadedAudioFilename = optionalAudio?.name || "";

    stage = "calendar:fetch-upcoming";
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
      stage = "route:audio";
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

      // Update Centova playlist if audio uploaded successfully to an upcoming show
      if (audioResult.success && persistedShowStart && isUpcomingShowStart(persistedShowStart)) {
        stage = "centova:update-playlist";
        centovaResult = await updateShowPlaylist(
          producerFolderName,
          audioUploadName,
          persistedShowStart,
        );
      }
    } else if (uploadType === "description") {
      stage = "route:description";
      const descriptionResult = await routeDescriptionToFtp(
        descriptionFileContent,
        producerFolderName,
        descriptionFilenameHint,
      );

      const descriptionShowStart =
        selectedShowStart || showStart || (await getNextUpcomingShowStartByProducerEmail(userEmail));
      persistedShowStart = descriptionShowStart;

      if (!descriptionShowStart) {
        throw new Error("No upcoming calendar shows found for this producer.");
      }

      const weekdayFolderId = await getDriveWeekdayFolderIdForShowStart(descriptionShowStart);
      const driveDescriptionResult = await routeTextToDrive(
        descriptionFileContent,
        buildDescriptionDriveFilename(producerFolderName, descriptionShowStart),
        weekdayFolderId,
      );

      ftpResult = descriptionResult;
      driveResult = driveDescriptionResult;
    } else if (uploadType === "all") {
      stage = "route:all";
      const ftpMessages: string[] = [];
      let ftpSuccess = true;
      let audioUploadSuccessful = false;

      if (optionalAudio) {
        const audioUploadName = optionalAudio.name;
        const audioResult = await routeAudioToFtp(optionalAudio, producerFolderName, audioUploadName);
        uploadedAudioFilename = audioUploadName;
        ftpSuccess = ftpSuccess && audioResult.success;
        audioUploadSuccessful = audioResult.success;
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

      const driveMessages: string[] = [];
      let driveSuccess = true;

      const driveShowStart =
        selectedShowStart || showStart || (await getNextUpcomingShowStartByProducerEmail(userEmail));
      persistedShowStart = driveShowStart;

      if ((optionalImage || descriptionFileContent) && !driveShowStart) {
        throw new Error("No upcoming calendar shows found for this producer.");
      }

      const weekdayFolderId = driveShowStart
        ? await getDriveWeekdayFolderIdForShowStart(driveShowStart)
        : null;

      if (optionalImage) {
        const coverShowStart = driveShowStart as string;

        const coverFilenamePrefix = buildCoverFilenamePrefix(producerFolderName, coverShowStart);
        uploadedImageFilename = sanitizeFilename(applyShowDateSuffixToFilename(
          optionalImage.name,
          coverShowStart,
          "show-cover",
        ));

        const ftpCoverResult = await routeCoverToFtp(
          optionalImage,
          producerFolderName,
          uploadedImageFilename,
        );
        const driveCoverResult = await routeImageToDrive(
          optionalImage,
          weekdayFolderId as string,
          coverFilenamePrefix,
          uploadedImageFilename,
        );

        ftpSuccess = ftpSuccess && ftpCoverResult.success;
        ftpMessages.push(ftpCoverResult.message);

        driveSuccess = driveSuccess && driveCoverResult.success;
        driveMessages.push(driveCoverResult.message);
      }

      if (descriptionFileContent) {
        const driveDescriptionResult = await routeTextToDrive(
          descriptionFileContent,
          buildDescriptionDriveFilename(producerFolderName, driveShowStart as string),
          weekdayFolderId as string,
        );
        driveSuccess = driveSuccess && driveDescriptionResult.success;
        driveMessages.push(driveDescriptionResult.message);
      }

      ftpResult = {
        success: ftpSuccess,
        destination: "ftp" as const,
        message: ftpMessages.length > 0 ? ftpMessages.join(" ").trim() : "No FTP payload uploaded.",
      };
      driveResult = {
        success: driveSuccess,
        destination: "google-drive" as const,
        message:
          driveMessages.length > 0
            ? driveMessages.join(" ").trim()
            : "No Google Drive payload uploaded.",
      };

      // Update Centova playlist if audio uploaded successfully to an upcoming show
      if (audioUploadSuccessful && persistedShowStart && isUpcomingShowStart(persistedShowStart)) {
        stage = "centova:update-playlist";
        centovaResult = await updateShowPlaylist(
          producerFolderName,
          uploadedAudioFilename,
          persistedShowStart,
        );
      }
    } else {
      stage = "route:cover";
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
      stage = "persist:submission-status";
      const airingDate = toAiringDateIso(persistedShowStart);
      await persistSubmissionStatus({
        producerProfileId: producerProfile.profileId,
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
      console.error("[SUBMISSIONS_TRACE_PERSIST_FAILED]", {
        traceId,
        stage,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...logContext,
      });
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

    const allSucceeded = ftpResult.success && driveResult.success && (!centovaResult || centovaResult.success);

    // Fire confirmation email non-blocking — does not affect the response
    if (ftpResult.success) {
      stage = "email:confirmation";
      void sendSubmissionConfirmationEmail({
        to: userEmail,
        producerName: producerFolderName,
        showTitle: selectedShowTitle,
        showStartAt: persistedShowStart,
        audioFilename: uploadedAudioFilename,
        imageFilename: uploadedImageFilename,
        hasDescription: Boolean(description.trim()),
        ftpSuccess: ftpResult.success,
        driveSuccess: driveResult.success,
        centovaResult: centovaResult ?? null,
      }).catch((err: unknown) => {
        console.error("Failed to send submission confirmation email:", err);
      });
    }

    console.info("[SUBMISSIONS_TRACE_SUCCESS]", {
      traceId,
      stage,
      allSucceeded,
      ftpSuccess: ftpResult.success,
      driveSuccess: driveResult.success,
      centovaSuccess: centovaResult ? centovaResult.success : null,
      ...logContext,
    });

    return NextResponse.json(
      {
        success: allSucceeded,
        ftp: ftpResult,
        drive: driveResult,
        ...(centovaResult && { centova: centovaResult }),
      },
      { status: allSucceeded ? 200 : 207 },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    console.error("[SUBMISSIONS_TRACE_UNHANDLED]", {
      traceId,
      stage,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...logContext,
    });

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