import { getStoredMixcloudAccessToken } from "@/lib/mixcloud-oauth";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import path from "node:path";
import FormData from "form-data";

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

async function downloadFileAsBuffer(url: string): Promise<Buffer> {
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

async function getAudioPart(audioUrl: string) {
  const response = await globalThis.fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText || `HTTP ${response.status}`}`);
  }
  if (!response.body) {
    throw new Error("Failed to download file: response had no body");
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;

  return {
    contentType: response.headers.get("content-type") || "audio/mpeg",
    knownLength: typeof contentLength === "number" && Number.isSafeInteger(contentLength) && contentLength >= 0
      ? contentLength
      : undefined,
    stream: Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
  };
}

function formLength(formData: FormData): Promise<number | null> {
  return new Promise((resolve) => {
    formData.getLength((error, length) => resolve(error ? null : length));
  });
}

async function postMultipart(url: string, formData: FormData) {
  const contentLength = await formLength(formData);
  const headers = formData.getHeaders();
  if (contentLength !== null) headers["content-length"] = String(contentLength);

  return new Promise<{ body: string; status: number; statusText: string }>((resolve, reject) => {
    const request = httpsRequest(url, { method: "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
        });
      });
      response.on("error", reject);
    });

    request.on("error", reject);
    formData.on("error", (error) => request.destroy(error));
    formData.pipe(request);
  });
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

  if (!audioBuffer && !audioUrl) {
    throw new Error("Either audioUrl or audioBuffer must be provided");
  }

  // `form-data` accepts Node streams, so R2 audio is piped to Mixcloud with
  // constant memory usage instead of being copied into both a Buffer and File.
  const formData = new FormData();
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
    formData.append("picture", pictureData, {
      contentType: "image/jpeg",
      filename: "cover.jpg",
      knownLength: pictureData.length,
    });
  }

  // Open the large R2 response only after every small multipart field is ready,
  // so the audio connection can immediately flow through to Mixcloud.
  if (audioBuffer) {
    formData.append("mp3", audioBuffer, {
      contentType: "audio/mpeg",
      filename: "audio.mp3",
      knownLength: audioBuffer.length,
    });
  } else {
    try {
      const audio = await getAudioPart(audioUrl!);
      formData.append("mp3", audio.stream, {
        contentType: audio.contentType,
        filename: "audio.mp3",
        ...(audio.knownLength === undefined ? {} : { knownLength: audio.knownLength }),
      });
    } catch (err) {
      throw new Error(`Failed to download audio file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const response = await postMultipart(apiUrl + `?access_token=${encodeURIComponent(accessToken)}`, formData);

  if (response.status < 200 || response.status >= 300) {
    throw new MixcloudApiError(
      `Mixcloud upload failed: ${response.body || response.statusText || `HTTP ${response.status}`}`,
      response.status,
    );
  }

  let result: unknown;
  try {
    result = JSON.parse(response.body);
  } catch {
    throw new MixcloudApiError("Mixcloud upload returned a non-JSON response.", response.status);
  }

  const normalized = normalizeUploadResponse(result);
  if (normalized) return normalized;

  const message = mixcloudErrorMessage(result);
  if (message) throw new MixcloudApiError(`Mixcloud rejected the upload: ${message}`, response.status);
  throw new MixcloudApiError("Mixcloud upload returned an unrecognized response.", response.status);
}
