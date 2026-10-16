import fetch from "node-fetch";
import { getStoredMixcloudAccessToken } from "@/lib/mixcloud-oauth";
import { readFile } from "node:fs/promises";
import path from "node:path";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function getMixcloudAccessToken() {
  try {
    const stored = await getStoredMixcloudAccessToken();
    if (stored) {
      return stored;
    }
  } catch {}

  return getRequiredEnv("MIXCLOUD_ACCESS_TOKEN");
}

export interface MixcloudUploadParams {
  audioUrl?: string;
  audioBuffer?: Buffer;
  name: string;
  tags?: string[];
  description?: string;
  pictureUrl?: string;
  pictureBuffer?: Buffer;
}

export type MixcloudUploadResponse = {
  key: string;
  [field: string]: unknown;
};

export class MixcloudApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "MixcloudApiError";
  }
}

function mixcloudSlug(value: string, preserveUnderscores = false) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(preserveUnderscores ? /[^a-z0-9_-]+/g : /[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function findMixcloudUploadByName(name: string): Promise<MixcloudUploadResponse | null> {
  const username = process.env.MIXCLOUD_USERNAME || "ParanoiseRadio";
  const slugs = Array.from(new Set([
    mixcloudSlug(name),
    mixcloudSlug(name, true),
  ].filter(Boolean)));

  for (const slug of slugs) {
    const response = await globalThis.fetch(
      `https://api.mixcloud.com/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/`,
      { cache: "no-store" },
    );
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new MixcloudApiError(`Mixcloud lookup failed with status ${response.status}.`, response.status);
    }

    const normalized = normalizeUploadResponse(await response.json());
    if (normalized) return normalized;
  }

  return null;
}

function stringField(value: unknown, field: string) {
  if (!value || typeof value !== "object" || !(field in value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function mixcloudErrorMessage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string" && error.trim()) return error;
  return stringField(error, "message") || stringField(value, "message");
}

function normalizeUploadResponse(value: unknown): MixcloudUploadResponse | null {
  const directKey = stringField(value, "key");
  if (directKey) return { ...(value as Record<string, unknown>), key: directKey };

  if (!value || typeof value !== "object") return null;
  const nested = (value as Record<string, unknown>).result;
  const nestedKey = stringField(nested, "key");
  if (nestedKey) return { ...(nested as Record<string, unknown>), key: nestedKey };

  const directUrl = stringField(value, "url");
  const nestedUrl = stringField(nested, "url");
  const url = directUrl || nestedUrl;
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.mixcloud.com" && parsed.hostname !== "mixcloud.com") return null;
    const key = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
    return { ...(nested && typeof nested === "object" ? nested as Record<string, unknown> : {}), key, url };
  } catch {
    return null;
  }
}

/**
 * Download file from URL and convert to Buffer
 */
async function downloadFileAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
  const buffer = await response.buffer();
  return buffer as Buffer;
}

async function getFallbackCoverBuffer(): Promise<Buffer> {
  const fallbackPath = path.join(process.cwd(), "public", "branding", "mixcloud-fallback-cover.jpg");
  const fallback = await readFile(fallbackPath);

  if (!fallback || fallback.length === 0) {
    throw new Error("Fallback Mixcloud cover image is missing or empty.");
  }

  return fallback;
}

export async function uploadToMixcloud({
  audioUrl,
  audioBuffer,
  name,
  tags,
  description,
  pictureUrl,
  pictureBuffer,
}: MixcloudUploadParams): Promise<MixcloudUploadResponse> {
  const accessToken = await getMixcloudAccessToken();
  const apiUrl = "https://api.mixcloud.com/upload/";

  // Get audio file (either from buffer or download from URL)
  let audioData: Buffer;
  if (audioBuffer) {
    audioData = audioBuffer;
  } else if (audioUrl) {
    try {
      audioData = await downloadFileAsBuffer(audioUrl);
    } catch (err) {
      throw new Error(`Failed to download audio file: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    throw new Error("Either audioUrl or audioBuffer must be provided");
  }

  // Mixcloud API expects multipart/form-data
  const formData = new FormData();
  
  // Append audio as Blob
  formData.append("mp3", new File([new Uint8Array(audioData)], "audio.mp3", { type: "audio/mpeg" }));
  formData.append("name", name);
  if (description) formData.append("description", description);
  
  // Mixcloud expects tags in the format tags-X-tag where X is 0-4
  if (tags && tags.length > 0) {
    tags
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
      .slice(0, 5)
      .forEach((tag, index) => {
        formData.append(`tags-${index}-tag`, tag);
      });
  }
  
  // Get picture (either from buffer or download from URL)
  let pictureData: Buffer | null = null;
  if (pictureBuffer) {
    pictureData = pictureBuffer;
  } else if (pictureUrl) {
    try {
      pictureData = await downloadFileAsBuffer(pictureUrl);
    } catch (err) {
      console.warn(`Failed to download picture: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!pictureData || pictureData.length === 0) {
    console.warn("Using fallback cover image for Mixcloud upload.");
    pictureData = await getFallbackCoverBuffer();
  }

  if (pictureData.length > 0) {
    formData.append("picture", new File([new Uint8Array(pictureData)], "cover.jpg", { type: "image/jpeg" }));
  }

  const response = await globalThis.fetch(apiUrl + `?access_token=${accessToken}`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new MixcloudApiError(
      `Mixcloud upload failed: ${error || response.statusText || `HTTP ${response.status}`}`,
      response.status,
    );
  }

  const responseBody = await response.text();
  let result: unknown;
  try {
    result = JSON.parse(responseBody);
  } catch {
    throw new MixcloudApiError("Mixcloud upload returned a non-JSON response.", response.status);
  }

  const normalized = normalizeUploadResponse(result);
  if (normalized) return normalized;

  const message = mixcloudErrorMessage(result);
  if (message) throw new MixcloudApiError(`Mixcloud rejected the upload: ${message}`, response.status);
  throw new MixcloudApiError("Mixcloud upload returned an unrecognized response.", response.status);
}
