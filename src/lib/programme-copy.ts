export type ProgrammeShow = {
  calendarTitle: string;
  startsAt: string;
  endsAt: string;
  tags?: readonly string[];
};

export type ProgrammeCopyOptions = {
  locale?: string;
  timeZone?: string;
};

type ParsedProgrammeShow = ProgrammeShow & {
  producer: string;
  showTitle: string;
  startsAtDate: Date;
  endsAtDate: Date;
};

const CALENDAR_TITLE_SEPARATOR = /\s+[-–—]\s+/;

export function parseProgrammeCalendarTitle(calendarTitle: string) {
  const separatorMatch = CALENDAR_TITLE_SEPARATOR.exec(calendarTitle);
  if (!separatorMatch || separatorMatch.index === 0) {
    throw new Error(`Calendar title must use the format "Producer name - Radio Show": ${calendarTitle}`);
  }

  const producer = calendarTitle.slice(0, separatorMatch.index).trim();
  const showTitle = calendarTitle.slice(separatorMatch.index + separatorMatch[0].length).trim();
  if (!producer || !showTitle) {
    throw new Error(`Calendar title must use the format "Producer name - Radio Show": ${calendarTitle}`);
  }

  return { producer, showTitle };
}

function parseShow(show: ProgrammeShow): ParsedProgrammeShow {
  const { producer, showTitle } = parseProgrammeCalendarTitle(show.calendarTitle);
  const startsAtDate = new Date(show.startsAt);
  const endsAtDate = new Date(show.endsAt);

  if (Number.isNaN(startsAtDate.getTime()) || Number.isNaN(endsAtDate.getTime())) {
    throw new Error(`Programme show has an invalid start or end time: ${show.calendarTitle}`);
  }

  return { ...show, producer, showTitle, startsAtDate, endsAtDate };
}

function uniqueTags(shows: readonly ParsedProgrammeShow[]) {
  const seen = new Set<string>();
  return shows.flatMap((show) => show.tags || []).flatMap((tag) => {
    const trimmed = tag.trim();
    const normalized = trimmed.toLocaleLowerCase();
    if (!trimmed || seen.has(normalized)) return [];
    seen.add(normalized);
    return [trimmed];
  });
}

function formatBroadcastWindow(
  firstShow: ParsedProgrammeShow,
  lastShow: ParsedProgrammeShow,
  locale: string,
  timeZone: string,
) {
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const zoneFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "short",
  });
  const zone = zoneFormatter.formatToParts(lastShow.endsAtDate)
    .find((part) => part.type === "timeZoneName")?.value || timeZone;

  return `${timeFormatter.format(firstShow.startsAtDate)} to ${timeFormatter.format(lastShow.endsAtDate)} ${zone}`;
}

function formatEventTime(show: ParsedProgrammeShow, locale: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(show.startsAtDate);
}

function formatGenres(tags: readonly string[], locale: string) {
  return tags.length > 0
    ? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(tags)
    : "varied sounds";
}

export function buildDailyProgrammeCopy(
  shows: readonly ProgrammeShow[],
  options: ProgrammeCopyOptions = {},
) {
  if (shows.length === 0) return null;
  if (shows.length > 4) {
    throw new Error("Daily programme copy currently supports a maximum of four shows.");
  }

  const locale = options.locale || "en-GB";
  const timeZone = options.timeZone || "Europe/Athens";
  const orderedShows = shows.map(parseShow).sort(
    (first, second) => first.startsAtDate.getTime() - second.startsAtDate.getTime(),
  );
  const [first, second, third, fourth] = orderedShows;
  const last = orderedShows[orderedShows.length - 1];
  const genres = formatGenres(uniqueTags(orderedShows), locale);
  const broadcastWindow = formatBroadcastWindow(first, last, locale, timeZone);
  const expectation = `Expect ${genres} from ${broadcastWindow}.`;

  if (orderedShows.length === 1 && first.producer.toLocaleLowerCase().startsWith("guest mix")) {
    const eventTime = formatEventTime(first, locale, timeZone);
    return `${first.showTitle} takes over the guest mix zone on Paranoise with an exclusive mix for your Saturday fun & pleasure. On air at ${eventTime}, soon available on Mixcloud`;
  }

  if (orderedShows.length === 1) {
    return `${first.producer} is going solo with ${first.showTitle}. ${expectation}`;
  }

  if (orderedShows.length === 2) {
    return `${first.producer} goes back to back with ${second.producer}. ${first.showTitle} meets ${second.showTitle}, with a clash of ${genres} from ${broadcastWindow}. Only on Paranoise Radio`;
  }

  if (orderedShows.length === 3) {
    return `${first.producer} kicks off the day with their show ${first.showTitle}, followed by ${second.showTitle} with ${second.producer}. Finally ${third.producer} wraps today's programme on Paranoise Radio with ${third.showTitle}. ${expectation}`;
  }

  return `${first.producer} kicks off the day with their show ${first.showTitle}, followed by ${second.showTitle} with ${second.producer} and ${third.showTitle} by ${third.producer}. Finally ${fourth.producer} wraps today's programme on Paranoise Radio with ${fourth.showTitle}. ${expectation}`;
}
