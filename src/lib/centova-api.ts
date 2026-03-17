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

export async function getCentovaPlaylistByName(
  playlistName: string,
): Promise<{ id: string; title: string } | null> {
  const host = getRequiredEnv("CENTOVA_HOST");
  const username = getRequiredEnv("CENTOVA_USERNAME");
  const password = getRequiredEnv("CENTOVA_PASSWORD");
  const accountname = getRequiredEnv("CENTOVA_ACCOUNT_NAME");

  try {
    const params = new URLSearchParams({
      xm: "server.playlist",
      f: "json",
      "a[username]": username,
      "a[password]": password,
      "a[action]": "list",
    });

    const response = await fetch(`${host}/api.php?${params.toString()}`, {
      method: "POST",
    });

    const data = await response.json();

    if (data.type !== "success" || !data.response?.data) {
      return null;
    }

    const playlist = data.response.data.find(
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
  playlistId: string,
  audioFilename: string,
): Promise<CentovaPlaylistUpdateResult> {
  const host = getRequiredEnv("CENTOVA_HOST");
  const username = getRequiredEnv("CENTOVA_USERNAME");
  const password = getRequiredEnv("CENTOVA_PASSWORD");

  try {
    const params = new URLSearchParams({
      xm: "server.playlist",
      f: "json",
      "a[username]": username,
      "a[password]": password,
      "a[action]": "add",
      "a[playlist]": playlistId,
      "a[trackname]": audioFilename,
    });

    const response = await fetch(`${host}/api.php?${params.toString()}`, {
      method: "POST",
    });

    const data = await response.json();

    if (data.type !== "success") {
      return {
        success: false,
        message: data.response?.message || "Failed to add track to playlist",
      };
    }

    return {
      success: true,
      message: `Added ${audioFilename} to playlist ${playlistId}`,
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
  const host = getRequiredEnv("CENTOVA_HOST");
  const username = getRequiredEnv("CENTOVA_USERNAME");
  const password = getRequiredEnv("CENTOVA_PASSWORD");

  try {
    // Parse the show start time and convert to Athens timezone
    const showDate = new Date(showStartAt);
    if (Number.isNaN(showDate.getTime())) {
      return {
        success: false,
        message: `Invalid show start date: ${showStartAt}`,
      };
    }

    // Format in Athens timezone (Europe/Athens)
    const athensDateTime = formatInTimeZone(
      showDate,
      "Europe/Athens",
      "yyyy-MM-dd HH:mm:ss",
    );
    const [dateStr, timeStr] = athensDateTime.split(" ");

    // Extract components for Centova API
    const [year, month, day] = dateStr.split("-");
    const [hour, minute] = timeStr.split(":").slice(0, 2);

    // For scheduled playlists, we need to set:
    // - scheduled_datetime (in format YYYY-MM-DD HH:MM:SS)
    // - scheduled_repeat (e.g., "never" for one-time)
    const scheduledDatetime = `${year}-${month}-${day} ${hour}:${minute}:00`;

    const params = new URLSearchParams({
      xm: "server.playlist",
      f: "json",
      "a[username]": username,
      "a[password]": password,
      "a[action]": "reconfigure",
      "a[playlist]": playlistId,
      "a[scheduled_datetime]": scheduledDatetime,
      "a[scheduled_repeat]": "never",
    });

    const response = await fetch(`${host}/api.php?${params.toString()}`, {
      method: "POST",
    });

    const data = await response.json();

    if (data.type !== "success") {
      return {
        success: false,
        message: data.response?.message || "Failed to schedule playlist",
      };
    }

    return {
      success: true,
      message: `Scheduled playlist ${playlistId} for ${scheduledDatetime} Athens time`,
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
    const addResult = await addAudioToPlaylist(playlist.id, audioFilename);
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
