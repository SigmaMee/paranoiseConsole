import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadToMixcloud } from "@/lib/mixcloud-api";
import { getSignedR2Url, deleteFromR2, fileExistsInR2 } from "@/lib/r2-utils";

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
        // Generate signed R2 URLs (valid for 1 hour)
        const audioUrl = sub.audio_filename 
          ? await getSignedR2Url(sub.audio_filename)
          : undefined;
        const pictureUrl = sub.image_filename
          ? await getSignedR2Url(sub.image_filename)
          : undefined;
        
        const name = sub.airing_date ? `Show ${sub.airing_date}` : "Show";
        const tags = (sub.submitted_tags as string[]) || [];
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

        // Delete files from R2 after successful upload
        if (sub.audio_filename) {
          try {
            await deleteFromR2(sub.audio_filename);
          } catch (err) {
            console.warn(`Failed to delete audio file ${sub.audio_filename} from R2:`, err);
          }
        }
        
        if (sub.image_filename) {
          try {
            await deleteFromR2(sub.image_filename);
          } catch (err) {
            console.warn(`Failed to delete image file ${sub.image_filename} from R2:`, err);
          }
        }

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
