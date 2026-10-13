import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/admin-access";
import { publishInstagramCarousel } from "@/lib/instagram-publishing";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;
  try {
    const payload = (await request.json()) as { dateIso?: unknown; caption?: unknown; submissionIds?: unknown };
    if (typeof payload.dateIso !== "string" || typeof payload.caption !== "string" || !Array.isArray(payload.submissionIds)) {
      return NextResponse.json({ error: "Invalid publication request." }, { status: 400 });
    }
    const submissionIds = payload.submissionIds.filter((id): id is string => typeof id === "string");
    const result = await publishInstagramCarousel({
      dateIso: payload.dateIso,
      caption: payload.caption,
      submissionIds,
      publishedByUserId: authorization.user.id,
      publishedByEmail: authorization.user.email || null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Instagram publishing failed." }, { status: 400 });
  }
}
