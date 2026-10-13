import { Client } from "basic-ftp";
import { Writable } from "node:stream";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sanitizedFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function withProducerFolder<T>(producerName: string, operation: (client: Client) => Promise<T>) {
  const client = new Client();
  try {
    await client.access({
      host: requiredEnv("FTP_HOST"),
      user: requiredEnv("FTP_USER"),
      password: requiredEnv("FTP_PASSWORD"),
      secure: process.env.FTP_SECURE === "true",
    });
    await client.cd(requiredEnv("FTP_PRODUCER_ROOT_DIR"));
    await client.cd(producerName.trim());
    return await operation(client);
  } finally {
    client.close();
  }
}

async function findFilename(client: Client, filename: string) {
  const entries = await client.list();
  const candidates = new Set([filename, sanitizedFilename(filename)]);
  return entries.find((entry) => entry.isFile && candidates.has(entry.name))?.name || null;
}

export async function audioExistsOnFtp(filename: string, producerName: string) {
  try {
    return await withProducerFolder(producerName, async (client) => Boolean(await findFilename(client, filename)));
  } catch (error) {
    console.error(`FTP presence check failed for ${producerName}/${filename}:`, error);
    return false;
  }
}

export async function downloadAudioFromFtp(filename: string, producerName: string): Promise<Buffer | null> {
  try {
    return await withProducerFolder(producerName, async (client) => {
      const remoteFilename = await findFilename(client, filename);
      if (!remoteFilename) return null;

      const chunks: Buffer[] = [];
      const writable = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      await client.downloadTo(writable, remoteFilename);
      const buffer = Buffer.concat(chunks);
      return buffer.length > 0 ? buffer : null;
    });
  } catch (error) {
    console.error(`FTP download failed for ${producerName}/${filename}:`, error);
    return null;
  }
}
