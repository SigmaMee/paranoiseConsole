import { Client } from "basic-ftp";
import { ensureScheduledCentovaPlaylist } from "@/lib/centova-api";
import { isResidentSlug } from "@/lib/resident-slug";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type ProvisioningStepResult = {
  success: boolean;
  message: string;
};

export type ResidentProvisioningResult = {
  ftp: ProvisioningStepResult;
  centova: ProvisioningStepResult;
};

export async function ensureResidentFtpFolder(slug: string): Promise<ProvisioningStepResult> {
  if (!isResidentSlug(slug)) {
    return { success: false, message: `Invalid canonical resident slug: ${slug}` };
  }

  const root = (process.env.FTP_PRODUCER_ROOT_DIR || "/").replace(/\/$/, "");
  const target = `${root}/${slug}`;
  const client = new Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: getRequiredEnv("FTP_HOST"),
      user: getRequiredEnv("FTP_USER"),
      password: getRequiredEnv("FTP_PASSWORD"),
      secure: process.env.FTP_SECURE === "true",
    });
    await client.ensureDir(target);
    return { success: true, message: `FTP folder ${target} is ready.` };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error
        ? `Failed to ensure FTP folder ${target}: ${error.message}`
        : `Failed to ensure FTP folder ${target}.`,
    };
  } finally {
    client.close();
  }
}

export async function provisionResidentServices(
  slug: string,
  nextShowStartAt: string,
): Promise<ResidentProvisioningResult> {
  const [ftp, centova] = await Promise.all([
    ensureResidentFtpFolder(slug),
    ensureScheduledCentovaPlaylist(slug, nextShowStartAt),
  ]);
  return { ftp, centova };
}
