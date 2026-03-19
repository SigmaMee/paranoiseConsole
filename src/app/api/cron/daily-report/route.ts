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

export const runtime = "nodejs";
export const maxDuration = 60;

const ATHENS_TZ = "Europe/Athens";

type SubmissionAudioRow = {
  producer_email: string;
  audio_filename: string;
  ftp_status: string;
};

// ---------------------------------------------------------------------------
// Auth guard — Vercel sends Authorization: Bearer <CRON_SECRET> automatically
// ---------------------------------------------------------------------------

function isAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;
  const authHeader = request.headers.get("authorization")?.trim();
  return authHeader === `Bearer ${cronSecret}`;
}

// ---------------------------------------------------------------------------
// Normalise a show/playlist title for fuzzy matching
// ---------------------------------------------------------------------------

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

async function getUploadedAudioByEmailForDate(dateIso: string): Promise<Map<string, boolean>> {
  const supabase = getAdminSupabase();
  if (!supabase) return new Map<string, boolean>();

  const { data, error } = await supabase
    .from("submissions")
    .select("producer_email, audio_filename, ftp_status")
    .eq("airing_date", dateIso)
    .eq("ftp_status", "success")
    .not("audio_filename", "is", null)
    .neq("audio_filename", "");

  if (error) {
    throw new Error(`Failed to read submissions for report: ${error.message}`);
  }

  const rows = (data ?? []) as SubmissionAudioRow[];
  const map = new Map<string, boolean>();
  for (const row of rows) {
    const email = row.producer_email?.toLowerCase().trim();
    if (email) map.set(email, true);
  }
  return map;
}

// ---------------------------------------------------------------------------
// GET handler — called by Vercel cron at 19:00 UTC (21:00 Athens EET)
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // "Tomorrow" in Athens time
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowDateIso = formatInTimeZone(tomorrow, ATHENS_TZ, "yyyy-MM-dd");
    const tomorrowFormatted = formatInTimeZone(tomorrow, ATHENS_TZ, "d MMMM yyyy");

    // Fetch data from both sources in parallel
    const [calendarShows, centovaPlaylists, audioUploadedByEmail] = await Promise.all([
      getShowsForDate(tomorrowDateIso),
      getScheduledCentovaPlaylists(),
      getUploadedAudioByEmailForDate(tomorrowDateIso),
    ]);

    // Track which Centova playlists have been matched
    const matchedCentovaIds = new Set<string>();

    const shows: DailyReportShow[] = calendarShows.map((show) => {
      const calendarTimeAthens = show.startsAt
        ? formatInTimeZone(new Date(show.startsAt), ATHENS_TZ, "HH:mm")
        : null;
      const calendarDateAthens = show.startsAt
        ? formatInTimeZone(new Date(show.startsAt), ATHENS_TZ, "yyyy-MM-dd")
        : tomorrowDateIso;

      const normalizedShowTitle = normalizeTitle(show.title);

      // Find matching Centova playlist by title (exact, then partial)
      const match =
        centovaPlaylists.find((p) => normalizeTitle(p.title) === normalizedShowTitle) ??
        centovaPlaylists.find((p) => {
          const pt = normalizeTitle(p.title);
          return pt.includes(normalizedShowTitle) || normalizedShowTitle.includes(pt);
        }) ??
        null;

      if (!match) {
        const attendeeEmails = Array.isArray(show.attendeeEmails)
          ? show.attendeeEmails.map((email) => email.toLowerCase())
          : [];
        const audioUploaded = attendeeEmails.some((email) => audioUploadedByEmail.get(email) === true);

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

      const attendeeEmails = Array.isArray(show.attendeeEmails)
        ? show.attendeeEmails.map((email) => email.toLowerCase())
        : [];
      const audioUploaded = attendeeEmails.some((email) => audioUploadedByEmail.get(email) === true);

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

    return NextResponse.json({
      ok: true,
      reportDate: tomorrowDateIso,
      calendarShows: calendarShows.length,
      centovaPlaylists: centovaPlaylists.length,
    });
  } catch (error) {
    console.error("Daily report cron failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
