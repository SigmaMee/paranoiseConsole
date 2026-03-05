import { google } from "googleapis";
import { getReferenceNow } from "@/lib/reference-time";

export type UpcomingShow = {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
};

type ProducerShowSelection = {
  mostRecentPastShow: UpcomingShow | null;
  mostRecentFutureShow: UpcomingShow | null;
};

function toIsoDate(value: string) {
  const directMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) {
    return directMatch[1];
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function getEndOfNextMonthIso(referenceDate: Date) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const endOfNextMonth = new Date(year, month + 2, 0, 23, 59, 59, 999);
  return endOfNextMonth.toISOString();
}

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseShowStartToTime(show: UpcomingShow) {
  const parsed = new Date(show.startsAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function mapCalendarEventToShow(event: any): UpcomingShow {
  return {
    id: event.id ?? `${event.summary ?? "event"}-${event.start?.dateTime ?? event.start?.date}`,
    title: event.summary || "Untitled show",
    startsAt: event.start?.dateTime || event.start?.date || "",
    endsAt: event.end?.dateTime || event.end?.date || undefined,
  };
}

export async function getUpcomingShowsByProducerEmail(
  producerEmail: string,
): Promise<UpcomingShow[]> {
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );
  const calendarId = getRequiredEnv("GOOGLE_CALENDAR_ID");

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });
  const now = getReferenceNow();
  const nowIso = now.toISOString();
  const endOfNextMonthIso = getEndOfNextMonthIso(now);

  const response = await calendar.events.list({
    calendarId,
    timeMin: nowIso,
    timeMax: endOfNextMonthIso,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const items = response.data.items ?? [];

  const filtered = items.filter((event) => {
    const attendees = event.attendees ?? [];
    return attendees.some(
      (attendee) => attendee.email?.toLowerCase() === producerEmail.toLowerCase(),
    );
  });

  return filtered.map((event) => ({
    id: event.id ?? `${event.summary ?? "event"}-${event.start?.dateTime ?? event.start?.date}`,
    title: event.summary || "Untitled show",
    startsAt: event.start?.dateTime || event.start?.date || "",
    endsAt: event.end?.dateTime || event.end?.date || undefined,
  }));
}

export async function findUpcomingShowStartByProducerAndTitle(
  producerEmail: string,
  submittedTitle: string,
): Promise<string | null> {
  const normalizedSubmittedTitle = normalizeTitle(submittedTitle);
  if (!normalizedSubmittedTitle) {
    return null;
  }

  const shows = await getUpcomingShowsByProducerEmail(producerEmail);

  const exactMatches = shows.filter(
    (show) => normalizeTitle(show.title) === normalizedSubmittedTitle,
  );

  if (exactMatches.length > 0) {
    return exactMatches[0].startsAt;
  }

  const looseMatches = shows.filter((show) => {
    const normalizedCalendarTitle = normalizeTitle(show.title);
    return (
      normalizedCalendarTitle.includes(normalizedSubmittedTitle) ||
      normalizedSubmittedTitle.includes(normalizedCalendarTitle)
    );
  });

  if (looseMatches.length > 0) {
    return looseMatches[0].startsAt;
  }

  return null;
}

export async function getNextUpcomingShowStartByProducerEmail(
  producerEmail: string,
): Promise<string | null> {
  const shows = await getUpcomingShowsByProducerEmail(producerEmail);
  return shows[0]?.startsAt || null;
}

export async function getScheduledShowCountForDate(airingDateIso: string): Promise<number> {
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );
  const calendarId = getRequiredEnv("GOOGLE_CALENDAR_ID");

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  const dayStart = `${airingDateIso}T00:00:00.000Z`;
  const dayEnd = `${airingDateIso}T23:59:59.999Z`;

  const response = await calendar.events.list({
    calendarId,
    timeMin: dayStart,
    timeMax: dayEnd,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 250,
  });

  const items = response.data.items ?? [];
  return items.filter((event) => {
    if (event.status === "cancelled") {
      return false;
    }

    const startValue = event.start?.dateTime || event.start?.date;
    if (!startValue) {
      return false;
    }

    return toIsoDate(startValue) === airingDateIso;
  }).length;
}

export async function getScheduledShowCountsForMonth(
  monthIso: string,
): Promise<Record<string, number>> {
  const [yearStr, monthStr] = monthIso.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return {};
  }

  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );
  const calendarId = getRequiredEnv("GOOGLE_CALENDAR_ID");

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });
  const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)).toISOString();
  const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();

  const response = await calendar.events.list({
    calendarId,
    timeMin: monthStart,
    timeMax: monthEnd,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 500,
  });

  const items = response.data.items ?? [];
  return items.reduce<Record<string, number>>((acc, event) => {
    if (event.status === "cancelled") {
      return acc;
    }

    const startValue = event.start?.dateTime || event.start?.date;
    if (!startValue) {
      return acc;
    }

    const dateIso = toIsoDate(startValue);
    if (!dateIso || !dateIso.startsWith(`${monthIso}-`)) {
      return acc;
    }

    acc[dateIso] = (acc[dateIso] || 0) + 1;
    return acc;
  }, {});
}

export async function getMostRecentPastAndFutureShowsByProducerEmail(
  producerEmail: string,
): Promise<ProducerShowSelection> {
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );
  const calendarId = getRequiredEnv("GOOGLE_CALENDAR_ID");

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });
  const now = getReferenceNow();
  const nowTime = now.getTime();
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0).toISOString();
  const windowEnd = getEndOfNextMonthIso(now);

  const response = await calendar.events.list({
    calendarId,
    timeMin: windowStart,
    timeMax: windowEnd,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 500,
  });

  const items = response.data.items ?? [];
  const shows = items
    .filter((event) => {
      const attendees = event.attendees ?? [];
      return attendees.some(
        (attendee) => attendee.email?.toLowerCase() === producerEmail.toLowerCase(),
      );
    })
    .map(mapCalendarEventToShow)
    .filter((show) => Boolean(show.startsAt));

  const pastShows = shows.filter((show) => {
    const startTime = parseShowStartToTime(show);
    return startTime !== null && startTime < nowTime;
  });

  const futureShows = shows.filter((show) => {
    const startTime = parseShowStartToTime(show);
    return startTime !== null && startTime >= nowTime;
  });

  return {
    mostRecentPastShow: pastShows.length > 0 ? pastShows[pastShows.length - 1] : null,
    mostRecentFutureShow: futureShows.length > 0 ? futureShows[0] : null,
  };
}
