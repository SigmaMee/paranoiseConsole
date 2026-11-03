import { createClient } from "@supabase/supabase-js";

const WEBFLOW_API_BASE = "https://api.webflow.com/v2";
const WEBFLOW_RESIDENTS_COLLECTION_ID =
  process.env.WEBFLOW_RESIDENTS_COLLECTION_ID || "6083f919fa3c2258f1cd9ca2";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/gi, "ae")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function listWebflowResidents() {
  const residents = [];
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${WEBFLOW_API_BASE}/collections/${WEBFLOW_RESIDENTS_COLLECTION_ID}/items?limit=100&offset=${offset}`,
      { headers: { Authorization: `Bearer ${required("WEBFLOW_API_TOKEN")}` } },
    );
    if (!response.ok) throw new Error(`Webflow read failed (${response.status}): ${await response.text()}`);
    const data = await response.json();
    const items = data.items || [];
    residents.push(
      ...items
        .filter((item) => item.id && item.isArchived !== true && item.fieldData?.name && item.fieldData?.slug)
        .map((item) => ({
          itemId: item.id,
          name: String(item.fieldData.name).trim(),
          slug: String(item.fieldData.slug).trim(),
        })),
    );
    if (items.length < 100) break;
    offset += items.length;
  }
  return residents;
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const [{ data: profiles, error: profilesError }, { data: residentProfiles, error: residentsError }, webflowResidents] =
  await Promise.all([
    supabase.from("profiles").select("id,full_name,webflow_item_id,slug"),
    supabase.from("resident_profiles").select("id,profile_id,webflow_item_id,slug"),
    listWebflowResidents(),
  ]);
if (profilesError) throw profilesError;
if (residentsError) throw residentsError;

const profilesById = new Map((profiles || []).map((profile) => [profile.id, profile]));
const profilesByName = new Map((profiles || []).map((profile) => [normalizeName(profile.full_name), profile]));
const profilesByWebflowId = new Map(
  (profiles || []).filter((profile) => profile.webflow_item_id).map((profile) => [profile.webflow_item_id, profile]),
);
const residentsByWebflowId = new Map(
  (residentProfiles || []).filter((resident) => resident.webflow_item_id).map((resident) => [resident.webflow_item_id, resident]),
);

const assignments = webflowResidents.map((webflowResident) => {
  const residentProfile = residentsByWebflowId.get(webflowResident.itemId) || null;
  const profile = (residentProfile?.profile_id && profilesById.get(residentProfile.profile_id))
    || profilesByWebflowId.get(webflowResident.itemId)
    || profilesByName.get(normalizeName(webflowResident.name))
    || null;
  return {
    webflowResident,
    residentProfile,
    profile,
    canonicalSlug: profile?.slug || webflowResident.slug,
  };
});

const ownerBySlug = new Map();
for (const assignment of assignments) {
  if (!assignment.profile) continue;
  const existingOwner = ownerBySlug.get(assignment.canonicalSlug);
  if (existingOwner && existingOwner !== assignment.profile.id) {
    throw new Error(`Slug collision for "${assignment.canonicalSlug}" between profiles ${existingOwner} and ${assignment.profile.id}.`);
  }
  ownerBySlug.set(assignment.canonicalSlug, assignment.profile.id);
}

let profilesUpdated = 0;
let residentsUpdated = 0;
let unmatched = 0;
for (const assignment of assignments) {
  if (!assignment.profile) unmatched += 1;
  if (assignment.profile && !assignment.profile.slug) {
    const { error } = await supabase
      .from("profiles")
      .update({ slug: assignment.canonicalSlug })
      .eq("id", assignment.profile.id)
      .is("slug", null);
    if (error) throw error;
    profilesUpdated += 1;
  }
  if (assignment.residentProfile && assignment.residentProfile.slug !== assignment.canonicalSlug) {
    const { error } = await supabase
      .from("resident_profiles")
      .update({ slug: assignment.canonicalSlug })
      .eq("id", assignment.residentProfile.id);
    if (error) throw error;
    residentsUpdated += 1;
  }
}

console.log(
  `Preserved ${profilesUpdated} profile slugs and ${residentsUpdated} resident profile slugs from Webflow; ${unmatched} Webflow residents had no Console profile match.`,
);
