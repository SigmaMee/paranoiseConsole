import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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

    let rows: Array<{ submitted_description?: string | null; submitted_tags?: string[] | null }> = [];

    const { data, error } = await supabase
      .from("submissions")
      .select("submitted_description,submitted_tags")
      .eq("airing_date", airingDate)
      .ilike("producer_email", user.email.toLowerCase())
      .order("created_at", { ascending: false })
      .limit(20);

    if (error?.message?.toLowerCase().includes('column "submitted_description"')) {
      const { data: legacyRows, error: legacyError } = await supabase
        .from("submissions")
        .select("submitted_tags")
        .eq("airing_date", airingDate)
        .ilike("producer_email", user.email.toLowerCase())
        .order("created_at", { ascending: false })
        .limit(20);

      if (legacyError) {
        return NextResponse.json({ description: null, tags: [] });
      }

      rows = (legacyRows || []) as Array<{ submitted_tags?: string[] | null }>;
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

    return NextResponse.json({ description, tags });
  } catch {
    return NextResponse.json({ description: null, tags: [] });
  }
}
