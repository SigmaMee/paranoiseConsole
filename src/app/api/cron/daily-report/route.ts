import { NextResponse } from "next/server";
import { formatInTimeZone } from "date-fns-tz";
import { getShowsForDate } from "@/lib/google-calendar";
import { getScheduledCentovaPlaylists } from "@/lib/centova-api";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import {
  sendDailyReportEmail,
  type DailyReportShow,
  type UnmatchedCentovaPlaylist,
} from "@/lib/email";
import { audioExistsOnFtp } from "@/lib/ftp-media";

export const runtime = "nodejs";
export const maxDuration = 60;

const ATHENS_TZ = "Europe/Athens";

type SubmissionAudioRow = {
  producer_email: string;
  audio_filename: string;
  audio_ftp_folder: string | null;
  ftp_status: string;
};

type CronHeartbeatMetadata = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Auth guard — Vercel sends Authorization: Bearer <CRON_SECRET> automatically
// ---------------------------------------------------------------------------

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  const authHeader = request.headers.get("authorization")?.trim();
  return authHeader === `Bearer ${cronSecret}`;
}

function getAdminSupabase() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

async function writeCronHeartbeat(
  status: "success" | "unauthorized" | "error",
  message: string,
  metadata: CronHeartbeatMetadata = {},
) {
  const supabase = getAdminSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("cron_heartbeats").insert({
    route: "/api/cron/daily-report",
    status,
    message,
    metadata,
  });

  if (error) {
    console.error("Failed to persist cron heartbeat:", error.message);
  }
}

async function getResidentDestinationByEmail(): Promise<Map<string, string>> {
  const supabase = getAdminSupabase();
  if (!supabase) return new Map<string, string>();

  const { data, error } = await supabase
    .from("profiles")
    .select("producer_email, full_name");

  if (error) throw new Error(`Failed to read resident destinations for report: ${error.message}`);

  const destinationByEmail = new Map(
    (data ?? [])
      .filter((row) => typeof row.producer_email === "string" && typeof row.full_name === "string")
      .map((row) => [row.producer_email.toLowerCase().trim(), row.full_name.trim()]),
  );

  // Auth aliases store their canonical producer email in protected app_metadata.
  // Resolve those aliases to the canonical profile destination as well.
  for (let page = 1; ; page += 1) {
    const { data: usersPage, error: usersError } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (usersError) throw new Error(`Failed to read producer aliases for report: ${usersError.message}`);

    for (const user of usersPage.users) {
      const loginEmail = user.email?.toLowerCase().trim();
      const canonicalEmail = typeof user.app_metadata?.producer_email === "string"
        ? user.app_metadata.producer_email.toLowerCase().trim()
        : loginEmail;
      const canonicalDestination = canonicalEmail ? destinationByEmail.get(canonicalEmail) : null;
      if (loginEmail && canonicalDestination) destinationByEmail.set(loginEmail, canonicalDestination);
    }

    if (usersPage.users.length < 1000) break;
  }

  return destinationByEmail;
}

async function getUploadedAudioByDestinationForDate(
  dateIso: string,
  residentDestinationByEmail: Map<string, string>,
): Promise<Map<string, boolean>> {
  const supabase = getAdminSupabase();
  if (!supabase) return new Map<string, boolean>();

  const { data, error } = await supabase
    .from("submissions")
    .select("producer_email, audio_filename, audio_ftp_folder, ftp_status")
    .eq("airing_date", dateIso)
    .eq("ftp_status", "success")
    .not("audio_filename", "is", null)
    .neq("audio_filename", "");

  if (error) {
    throw new Error(`Failed to read submissions for report: ${error.message}`);
  }

  const rows = (data ?? []) as SubmissionAudioRow[];
  const map = new Map<string, boolean>();
  await Promise.all(rows.map(async (row) => {
    const email = row.producer_email?.toLowerCase().trim();
    const destination = email ? residentDestinationByEmail.get(email) : null;
    if (!destination) return;
    map.set(destination.toLowerCase(), await audioExistsOnFtp(row.audio_filename, destination));
  }));
  return map;
}

