import { randomUUID } from "crypto";

export const MAX_AUDIO_BYTES = 900 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type UploadField = "audio" | "image";

const AUDIO_CONTENT_TYPES = new Set(["audio/mpeg", "audio/mp3"]);
const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function assertPlainFilename(filename: string) {
  const trimmed = filename.trim();

  if (!trimmed || trimmed.length > 180) {
    throw new Error("Filename is missing or too long.");
  }

  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.startsWith(".") ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new Error("Filename contains invalid path characters.");
  }

  return trimmed;
}

function normalizeBaseName(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 120);
}

export function createSafeAudioFilename(filename: string, contentType = "audio/mpeg") {
  const plain = assertPlainFilename(filename);
  const lower = plain.toLowerCase();

  if (!lower.endsWith(".mp3") || lower.slice(0, -4).includes(".")) {
    throw new Error("Audio filename must have exactly one .mp3 extension.");
  }

  if (!AUDIO_CONTENT_TYPES.has(contentType.toLowerCase())) {
    throw new Error("Audio content type must be MP3.");
  }

  const base = normalizeBaseName(plain.slice(0, -4));
  if (!base) {
    throw new Error("Audio filename has no valid characters.");
  }

  return `${base}.mp3`;
}

export function createSafeImageFilename(filename: string, contentType: string) {
  const plain = assertPlainFilename(filename);
  const expectedExtension = IMAGE_EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()];
  if (!expectedExtension) {
    throw new Error("Cover content type is not supported.");
  }

  const lastDot = plain.lastIndexOf(".");
  if (lastDot <= 0 || plain.slice(0, lastDot).includes(".")) {
    throw new Error("Cover filename must have exactly one supported extension.");
  }

  const suppliedExtension = plain.slice(lastDot).toLowerCase();
  const acceptedExtensions =
    expectedExtension === ".jpg" ? new Set([".jpg", ".jpeg"]) : new Set([expectedExtension]);
  if (!acceptedExtensions.has(suppliedExtension)) {
    throw new Error("Cover filename extension does not match its content type.");
  }

  const base = normalizeBaseName(plain.slice(0, lastDot));
  if (!base) {
    throw new Error("Cover filename has no valid characters.");
  }

  return `${base}${expectedExtension}`;
}

export function validateUploadSize(field: UploadField, size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Upload size must be a positive integer.");
  }

  const maximum = field === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
  if (size > maximum) {
    throw new Error(
      field === "audio" ? "Audio exceeds 900 MB maximum size." : "Cover exceeds 25 MB maximum size.",
    );
  }
}

export function createStagingObjectKey(
  userId: string,
  field: UploadField,
  filename: string,
) {
  return `staging/${userId}/${field}/${randomUUID()}-${filename}`;
}

export function assertOwnedStagingObjectKey(
  objectKey: string,
  userId: string,
  field?: UploadField,
) {
  const expectedPrefix = `staging/${userId}/${field ? `${field}/` : ""}`;
  if (!objectKey.startsWith(expectedPrefix)) {
    throw new Error("Staged upload does not belong to this user or media field.");
  }

  const remainder = objectKey.slice(expectedPrefix.length);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-.+$/i.test(
      remainder,
    ) ||
    remainder.includes("/") ||
    remainder.includes("\\") ||
    remainder.includes("..") ||
    /[\u0000-\u001f\u007f]/.test(remainder)
  ) {
    throw new Error("Staged upload key is malformed.");
  }
}

export function assertStagingObjectMatchesFilename(objectKey: string, filename: string) {
  if (!objectKey.endsWith(`-${filename}`)) {
    throw new Error("Staged upload key does not match the approved filename.");
  }
}
