import { formatInTimeZone } from "date-fns-tz";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export type CentovaPlaylistUpdateResult = {
  success: boolean;
  message: string;
};

type CentovaPlaylist = {
  id: number | string;
  title: string;
  type: string;
  scheduled_datetime?: string;
  scheduled_repeat?: string;
  scheduled_weekdays?: string;
  scheduled_monthdays?: string;
  scheduled_style?: string;
  scheduled_interruptible?: number | string;
  scheduled_duration?: number | string;
  interval_type?: string;
  interval_length?: number | string;
  interval_style?: string;
  general_weight?: number | string;
  general_order?: string;
  general_starttime?: string;
  general_endtime?: string;
  status?: string;
};

function getCentovaBaseUrl() {
  const apiUrl = getRequiredEnv("CENTOVA_API_URL");
  return apiUrl.replace(/\/api\.php(?:\?.*)?$/, "");
}

async function parseCentovaJsonResponse(response: Response) {
  const data = await response.json();
  if (data.type !== "success") {
    throw new Error(data.response?.message || "Centova request failed");
  }
  return data;
}

function toCookieHeader(response: Response) {
  const headerBag = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  const rawCookies = typeof headerBag.getSetCookie === "function"
    ? headerBag.getSetCookie()
    : [response.headers.get("set-cookie")].filter((value): value is string => Boolean(value));

  return rawCookies
    .flatMap((value) => value.split(/, (?=[^;]+?=)/g))
    .map((value) => value.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function loginToCentovaSession() {
  const baseUrl = getCentovaBaseUrl();
  const username = getRequiredEnv("CENTOVA_USERNAME");
  const password = getRequiredEnv("CENTOVA_PASSWORD");

  const body = new URLSearchParams({
    username,
    password,
    login: "Login",
  });

  const response = await fetch(`${baseUrl}/login/index.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    redirect: "manual",
  });

  const cookieHeader = toCookieHeader(response);
  if (!cookieHeader) {
    throw new Error("Failed to establish Centova session.");
  }

  return {
    baseUrl,
    cookieHeader,
  };
}

async function listCentovaPlaylists(): Promise<CentovaPlaylist[]> {
  const apiUrl = getRequiredEnv("CENTOVA_API_URL");
  const username = getRequiredEnv("CENTOVA_USERNAME");
  const password = getRequiredEnv("CENTOVA_PASSWORD");

  const params = new URLSearchParams({
    xm: "server.playlist",
    f: "json",
    "a[username]": username,
    "a[password]": password,
    "a[action]": "list",
  });

  const response = await fetch(`${apiUrl}?${params.toString()}`, {
    method: "POST",
  });

  const data = await parseCentovaJsonResponse(response);
  return Array.isArray(data.response?.data) ? data.response.data : [];
}

function parseTimeComponents(value?: string) {
  const [hourRaw = "00", minuteRaw = "00"] = (value || "00:00:00").split(":");
  const hour24 = Number(hourRaw);
  const minute = Number(minuteRaw);
  const isPm = hour24 >= 12;
  const normalizedHour = hour24 % 12 || 12;

  return {
    hour: String(normalizedHour),
    minute: String(minute),
    ampm: isPm ? "1" : "0",
  };
}

function normalizePlaylistStatus(status?: string) {
  return status === "disabled" ? "disabled" : "enabled";
}

async function updateCentovaPlaylistSchedule(
  playlist: CentovaPlaylist,
  scheduledDatetime: string,
): Promise<void> {
  const { baseUrl, cookieHeader } = await loginToCentovaSession();
  const [datePart, timePart] = scheduledDatetime.split(" ");
  const [year, month, day] = datePart.split("-");
  const scheduledTime = parseTimeComponents(timePart);
  const generalStart = parseTimeComponents(playlist.general_starttime);
  const generalEnd = parseTimeComponents(playlist.general_endtime);

  const body = new URLSearchParams({
    "playlist[title]": playlist.title,
    "playlist[status]": normalizePlaylistStatus(playlist.status),
    "playlist[type]": playlist.type || "scheduled",
    "playlist[general_order]": playlist.general_order || "sequential",
    "playlist[general_weight]": String(playlist.general_weight ?? 1),
    general_starttime_hour: generalStart.hour,
    general_starttime_min: generalStart.minute,
    general_starttime_ampm: generalStart.ampm,
    general_endtime_hour: generalEnd.hour,
    general_endtime_min: generalEnd.minute,
    general_endtime_ampm: generalEnd.ampm,
    scheduled_date_month: String(Number(month)),
    scheduled_date_day: String(Number(day)),
    scheduled_date_year: year,
    tmp_scheduled_datetime: scheduledDatetime,
    scheduled_time_hour: scheduledTime.hour,
    scheduled_time_min: scheduledTime.minute,
    scheduled_time_ampm: scheduledTime.ampm,
    "playlist[scheduled_repeat]": playlist.scheduled_repeat || "never",
    "playlist[scheduled_monthdays]": playlist.scheduled_monthdays || "date",
    "playlist[scheduled_style]": playlist.scheduled_style || "sequential",
    "playlist[scheduled_interruptible]": String(playlist.scheduled_interruptible ?? 0),
    "playlist[scheduled_duration]": String(playlist.scheduled_duration ?? 0),
    "playlist[interval_length]": String(playlist.interval_length ?? 20),
    "playlist[interval_type]": playlist.interval_type || "songs",
    "playlist[interval_style]": playlist.interval_style || "onerandom",
    update: "Save",
  });

  if (playlist.scheduled_repeat === "weekly" && playlist.scheduled_weekdays) {
    for (const weekday of playlist.scheduled_weekdays.split(",").map((value) => value.trim()).filter(Boolean)) {
      body.append("playlist[scheduled_weekdays][]", weekday);
    }
  }

  const response = await fetch(
    `${baseUrl}/client/index.php?page=playlists&action=edit&id=${playlist.id}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
      },
      body: body.toString(),
      redirect: "manual",
    },
  );

  if (!response.ok && response.status !== 302) {
    throw new Error(`Centova schedule update failed with status ${response.status}.`);
  }
}

