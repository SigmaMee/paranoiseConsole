import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { requireAdminUser } from "@/lib/admin-access";
import { deleteFromR2, fileExistsInR2, getSignedR2Url } from "@/lib/r2-utils";
import { createPublishedShow, findResidentItemId, toWebflowSlug } from "@/lib/webflow-api";

export const runtime = "nodejs";
export const maxDuration = 300;

function showName(filename: string) {
  return filename.replace(/\.[^.]+$/, "").replace(/-\d{6}$/, "") || "Show";
}

async function resolveR2ImageKey(filename: string) {
  if (await fileExistsInR2(filename)) return filename;
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (sanitized !== filename && await fileExistsInR2(sanitized)) return sanitized;
  return null;
}

export async function POST(request: Request) {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  try {
    const { submissionIds } = await request.json();
    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
      return NextResponse.json({ error: "No submissions selected." }, { status: 400 });
    }

    const supabase = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { data: selected, error: selectedError } = await supabase
      .from("submissions")
      .select("producer_email,airing_date")
      .in("id", submissionIds);
    if (selectedError) throw selectedError;

    const results = [];
    for (const selectedShow of selected || []) {
      const producerEmail = String(selectedShow.producer_email || "");
      const airingDate = String(selectedShow.airing_date || "");

      try {
        const { data: rows, error } = await supabase
          .from("submissions")
          .select("audio_filename,image_filename,mixcloud,mixcloud_url,webflow_status,webflow_item_id")
          .eq("producer_email", producerEmail)
          .eq("airing_date", airingDate);
        if (error) throw error;
        if (!rows?.length) throw new Error("Show submissions were not found.");
        if (!rows.some((row) => row.mixcloud === "published")) {
          throw new Error("Show must be published on Mixcloud first.");
        }

        const existingItemId = rows.find((row) => row.webflow_item_id)?.webflow_item_id;
        if (existingItemId) {
          results.push({ producer: producerEmail, airingDate, status: "published", webflowItemId: existingItemId });
          continue;
        }

        const imageFilename = rows.find((row) => row.image_filename)?.image_filename;
        const audioFilename = rows.find((row) => row.audio_filename)?.audio_filename;
        const mixcloudUrl = rows.find((row) => row.mixcloud_url)?.mixcloud_url;
        if (!imageFilename) throw new Error("Show has no cover image.");
        if (!audioFilename) throw new Error("Show has no audio filename.");
        if (!mixcloudUrl) throw new Error("Stored Mixcloud link is missing; republish or repair this show first.");
        const imageKey = await resolveR2ImageKey(imageFilename);
        if (!imageKey) {
          throw new Error("Cover image is no longer available in temporary storage.");
        }

        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("id,full_name,webflow_item_id")
          .eq("producer_email", producerEmail)
          .single();
        if (profileError || !profile?.full_name) throw new Error("Producer profile was not found.");

        let residentItemId = profile.webflow_item_id as string | null;
        if (!residentItemId) {
          residentItemId = await findResidentItemId(profile.full_name);
          await supabase.from("profiles").update({ webflow_item_id: residentItemId }).eq("id", profile.id);
        }

        await supabase
          .from("submissions")
          .update({ webflow_status: "publishing", webflow_error: null })
          .eq("producer_email", producerEmail)
          .eq("airing_date", airingDate);

        const name = showName(audioFilename);
        const webflowItemId = await createPublishedShow({
          name,
          slug: toWebflowSlug(`${name}-${airingDate}`),
          imageUrl: await getSignedR2Url(imageKey),
          residentItemId,
          mixcloudUrl,
        });

        await supabase
          .from("submissions")
          .update({
            webflow_status: "published",
            webflow_item_id: webflowItemId,
            webflow_error: null,
            webflow_published_at: new Date().toISOString(),
          })
          .eq("producer_email", producerEmail)
          .eq("airing_date", airingDate);

        await deleteFromR2(imageKey).catch((cleanupError) => {
          console.warn(`Failed to delete published cover ${imageKey}:`, cleanupError);
        });
        results.push({ producer: producerEmail, airingDate, status: "published", webflowItemId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown Webflow publishing error";
        await supabase
          .from("submissions")
          .update({ webflow_status: "failed", webflow_error: message })
          .eq("producer_email", producerEmail)
          .eq("airing_date", airingDate);
        results.push({ producer: producerEmail, airingDate, status: "error", error: message });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("Unexpected error in Webflow bulk publish:", error);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
