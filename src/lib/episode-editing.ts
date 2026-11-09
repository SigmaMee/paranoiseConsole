import { fromZonedTime } from "date-fns-tz";

export const EPISODE_EDIT_TIME_ZONE = "Europe/Athens";
export const EPISODE_EDIT_CUTOFF_HOUR = 9;

export function getEpisodeAiringDate(showStart: string) {
  const directMatch = showStart.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(showStart);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function getEpisodeEditDeadline(showStart: string) {
  const airingDate = getEpisodeAiringDate(showStart);
  if (!airingDate) return null;

  return fromZonedTime(`${airingDate}T09:00:00`, EPISODE_EDIT_TIME_ZONE);
}

export function isEpisodeEditingClosed(showStart: string, now = new Date()) {
  const deadline = getEpisodeEditDeadline(showStart);
  return deadline ? now.getTime() >= deadline.getTime() : true;
}
