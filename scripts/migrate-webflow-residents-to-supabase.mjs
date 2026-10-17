import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const WEBFLOW_API_BASE = "https://api.webflow.com/v2";
const WEBFLOW_RESIDENTS_COLLECTION_ID =
  process.env.WEBFLOW_RESIDENTS_COLLECTION_ID || "6083f919fa3c2258f1cd9ca2";
const STORAGE_BUCKET = "resident-profile-pictures";
const EXCLUDED_WEBFLOW_RESIDENT_IDS = new Set([
  "617e7bdc9045b4819ee33dc8", // Back A Yard Athens
  "6518195798a23c1c6ca4a8e9", // DJ Grazzhoppa
  "65181a21cfbdd097db2a851b", // Ele Bak
  "6518198523e88eb0c222427a", // Female:Pressure
  "617e7bdca052744faa174d9f", // Ladies on Records
]);

function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeName(value) {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function richTextToPlainText(value) {
  const html = optionalText(value);
  if (!html) return null;
  return html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>|<\/li\s*>|<\/h[1-6]\s*>/gi, "\n")
    .replace(/<li(?:\s[^>]*)?>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim() || null;
}

async function listWebflowResidents(token) {
  const residents = [];
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${WEBFLOW_API_BASE}/collections/${WEBFLOW_RESIDENTS_COLLECTION_ID}/items?limit=100&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`Webflow read failed (${response.status}): ${await response.text()}`);
    const data = await response.json();
    const items = data.items || [];
    residents.push(...items);
    if (items.length < 100) break;
    offset += items.length;
  }
  return residents;
}

function imageExtension(contentType, url) {
  const knownTypes = new Map([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["image/avif", "avif"],
  ]);
  if (knownTypes.has(contentType)) return knownTypes.get(contentType);
  const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "avif"].includes(extension) ? extension : "jpg";
}

async function copyProfilePicture(supabase, itemId, sourceUrl) {
  if (!sourceUrl) return null;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Image download failed (${response.status}) for Webflow item ${itemId}`);
  const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0];
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
  const objectPath = `${itemId}/${digest}.${imageExtension(contentType, sourceUrl)}`;
  let uploadError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, bytes, {
      contentType,
      cacheControl: "31536000",
      upsert: false,
    });
    if (!error || /already exists|duplicate/i.test(error.message)) {
      uploadError = null;
      break;
    }
    uploadError = error;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  if (uploadError) throw uploadError;
  return objectPath;
}

async function removeImportedResident(supabase, itemId) {
  const { data: objects, error: listError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .list(itemId, { limit: 100 });
  if (listError) throw listError;
  const objectPaths = (objects || [])
    .filter((object) => object.name)
    .map((object) => `${itemId}/${object.name}`);
  if (objectPaths.length > 0) {
    const { error: removeError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(objectPaths);
    if (removeError) throw removeError;
  }
  const { error: deleteError } = await supabase
    .from("resident_profiles")
    .delete()
    .eq("webflow_item_id", itemId);
  if (deleteError) throw deleteError;
}

const supabase = createClient(
  requiredEnvironmentVariable("NEXT_PUBLIC_SUPABASE_URL"),
  requiredEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const webflowToken = requiredEnvironmentVariable("WEBFLOW_API_TOKEN");

const [{ data: profiles, error: profilesError }, webflowItems] = await Promise.all([
  supabase.from("profiles").select("id,full_name,webflow_item_id"),
  listWebflowResidents(webflowToken),
]);
if (profilesError) throw profilesError;

const profilesByName = new Map(
  (profiles || []).map((profile) => [normalizeName(profile.full_name), profile.id]),
);
const profilesByWebflowItemId = new Map(
  (profiles || [])
    .filter((profile) => profile.webflow_item_id)
    .map((profile) => [profile.webflow_item_id, profile.id]),
);
let imported = 0;
let failed = 0;
let archivedExcluded = 0;
let manuallyExcluded = 0;

for (const item of webflowItems) {
  const fields = item.fieldData || {};
  const producerName = optionalText(fields.name);
  if (!item.id || !producerName) continue;
  const isManuallyExcluded = EXCLUDED_WEBFLOW_RESIDENT_IDS.has(item.id);
  if (item.isArchived === true || isManuallyExcluded) {
    try {
      await removeImportedResident(supabase, item.id);
      if (isManuallyExcluded) manuallyExcluded += 1;
      else archivedExcluded += 1;
    } catch (error) {
      failed += 1;
      console.error(`Failed to remove archived resident ${producerName} (${item.id}):`, error);
    }
    continue;
  }
  const sourceImageUrl = optionalText(fields["profile-picture"]?.url);
  try {
    const profilePicturePath = await copyProfilePicture(supabase, item.id, sourceImageUrl);
    const { error } = await supabase.from("resident_profiles").upsert({
      profile_id: profilesByWebflowItemId.get(item.id)
        || profilesByName.get(normalizeName(producerName))
        || null,
      producer_name: producerName,
      radio_show: optionalText(fields["radio-show-2"]),
      city: optionalText(fields.city),
      show_type: "Recorded",
      about: richTextToPlainText(fields.bio),
      follow_link: optionalText(fields["facebook-link"]),
      profile_picture_path: profilePicturePath,
      profile_picture_alt: optionalText(fields["profile-picture"]?.alt),
      source_profile_picture_url: sourceImageUrl,
      webflow_item_id: item.id,
      webflow_sync_status: "synced",
      webflow_last_synced_at: new Date().toISOString(),
      webflow_sync_error: null,
    }, { onConflict: "webflow_item_id" });
    if (error) throw error;
    imported += 1;
  } catch (error) {
    failed += 1;
    console.error(`Failed to import ${producerName} (${item.id}):`, error);
  }
}

console.log(
  `Imported ${imported} active Webflow residents into Supabase; `
  + `${archivedExcluded} archived residents excluded; `
  + `${manuallyExcluded} manually excluded; ${failed} failed.`,
);
if (failed > 0) process.exitCode = 1;
