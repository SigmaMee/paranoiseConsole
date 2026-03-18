import { NextResponse } from "next/server";
import { formatInTimeZone } from "date-fns-tz";
import { getShowsForDate } from "@/lib/google-calendar";
import { getPlaylistsScheduledForDate } from "@/lib/centova-api";
import {
  sendDailyReportEmail,
  type DailyReportShow,
  type UnmatchedCentovaPlaylist,
} from "@/lib/email";

export const runtime = "nodejs";
export const maxDuration = 60;

const ATHENS_TZ = "Europe/Athens";

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
    const [calendarShows, centovaPlaylists] = await Promise.all([
      getShowsForDate(tomorrowDateIso),
      getPlaylistsScheduledForDate(tomorrowDateIso),
    ]);

    // Track which Centova playlists have been matched
    const matchedCentovaIds = new Set<string>();

    const shows: DailyReportShow[] = calendarShows.map((show) => {
      const calendarTimeAthens = show.startsAt
        ? formatInTimeZone(new Date(show.startsAt), ATHENS_TZ, "HH:mm")
        : null;

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
        return {
          calendarTitle: show.title,
          calendarTime: calendarTimeAthens,
          centovaTime: null,
          status: "missing_in_centova" as const,
        };
      }

      matchedCentovaIds.add(String(match.id));

      // Extract HH:mm from Centova scheduled_datetime ("YYYY-MM-DD HH:mm:ss")
      const centovaTimeFull = match.scheduled_datetime ?? "";
      const centovaTime = centovaTimeFull.slice(11, 16) || null; // "HH:mm"

      const timesMatch =
        calendarTimeAthens !== null &&
        centovaTime !== null &&
        calendarTimeAthens === centovaTime;

      return {
        calendarTitle: show.title,
        calendarTime: calendarTimeAthens,
        centovaTime,
        status: timesMatch ? ("match" as const) : ("time_mismatch" as const),
      };
    });

    // Centova playlists that had no matching calendar show
    const unmatchedCentova: UnmatchedCentovaPlaylist[] = centovaPlaylists
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
