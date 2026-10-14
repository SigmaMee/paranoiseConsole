import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { requireAdminUser } from "@/lib/admin-access";
import { findResidentItemId, listPublishedShowsWithMixcloud } from "@/lib/webflow-api";

export const runtime = "nodejs";
const PUBLISH_MONITORING_START = "2026-10-01";

function showName(filename: string) {
  return filename.replace(/\.[^.]+$/, "").replace(/-\d{6}$/, "") || "Show";
}

function mixcloudSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mixcloudFilenameSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isMissingMixcloudErrorColumn(error: { code?: string; message?: string } | null) {
  return Boolean(error && (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    error.message?.includes("mixcloud_error")
  ));
}

function episodeToken(value: string) {
  return value.toUpperCase().match(/S\d{1,2}E\d{1,2}/)?.[0] || null;
}

export async function POST() {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  try {
    const supabase = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const today = formatInTimeZone(new Date(), "Europe/Brussels", "yyyy-MM-dd");
    const { data, error } = await supabase
      .from("submissions")
      .select("producer_email,airing_date,audio_filename,image_filename,mixcloud,mixcloud_url")
      .gte("airing_date", PUBLISH_MONITORING_START)
      .lt("airing_date", today)
      .neq("webflow_status", "published");
    if (error) throw error;

    const username = process.env.MIXCLOUD_USERNAME || "ParanoiseRadio";
    const emails = Array.from(new Set((data || []).map((row) => String(row.producer_email || "")).filter(Boolean)));
    const { data: profiles, error: profilesError } = emails.length > 0
      ? await supabase.from("profiles").select("id,producer_email,full_name,webflow_item_id").in("producer_email", emails)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const residentByEmail = new Map<string, string>();
    for (const profile of profiles || []) {
      const email = String(profile.producer_email || "").toLowerCase();
      let residentItemId = String(profile.webflow_item_id || "");
      const fullName = String(profile.full_name || "").trim();
      if (!residentItemId && fullName) {
        try {
          residentItemId = await findResidentItemId(fullName);
          await supabase.from("profiles").update({ webflow_item_id: residentItemId }).eq("id", profile.id);
        } catch (error) {
          console.warn(`Could not resolve Webflow Resident for ${fullName}:`, error);
        }
      }
      if (email && residentItemId) residentByEmail.set(email, residentItemId);
    }

    const candidates = new Map<string, {
      producerEmail: string;
      airingDate: string;
      audioFilename: string;
      imageFilename: string;
      mixcloudUrl: string;
      mixcloudStatus: string;
      residentItemId: string;
    }>();
    for (const row of data || []) {
      const producerEmail = String(row.producer_email || "");
      const airingDate = String(row.airing_date || "");
      const audioFilename = String(row.audio_filename || "");
      const key = `${producerEmail}|${airingDate}`;
      const existing = candidates.get(key);
      if (existing) {
        existing.audioFilename ||= audioFilename;
        existing.imageFilename ||= String(row.image_filename || "");
        existing.mixcloudUrl ||= String(row.mixcloud_url || "");
        if (row.mixcloud === "published") existing.mixcloudStatus = "published";
      } else if (producerEmail && airingDate && (audioFilename || row.image_filename)) {
        candidates.set(key, {
          producerEmail,
          airingDate,
          audioFilename,
          imageFilename: String(row.image_filename || ""),
          mixcloudUrl: String(row.mixcloud_url || ""),
          mixcloudStatus: String(row.mixcloud || "not ready"),
          residentItemId: residentByEmail.get(producerEmail.toLowerCase()) || "",
        });
      }
    }

    const results: Array<{ producer: string; status: string; mixcloudUrl: string }> = [];
    for (const candidate of candidates.values()) {
      if (candidate.mixcloudStatus === "published" || !candidate.audioFilename) continue;
      const showTitle = showName(candidate.audioFilename);
      const slugs = Array.from(new Set([mixcloudSlug(showTitle), mixcloudFilenameSlug(showTitle)].filter(Boolean)));
      let cloudcast: { key?: string; url?: string } | null = null;
      for (const slug of slugs) {
        const apiUrl = `https://api.mixcloud.com/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/`;
        const response = await fetch(apiUrl, { cache: "no-store" });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`Mixcloud lookup failed with status ${response.status}.`);
        cloudcast = await response.json() as { key?: string; url?: string };
        if (cloudcast.key) break;
      }
      if (!cloudcast?.key) continue;
      const mixcloudUrl = cloudcast.url || new URL(cloudcast.key, "https://www.mixcloud.com").toString();
      let { error: updateError } = await supabase
        .from("submissions")
        .update({ mixcloud: "published", mixcloud_key: cloudcast.key, mixcloud_url: mixcloudUrl, mixcloud_error: null, webflow_status: "ready" })
        .eq("producer_email", candidate.producerEmail)
        .eq("airing_date", candidate.airingDate);
      if (isMissingMixcloudErrorColumn(updateError)) {
        ({ error: updateError } = await supabase
          .from("submissions")
          .update({ mixcloud: "published", mixcloud_key: cloudcast.key, mixcloud_url: mixcloudUrl, webflow_status: "ready" })
          .eq("producer_email", candidate.producerEmail)
          .eq("airing_date", candidate.airingDate));
      }
      if (updateError) throw updateError;
      results.push({ producer: candidate.producerEmail, status: "reconciled", mixcloudUrl });
    }

    const webflowShows = await listPublishedShowsWithMixcloud();
    const claimedWebflowItems = new Set<string>();
    for (const candidate of candidates.values()) {
      if (!candidate.residentItemId) continue;
      const candidateEpisode = episodeToken(`${candidate.audioFilename} ${candidate.imageFilename}`);
      const airingTime = new Date(`${candidate.airingDate}T00:00:00Z`).getTime();
      const possibleMatches = webflowShows
        .filter((show) => show.residentItemId === candidate.residentItemId && !claimedWebflowItems.has(show.id))
        .map((show) => {
          const publishedTime = show.publishedAt ? new Date(show.publishedAt).getTime() : Number.NaN;
          const daysAfterAiring = Number.isNaN(publishedTime) ? Number.POSITIVE_INFINITY : (publishedTime - airingTime) / 86_400_000;
          const exactUrl = Boolean(candidate.mixcloudUrl && candidate.mixcloudUrl === show.mixcloudUrl);
          const matchingEpisode = Boolean(candidateEpisode && candidateEpisode === episodeToken(`${show.name} ${show.slug} ${show.mixcloudUrl}`));
          return { show, daysAfterAiring, exactUrl, matchingEpisode };
        })
        .filter((match) => match.exactUrl || match.matchingEpisode || (match.daysAfterAiring >= 0 && match.daysAfterAiring <= 14))
        .sort((a, b) => Number(b.exactUrl) - Number(a.exactUrl) || Number(b.matchingEpisode) - Number(a.matchingEpisode) || a.daysAfterAiring - b.daysAfterAiring);

      const match = possibleMatches[0];
      if (!match) continue;
      claimedWebflowItems.add(match.show.id);
      const { error: websiteUpdateError } = await supabase
        .from("submissions")
        .update({
          mixcloud: "published",
          mixcloud_url: match.show.mixcloudUrl,
          webflow_status: "published",
          webflow_item_id: match.show.id,
          webflow_error: null,
          webflow_published_at: match.show.publishedAt || new Date().toISOString(),
        })
        .eq("producer_email", candidate.producerEmail)
        .eq("airing_date", candidate.airingDate);
      if (websiteUpdateError) throw websiteUpdateError;
      results.push({ producer: candidate.producerEmail, status: "website-reconciled", mixcloudUrl: match.show.mixcloudUrl });
    }

    return NextResponse.json({ reconciled: results.length, results });
  } catch (error) {
    console.error("Mixcloud reconciliation failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Mixcloud reconciliation failed." }, { status: 500 });
  }
}
