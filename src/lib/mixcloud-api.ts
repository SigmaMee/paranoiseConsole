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

export async function uploadToMixcloud({
  audioUrl,
  name,
  tags,
  description,
  pictureUrl,
}: MixcloudUploadParams): Promise<any> {
  const accessToken = getRequiredEnv("MIXCLOUD_ACCESS_TOKEN");
  const apiUrl = "https://api.mixcloud.com/upload/";

  // Mixcloud API expects multipart/form-data
  const formData = new FormData();
  formData.append("mp3", audioUrl); // Should be a file stream or URL
  formData.append("name", name);
  if (description) formData.append("description", description);
  if (tags) formData.append("tags", JSON.stringify(tags));
  if (pictureUrl) formData.append("picture", pictureUrl);

  const response = await fetch(apiUrl + `?access_token=${accessToken}`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mixcloud upload failed: ${error}`);
  }

  return await response.json();
}
