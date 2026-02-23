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
} from "@/lib/submission-routing";
import {
  getUpcomingShowsByProducerEmail,
  getNextUpcomingShowStartByProducerEmail,
} from "@/lib/google-calendar";

function parseSubmittedTags(value: FormDataEntryValue | null) {
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

    const formData = await request.formData();
    const uploadTypeRaw = String(formData.get("uploadType") || "").toLowerCase();
    const uploadType =
      uploadTypeRaw === "cover" ||
      uploadTypeRaw === "description" ||
      uploadTypeRaw === "all"
        ? uploadTypeRaw
        : "audio";
    const description = String(formData.get("description") || "");
    const tags = parseSubmittedTags(formData.get("tags"));
    const descriptionFileContent = buildDescriptionFileContent(description, tags);
    const audio = formData.get("audio");
    const image = formData.get("image");

    const optionalAudio = audio instanceof File && audio.size > 0 ? audio : null;

    if (image !== null && !(image instanceof File)) {
      return NextResponse.json({ error: "Invalid cover image payload." }, { status: 400 });
    }

    const optionalImage = image instanceof File && image.size > 0 ? image : null;

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

    const upcomingShows = await getUpcomingShowsByProducerEmail(userEmail);
    const nextShow = upcomingShows[0];
    const showStart = nextShow?.startsAt || null;
    const descriptionFilenameHint = nextShow
      ? `${nextShow.title}-${formatShowDateDdMmYy(nextShow.startsAt)}`
      : optionalAudio?.name || "show-description";

    if (uploadType === "audio") {
      const audioResult = await routeAudioToFtp(optionalAudio as File, producerFolderName);
      

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
        const audioResult = await routeAudioToFtp(optionalAudio, producerFolderName);
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
        const coverShowStart = showStart || (await getNextUpcomingShowStartByProducerEmail(userEmail));

        if (!coverShowStart) {
          throw new Error("No upcoming calendar shows found for this producer.");
        }

        const coverFilenamePrefix = buildCoverFilenamePrefix(producerFolderName, coverShowStart);
        uploadedImageFilename = `${coverFilenamePrefix}-${optionalImage.name}`;

        const [ftpCoverResult, driveCoverResult] = await Promise.all([
          routeCoverToFtp(optionalImage, producerFolderName, uploadedImageFilename),
          (async () => {
            const weekdayFolderId = await getDriveWeekdayFolderIdForShowStart(coverShowStart);
            return routeImageToDrive(optionalImage, weekdayFolderId, coverFilenamePrefix);
          })(),
        ]);

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
      const coverShowStart = showStart || (await getNextUpcomingShowStartByProducerEmail(userEmail));

      if (!coverShowStart) {
        throw new Error("No upcoming calendar shows found for this producer.");
      }

      const coverFilenamePrefix = buildCoverFilenamePrefix(producerFolderName, coverShowStart);
      uploadedImageFilename = `${coverFilenamePrefix}-${(optionalImage as File).name}`;

      const [ftpCoverResult, driveCoverResult] = await Promise.all([
        routeCoverToFtp(optionalImage as File, producerFolderName, uploadedImageFilename),
        (async () => {
          const weekdayFolderId = await getDriveWeekdayFolderIdForShowStart(coverShowStart);
          return routeImageToDrive(optionalImage as File, weekdayFolderId, coverFilenamePrefix);
        })(),
      ]);

      ftpResult = ftpCoverResult;
      driveResult = driveCoverResult;
    }

    try {
      await persistSubmissionStatus({
        producerEmail: userEmail,
        audioFilename: optionalAudio?.name || "",
        imageFilename: uploadedImageFilename,
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
