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
}: MixcloudUploadParams): Promise<any> {
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
  
  // Upload as unlisted (private) - upload will not appear in public profile
  // Only accessible via direct link
  formData.append("unlisted", "1");
  
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

  const response = await fetch(apiUrl + `?access_token=${accessToken}`, {
    method: "POST",
    body: formData as any,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mixcloud upload failed: ${error}`);
  }

  return await response.json();
}
