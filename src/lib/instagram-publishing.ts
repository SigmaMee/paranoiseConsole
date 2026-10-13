import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getSignedR2Url } from "@/lib/r2-utils";
import { getInstagramGraphUrl, getInstagramPublishingCredentials } from "@/lib/instagram-oauth";

const MIN_PUBLICATION_ITEMS = 1;
const MAX_PUBLICATION_ITEMS = 10;
const MAX_CAPTION_LENGTH = 2_200;
const CAPTION_HEADING = "Today on air";

type MetaResponse = {
  id?: string;
  status_code?: string;
  permalink?: string;
  error?: { message?: string };
};

function adminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function metaRequest(path: string, accessToken: string, parameters: Record<string, string> = {}) {
  const url = getInstagramGraphUrl(path);
  const body = new URLSearchParams({ ...parameters, access_token: accessToken });
  const response = await fetch(url, { method: "POST", body, cache: "no-store" });
  const result = (await response.json().catch(() => ({}))) as MetaResponse;
  if (!response.ok || result.error) {
    throw new Error(result.error?.message || `Meta publishing request failed with HTTP ${response.status}.`);
  }
  return result;
}

async function metaGet(path: string, accessToken: string, fields: string) {
  const url = getInstagramGraphUrl(path);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { cache: "no-store" });
  const result = (await response.json().catch(() => ({}))) as MetaResponse;
  if (!response.ok || result.error) {
    throw new Error(result.error?.message || `Meta status request failed with HTTP ${response.status}.`);
  }
  return result;
}

