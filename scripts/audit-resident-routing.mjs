import process from "node:process";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Client } from "basic-ftp";

dotenv.config({ path: ".env.local" });

const EXCLUDED_ROUTING_EMAILS = new Set([
  "paranoise.webradio@gmail.com",
  "cerbole@gmail.com",
  "spyridon.moraitis@klarna.com",
  "spyros.moraitis@wolt.com",
]);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

async function listCentovaPlaylistNames() {
  const params = new URLSearchParams({
    xm: "server.playlist",
    f: "json",
    "a[username]": required("CENTOVA_USERNAME"),
    "a[password]": required("CENTOVA_PASSWORD"),
    "a[action]": "list",
  });
  const response = await fetch(`${required("CENTOVA_API_URL")}?${params}`);
  const data = await response.json();
  if (data.type !== "success") throw new Error(data.response?.message || "Centova list failed");
  return new Set(
    (data.response?.data || [])
      .map((playlist) => String(playlist.title || "").trim())
      .filter(Boolean),
  );
}

async function listFtpFolders() {
  const client = new Client();
  try {
    await client.access({
      host: required("FTP_HOST"),
      user: required("FTP_USER"),
      password: required("FTP_PASSWORD"),
      secure: process.env.FTP_SECURE === "true",
    });
    return new Set(
      (await client.list(process.env.FTP_PRODUCER_ROOT_DIR || "media"))
        .filter((entry) => entry.isDirectory || entry.type === 2)
        .map((entry) => entry.name.trim())
        .filter(Boolean),
    );
  } finally {
    client.close();
  }
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const [profilesResult, residentsResult, ftpFolders, centovaPlaylists] = await Promise.all([
  supabase
    .from("profiles")
    .select("id,full_name,producer_email,slug,ftp_folder_name,centova_playlist_name")
    .order("full_name"),
  supabase.from("resident_profiles").select("profile_id,slug,webflow_item_id"),
  listFtpFolders(),
  listCentovaPlaylistNames(),
]);
if (profilesResult.error) throw profilesResult.error;
if (residentsResult.error) throw residentsResult.error;

const webflowSlugByProfileId = new Map(
  (residentsResult.data || [])
    .filter((resident) => resident.profile_id)
    .map((resident) => [resident.profile_id, resident.slug]),
);

const routableProfiles = (profilesResult.data || []).filter(
  (profile) => !EXCLUDED_ROUTING_EMAILS.has(String(profile.producer_email || "").toLowerCase()),
);
const excludedCount = (profilesResult.data || []).length - routableProfiles.length;

const rows = routableProfiles.map((profile) => {
  const slug = profile.slug || "";
  const ftpRoute = profile.ftp_folder_name || profile.full_name;
  const centovaRoute = profile.centova_playlist_name || profile.full_name;
  const webflowSlug = webflowSlugByProfileId.get(profile.id) || "";
  return {
    resident: profile.full_name,
    slug: slug || "missing",
    webflow: slug && webflowSlug === slug ? "match" : webflowSlug ? `mismatch: ${webflowSlug}` : "missing",
    ftp_current_route: ftpFolders.has(ftpRoute) ? "ready" : `missing: ${ftpRoute}`,
    ftp_slug_cutover: slug && ftpFolders.has(slug) ? "ready" : "not ready",
    centova_current_route: centovaPlaylists.has(centovaRoute) ? "ready" : `missing: ${centovaRoute}`,
    centova_slug_cutover: slug && centovaPlaylists.has(slug) ? "ready" : "not ready",
  };
});

console.table(rows);
const currentRouteFailures = rows.filter(
  (row) => row.ftp_current_route !== "ready" || row.centova_current_route !== "ready",
);
const cutoverReady = rows.filter(
  (row) => row.webflow === "match" && row.ftp_slug_cutover === "ready" && row.centova_slug_cutover === "ready",
);
console.log(`${rows.length - currentRouteFailures.length}/${rows.length} residents have valid current routes.`);
console.log(`${cutoverReady.length}/${rows.length} residents are ready for a future slug-first cutover.`);
console.log(`${excludedCount} non-routable host or legacy identity profiles were excluded.`);
if (currentRouteFailures.length > 0) process.exitCode = 1;
