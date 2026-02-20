import fs from "node:fs/promises";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toPlaceholderEmail(slug) {
  const safeSlug = asString(slug)
    .toLowerCase()
    .replace(/[^a-z0-9-_.]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!safeSlug) {
    return "pending-unknown@paranoise.local";
  }

  return `pending+${safeSlug}@paranoise.local`;
}

function mapRecord(record) {
  const explicitEmail = asString(record.email).toLowerCase();
  const slug = asString(record.slug);
  const email = explicitEmail || toPlaceholderEmail(slug);
  const fullName = asString(record.name || record.full_name);

  if (!fullName) {
    return null;
  }

  return {
    producer_email: email,
    full_name: fullName,
    bio: asString(record.bio) || null,
    location: asString(record.location) || null,
    avatar_url: asString(record.avatar_url || record.image) || null,
    social_url: asString(record.social_url || record.link) || null,
    webflow_item_id: asString(record.slug || record.webflow_item_id || record.id) || null,
    sync_status: "pending",
    sync_error: null,
    draft_updated_at: new Date().toISOString(),
  };
}

function normalizeHeaderKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseCsvRecords(raw) {
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  return records.map((record) => {
    const normalized = {};
    for (const [key, value] of Object.entries(record)) {
      normalized[normalizeHeaderKey(key)] = value;
    }
    return normalized;
  });
}

function parseSourceRecords(raw, sourcePath) {
  const lower = sourcePath.toLowerCase();

  if (lower.endsWith(".csv")) {
    return parseCsvRecords(raw);
  }

  const json = JSON.parse(raw);
  const records = Array.isArray(json) ? json : json.items;

  if (!Array.isArray(records)) {
    throw new Error("Webflow export JSON must be an array or { items: [] }.");
  }

  return records;
}

async function run() {
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = required("SUPABASE_SERVICE_ROLE_KEY");
  const sourcePath = process.env.WEBFLOW_EXPORT_PATH || required("WEBFLOW_EXPORT_JSON_PATH");

  const supabase = createClient(supabaseUrl, serviceRole);

  const raw = await fs.readFile(sourcePath, "utf-8");
  const records = parseSourceRecords(raw, sourcePath);

  const rows = records.map(mapRecord).filter(Boolean);

  if (rows.length === 0) {
    throw new Error(
      "No valid producer rows found. Required field: Name (CSV headers are normalized).",
    );
  }

  const placeholderCount = rows.filter((row) => row.producer_email.endsWith("@paranoise.local")).length;

  const { error } = await supabase.from("profiles").upsert(rows, {
    onConflict: "producer_email",
  });

  if (error) {
    throw new Error(error.message);
  }

  console.log(`Imported ${rows.length} producer profiles into Supabase staging.`);
  if (placeholderCount > 0) {
    console.log(
      `${placeholderCount} profile(s) were imported with placeholder emails (pending+slug@paranoise.local). Update producer_email manually in Supabase.`,
    );
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