async function waitForContainer(containerId: string, accessToken: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const container = await metaGet(containerId, accessToken, "status_code");
    if (container.status_code === "FINISHED") return;
    if (container.status_code === "ERROR" || container.status_code === "EXPIRED") {
      throw new Error(`Instagram rejected media container ${containerId}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Instagram media processing timed out. It is safe to try again later.");
}

function idempotencyKey(dateIso: string, caption: string, submissionIds: string[]) {
  return createHash("sha256").update(JSON.stringify({ dateIso, caption, submissionIds })).digest("hex");
}

export async function publishInstagramCarousel(input: {
  dateIso: string;
  caption: string;
  submissionIds: string[];
  publishedByUserId: string;
  publishedByEmail: string | null;
}) {
  const programmeCopy = input.caption.trim();
  const caption = `${CAPTION_HEADING}\n\n${programmeCopy}`;
  const submissionIds = Array.from(new Set(input.submissionIds));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateIso)) throw new Error("Select a valid calendar day.");
  if (programmeCopy.length === 0) throw new Error("The Today on air caption cannot be empty.");
  if (caption.length > MAX_CAPTION_LENGTH) throw new Error(`The Instagram caption cannot exceed ${MAX_CAPTION_LENGTH} characters.`);
  if (submissionIds.length < MIN_PUBLICATION_ITEMS || submissionIds.length > MAX_PUBLICATION_ITEMS) {
    throw new Error(`Instagram posts require ${MIN_PUBLICATION_ITEMS}–${MAX_PUBLICATION_ITEMS} pictures.`);
  }

  const supabase = adminSupabase();
  const { data: rows, error: rowsError } = await supabase
    .from("submissions")
    .select("id,image_object_key,image_filename,airing_date")
    .in("id", submissionIds)
    .eq("airing_date", input.dateIso);
  if (rowsError) throw new Error(`Could not load the selected pictures: ${rowsError.message}`);
  if ((rows || []).length !== submissionIds.length) throw new Error("One or more pictures do not belong to the selected day.");

  const rowById = new Map((rows || []).map((row) => [String(row.id), row]));
  const orderedRows = submissionIds.map((id) => rowById.get(id)!);
  if (orderedRows.some((row) => typeof row.image_object_key !== "string" || !row.image_object_key.trim())) {
    throw new Error("One or more legacy pictures must be opened once in the calendar before publishing so they can be retained in R2.");
  }

  const key = idempotencyKey(input.dateIso, caption, submissionIds);
  const { data: existing } = await supabase
    .from("instagram_publications")
    .select("id,status,instagram_media_id,permalink")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (existing?.status === "published") {
    return { mediaId: existing.instagram_media_id as string, permalink: existing.permalink as string | null, alreadyPublished: true };
  }
  if (existing?.status === "publishing") throw new Error("This exact carousel is already being published.");

  const publicationId = existing?.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: publicationError } = await supabase.from("instagram_publications").upsert({
    id: publicationId,
    date_iso: input.dateIso,
    caption,
    idempotency_key: key,
    status: "publishing",
    instagram_media_id: null,
    permalink: null,
    error_message: null,
    published_by_user_id: input.publishedByUserId,
    published_by_email: input.publishedByEmail,
    published_at: null,
    updated_at: now,
  }, { onConflict: "idempotency_key" });
  if (publicationError) throw new Error(`Could not start the publication record: ${publicationError.message}`);

  await supabase.from("instagram_publication_items").delete().eq("publication_id", publicationId);
  const { error: itemError } = await supabase.from("instagram_publication_items").insert(
    orderedRows.map((row, position) => ({
      publication_id: publicationId,
      submission_id: row.id,
      position,
      image_object_key: row.image_object_key,
      image_filename: row.image_filename,
    })),
  );
  if (itemError) throw new Error(`Could not record publication pictures: ${itemError.message}`);

  try {
    const { accountId, accessToken } = await getInstagramPublishingCredentials();
    const imageUrls = await Promise.all(orderedRows.map((row) => getSignedR2Url(row.image_object_key as string)));
    if (imageUrls.length === 1) {
      const container = await metaRequest(`${accountId}/media`, accessToken, {
        image_url: imageUrls[0],
        caption,
      });
      if (!container.id) throw new Error("Instagram did not return a media container ID.");
      await waitForContainer(container.id, accessToken);
      const published = await metaRequest(`${accountId}/media_publish`, accessToken, { creation_id: container.id });
      if (!published.id) throw new Error("Instagram did not return the published media ID.");
      const publishedMedia = await metaGet(published.id, accessToken, "permalink");
      const publishedAt = new Date().toISOString();
      await supabase.from("instagram_publications").update({
        status: "published",
        instagram_media_id: published.id,
        permalink: publishedMedia.permalink || null,
        published_at: publishedAt,
        updated_at: publishedAt,
      }).eq("id", publicationId);
      return { mediaId: published.id, permalink: publishedMedia.permalink || null, alreadyPublished: false };
    }

    const childIds: string[] = [];
    for (const imageUrl of imageUrls) {
      const child = await metaRequest(`${accountId}/media`, accessToken, {
        image_url: imageUrl,
        is_carousel_item: "true",
      });
      if (!child.id) throw new Error("Instagram did not return a media container ID.");
      await waitForContainer(child.id, accessToken);
      childIds.push(child.id);
    }
    const parent = await metaRequest(`${accountId}/media`, accessToken, {
      media_type: "CAROUSEL",
      caption,
      children: childIds.join(","),
    });
    if (!parent.id) throw new Error("Instagram did not return a carousel container ID.");
    await waitForContainer(parent.id, accessToken);
    const published = await metaRequest(`${accountId}/media_publish`, accessToken, { creation_id: parent.id });
    if (!published.id) throw new Error("Instagram did not return the published media ID.");
    const publishedMedia = await metaGet(published.id, accessToken, "permalink");
    const publishedAt = new Date().toISOString();
    await supabase.from("instagram_publications").update({
      status: "published",
      instagram_media_id: published.id,
      permalink: publishedMedia.permalink || null,
      published_at: publishedAt,
      updated_at: publishedAt,
    }).eq("id", publicationId);
    return { mediaId: published.id, permalink: publishedMedia.permalink || null, alreadyPublished: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Instagram publishing failed.";
    await supabase.from("instagram_publications").update({
      status: "failed",
      error_message: message.slice(0, 2_000),
      updated_at: new Date().toISOString(),
    }).eq("id", publicationId);
    throw error;
  }
}