// ---------------------------------------------------------------------------
// GET handler — called by Vercel cron at 19:00 UTC (21:00 Athens EET)
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    await writeCronHeartbeat("unauthorized", "Authorization header did not match CRON_SECRET");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // "Tomorrow" in Athens time
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowDateIso = formatInTimeZone(tomorrow, ATHENS_TZ, "yyyy-MM-dd");
    const tomorrowFormatted = formatInTimeZone(tomorrow, ATHENS_TZ, "d MMMM yyyy");

    // Fetch data from both sources in parallel
    const [calendarShows, centovaPlaylists, residentDestinationByEmail] = await Promise.all([
      getShowsForDate(tomorrowDateIso),
      getScheduledCentovaPlaylists(),
      getResidentDestinationByEmail(),
    ]);
    const audioUploadedByDestination = await getUploadedAudioByDestinationForDate(
      tomorrowDateIso,
      residentDestinationByEmail,
    );

    // Track which Centova playlists have been matched
    const matchedCentovaIds = new Set<string>();

    const shows: DailyReportShow[] = calendarShows.map((show) => {
      const calendarTimeAthens = show.startsAt
        ? formatInTimeZone(new Date(show.startsAt), ATHENS_TZ, "HH:mm")
        : null;
      const calendarDateAthens = show.startsAt
        ? formatInTimeZone(new Date(show.startsAt), ATHENS_TZ, "yyyy-MM-dd")
        : tomorrowDateIso;

      const attendeeEmails = Array.isArray(show.attendeeEmails)
        ? show.attendeeEmails.map((email) => email.toLowerCase().trim())
        : [];
      const residentDestinations = attendeeEmails
        .map((email) => residentDestinationByEmail.get(email))
        .filter((destination): destination is string => Boolean(destination));
      const match = centovaPlaylists.find((playlist) =>
        residentDestinations.some(
          (destination) => destination.toLowerCase() === playlist.title.toLowerCase().trim(),
        ),
      ) ?? null;
      const audioUploaded = residentDestinations.some(
        (destination) => audioUploadedByDestination.get(destination.toLowerCase()) === true,
      );

      if (!match) {
        return {
          calendarTitle: show.title,
          calendarDate: calendarDateAthens,
          calendarTime: calendarTimeAthens,
          centovaDate: null,
          centovaTime: null,
          audioUploaded,
          status: "missing_in_centova" as const,
        };
      }

      matchedCentovaIds.add(String(match.id));

      // Extract HH:mm from Centova scheduled_datetime ("YYYY-MM-DD HH:mm:ss")
      const centovaTimeFull = match.scheduled_datetime ?? "";
      const centovaDate = centovaTimeFull.slice(0, 10) || null;
      const centovaTime = centovaTimeFull.slice(11, 16) || null; // "HH:mm"

      const dateMatches = calendarDateAthens !== null && centovaDate !== null && calendarDateAthens === centovaDate;

      const timesMatch =
        calendarTimeAthens !== null &&
        centovaTime !== null &&
        calendarTimeAthens === centovaTime;

      return {
        calendarTitle: show.title,
        calendarDate: calendarDateAthens,
        calendarTime: calendarTimeAthens,
        centovaDate,
        centovaTime,
        audioUploaded,
        status: dateMatches && timesMatch
          ? ("match" as const)
          : dateMatches
            ? ("time_mismatch" as const)
            : ("date_mismatch" as const),
      };
    });

    // Centova playlists for tomorrow that had no matching calendar show
    const unmatchedCentova: UnmatchedCentovaPlaylist[] = centovaPlaylists
      .filter((p) => (p.scheduled_datetime ?? "").startsWith(tomorrowDateIso))
      .filter((p) => !matchedCentovaIds.has(String(p.id)))
      .map((p) => ({
        title: p.title,
        scheduledTime: (p.scheduled_datetime ?? "").slice(11, 16) || "–",
      }));

    await sendDailyReportEmail({
      reportDate: tomorrowFormatted,
      shows,
      unmatchedCentova,
    });

    await writeCronHeartbeat("success", "Daily report sent", {
      reportDate: tomorrowDateIso,
      calendarShows: calendarShows.length,
      centovaPlaylistsTotal: centovaPlaylists.length,
      unmatchedCentova: unmatchedCentova.length,
      readyToStream: shows.filter((show) => show.status === "match" && show.audioUploaded).length,
    });

    return NextResponse.json({
      ok: true,
      reportDate: tomorrowDateIso,
      calendarShows: calendarShows.length,
      centovaPlaylists: centovaPlaylists.length,
    });
  } catch (error) {
    console.error("Daily report cron failed:", error);

    await writeCronHeartbeat(
      "error",
      error instanceof Error ? error.message : "Unknown error",
    );

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
