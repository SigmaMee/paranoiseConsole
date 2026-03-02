import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadToMixcloud } from "@/lib/mixcloud-api";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { submissionIds } = await request.json();
    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
      return NextResponse.json({ error: "No submissions selected." }, { status: 400 });
    }

    const supabase = await createClient();
    // Fetch submissions
    const { data: submissions, error } = await supabase
      .from("submissions")
      .select("id, mixcloud, audio_filename, image_filename, airing_date, submitted_tags")
      .in("id", submissionIds);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Filter only ready submissions
    const readySubs = (submissions || []).filter((s) => s.mixcloud === "ready");
    if (readySubs.length === 0) {
      return NextResponse.json({ error: "No ready submissions to publish." }, { status: 400 });
    }

    // Mixcloud API publishing
    const results = [];
    for (const sub of readySubs) {
      try {
        // Construct URLs for audio/image
        const audioUrl = sub.audio_filename ? `https://your-cdn-url/${sub.audio_filename}` : undefined;
        const pictureUrl = sub.image_filename ? `https://your-cdn-url/${sub.image_filename}` : undefined;
        const name = sub.airing_date ? `Show ${sub.airing_date}` : "Show";
        const tags = sub.submitted_tags || [];
        const description = "Uploaded via Paranoise Console";

        if (!audioUrl) throw new Error("Missing audio file");

        const mixcloudRes = await uploadToMixcloud({
          audioUrl,
          name,
          tags,
          description,
          pictureUrl,
        });

        // Mark as published
        await supabase
          .from("submissions")
          .update({ mixcloud: "published" })
          .eq("id", sub.id);

        results.push({ id: sub.id, status: "published", mixcloud: mixcloudRes });
      } catch (err: any) {
        results.push({ id: sub.id, status: "error", error: err.message });
      }
    }
    return NextResponse.json({ success: true, results });
  } catch (err) {
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