export async function getCentovaPlaylistByName(
  playlistName: string,
): Promise<{ id: string; title: string } | null> {

  try {
    const playlists = await listCentovaPlaylists();
    const playlist = playlists.find(
      (p: any) =>
        typeof p.title === "string" &&
        p.title.toLowerCase().trim() === playlistName.toLowerCase().trim(),
    );

    return playlist
      ? { id: String(playlist.id), title: playlist.title }
      : null;
  } catch (error) {
    console.error("Error fetching Centova playlists:", error);
    return null;
  }
}

export async function addAudioToPlaylist(
  playlistName: string,
  audioFilename: string,
  producerFolderName: string,
): Promise<CentovaPlaylistUpdateResult> {
  const apiUrl = getRequiredEnv("CENTOVA_API_URL");
  const username = getRequiredEnv("CENTOVA_USERNAME");
  const password = getRequiredEnv("CENTOVA_PASSWORD");

  try {
    const params = new URLSearchParams({
      xm: "server.reindex",
      f: "json",
      "a[username]": username,
      "a[password]": password,
      "a[updateall]": "0",
      "a[clearcache]": "0",
    });

    const response = await fetch(`${apiUrl}?${params.toString()}`, {
      method: "POST",
    });

    await parseCentovaJsonResponse(response);

    const trackPathCandidates = [
      audioFilename,
      `${producerFolderName}/${audioFilename}`,
    ].filter((value, index, array) => array.indexOf(value) === index);

    let lastError = "No matching tracks found";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      for (const trackPath of trackPathCandidates) {
        const addParams = new URLSearchParams({
          xm: "server.playlist",
          f: "json",
          "a[username]": username,
          "a[password]": password,
          "a[action]": "add",
          "a[playlistname]": playlistName,
          "a[trackpath]": trackPath,
        });

        const addResponse = await fetch(`${apiUrl}?${addParams.toString()}`, {
          method: "POST",
        });
        const addData = await addResponse.json();

        if (addData.type === "success") {
          return {
            success: true,
            message: `Imported and added ${audioFilename} to playlist ${playlistName} (trackpath: ${trackPath})`,
          };
        }

        lastError = addData.response?.message || "Failed to add track to playlist";
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
      success: false,
      message: `Reindex completed but track add failed for ${audioFilename}: ${lastError}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to add audio to playlist: ${message}`,
    };
  }
}

export async function schedulePlaylist(
  playlistId: string,
  showStartAt: string,
): Promise<CentovaPlaylistUpdateResult> {
  try {
    const showDate = new Date(showStartAt);
    if (Number.isNaN(showDate.getTime())) {
      return {
        success: false,
        message: `Invalid show start date: ${showStartAt}`,
      };
    }

    const athensDateTime = formatInTimeZone(
      showDate,
      "Europe/Athens",
      "yyyy-MM-dd HH:mm:ss",
    );
    const playlists = await listCentovaPlaylists();
    const playlist = playlists.find((entry) => String(entry.id) === String(playlistId));
    if (!playlist) {
      return {
        success: false,
        message: `Playlist ${playlistId} not found in Centova.`,
      };
    }

    await updateCentovaPlaylistSchedule(playlist, athensDateTime);

    return {
      success: true,
      message: `Scheduled playlist ${playlistId} for ${athensDateTime} Athens time`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to schedule playlist: ${message}`,
    };
  }
}

export async function updateShowPlaylist(
  producerFolderName: string,
  audioFilename: string,
  showStartAt: string,
): Promise<CentovaPlaylistUpdateResult> {
  try {
    // Find playlist matching producer folder name
    const playlist = await getCentovaPlaylistByName(producerFolderName);
    if (!playlist) {
      return {
        success: false,
        message: `Could not find Centova playlist matching "${producerFolderName}"`,
      };
    }

    // Add audio to playlist
    const addResult = await addAudioToPlaylist(playlist.title, audioFilename, producerFolderName);
    if (!addResult.success) {
      return addResult;
    }

    // Schedule the playlist for the show time
    const scheduleResult = await schedulePlaylist(playlist.id, showStartAt);
    if (!scheduleResult.success) {
      return scheduleResult;
    }

    return {
      success: true,
      message: `Updated Centova playlist "${playlist.title}" with audio and scheduled for show time`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      message: `Failed to update Centova playlist: ${message}`,
    };
  }
}
