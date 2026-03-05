import fetch from "node-fetch";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export interface MixcloudUploadParams {
  audioUrl: string;
  name: string;
  tags?: string[];
  description?: string;
  pictureUrl?: string;
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

export async function uploadToMixcloud({
  audioUrl,
  name,
  tags,
  description,
  pictureUrl,
}: MixcloudUploadParams): Promise<any> {
  const accessToken = getRequiredEnv("MIXCLOUD_ACCESS_TOKEN");
  const apiUrl = "https://api.mixcloud.com/upload/";

  // Download audio file from signed R2 URL
  let audioBuffer: Buffer;
  try {
    audioBuffer = await downloadFileAsBuffer(audioUrl);
  } catch (err) {
    throw new Error(`Failed to download audio file from R2: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Mixcloud API expects multipart/form-data
  const formData = new FormData();
  
  // Append audio as Blob
  formData.append("mp3", new File([new Uint8Array(audioBuffer)], "audio.mp3", { type: "audio/mpeg" }));
  formData.append("name", name);
  if (description) formData.append("description", description);
  if (tags && tags.length > 0) formData.append("tags", tags.join(","));
  
  // Download and append picture if available
  if (pictureUrl) {
    try {
      const pictureBuffer = await downloadFileAsBuffer(pictureUrl);
      formData.append("picture", new File([new Uint8Array(pictureBuffer)], "cover.jpg", { type: "image/jpeg" }));
    } catch (err) {
      console.warn(`Failed to download picture: ${err instanceof Error ? err.message : String(err)}`);
    }
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
