import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getDriveWeekdayFolderIdForShowStart,
  persistSubmissionStatus,
  routeAudioToFtp,
  routeImageToDrive,
  validateSubmission,
} from "@/lib/submission-routing";
import {
  getNextUpcomingShowStartByProducerEmail,
} from "@/lib/google-calendar";

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
    const title = String(formData.get("title") || "");
    const audio = formData.get("audio");
    const image = formData.get("image");

    if (!(audio instanceof File)) {
      return NextResponse.json({ error: "Audio file is required." }, { status: 400 });
    }

    if (image !== null && !(image instanceof File)) {
      return NextResponse.json({ error: "Invalid cover image payload." }, { status: 400 });
    }

    const optionalImage = image instanceof File && image.size > 0 ? image : null;

    const validationError = validateSubmission(title, audio, optionalImage);
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

    const ftpPromise = routeAudioToFtp(audio, producerFolderName);

    const drivePromise = optionalImage
      ? (async () => {
          const showStart = await getNextUpcomingShowStartByProducerEmail(userEmail);

          if (!showStart) {
            throw new Error("No upcoming calendar shows found for this producer.");
          }

          const weekdayFolderId = await getDriveWeekdayFolderIdForShowStart(showStart);
          return routeImageToDrive(optionalImage, weekdayFolderId);
        })()
      : Promise.resolve({
          success: true,
          destination: "google-drive" as const,
          message: "Cover image skipped (optional).",
        });

    const [ftpResult, driveResult] = await Promise.all([ftpPromise, drivePromise]);

    try {
      await persistSubmissionStatus({
        producerEmail: userEmail,
        title,
        audioFilename: audio.name,
        imageFilename: optionalImage?.name || "",
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
