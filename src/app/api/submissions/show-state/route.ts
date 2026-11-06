import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProducerEmail } from "@/lib/producer-identity";

export const runtime = "nodejs";

function toAiringDateIso(showStart: string) {
  const directMatch = showStart.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) {
    return directMatch[1];
  }

  const parsed = new Date(showStart);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 5);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const showStart = url.searchParams.get("showStart")?.trim() || "";
    if (!showStart) {
      return NextResponse.json({ description: null, tags: [] });
    }

    const airingDate = toAiringDateIso(showStart);
    if (!airingDate) {
      return NextResponse.json({ description: null, tags: [] });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const producerEmail = getProducerEmail(user);
    const { data: episode, error: episodeError } = await supabase
      .from("episodes")
      .select("audio_filename,image_filename,audio_submitted_at,image_submitted_at,completed_at")
      .ilike("producer_email", producerEmail)
      .eq("show_start_at", showStart)
      .maybeSingle();

    let rows: Array<{
      submitted_description?: string | null;
      submitted_tags?: string[] | null;
      audio_filename?: string | null;
      image_filename?: string | null;
      ftp_status?: string | null;
      drive_status?: string | null;
    }> = [];

    const { data, error } = await supabase
      .from("submissions")
      .select("submitted_description,submitted_tags,audio_filename,image_filename,ftp_status,drive_status")
      .eq("airing_date", airingDate)
      .ilike("producer_email", producerEmail)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error?.message?.toLowerCase().includes('column "submitted_description"')) {
      const { data: legacyRows, error: legacyError } = await supabase
        .from("submissions")
        .select("submitted_tags,audio_filename,image_filename,ftp_status,drive_status")
        .eq("airing_date", airingDate)
        .ilike("producer_email", producerEmail)
        .order("created_at", { ascending: false })
        .limit(20);

      if (legacyError) {
        return NextResponse.json({ description: null, tags: [] });
      }

      rows = legacyRows || [];
    } else if (error) {
      return NextResponse.json({ description: null, tags: [] });
    } else {
      rows = data || [];
    }

    let description: string | null = null;
    let tags: string[] = [];

    for (const row of rows) {
      if (!description && typeof row.submitted_description === "string" && row.submitted_description.trim()) {
        description = row.submitted_description.trim();
      }

      if (tags.length === 0) {
        const normalized = normalizeTags(row.submitted_tags);
        if (normalized.length > 0) {
          tags = normalized;
        }
      }

      if (description && tags.length > 0) {
        break;
      }
    }

    const episodeUnavailable = episodeError?.message?.toLowerCase().includes('relation "episodes"');
    const legacyAudioFilename = rows.find((row) => {
      const candidate = row as { audio_filename?: string | null };
      return Boolean(candidate.audio_filename?.trim()) && row.ftp_status === "success";
    }) as { audio_filename?: string | null } | undefined;
    const legacyImageFilename = rows.find((row) => {
      const candidate = row as { image_filename?: string | null };
      return Boolean(candidate.image_filename?.trim())
        && row.ftp_status === "success"
        && row.drive_status === "success";
    }) as { image_filename?: string | null } | undefined;
    const audioFilename = episode?.audio_filename || legacyAudioFilename?.audio_filename || null;
    const imageFilename = episode?.image_filename || legacyImageFilename?.image_filename || null;

    return NextResponse.json({
      description,
      tags,
      audioFilename,
      imageFilename,
      audioSubmitted: episodeUnavailable ? Boolean(audioFilename) : Boolean(episode?.audio_submitted_at),
      imageSubmitted: episodeUnavailable ? Boolean(imageFilename) : Boolean(episode?.image_submitted_at),
      completed: Boolean(episode?.completed_at),
    });
  } catch {
    return NextResponse.json({ description: null, tags: [] });
  }
}
