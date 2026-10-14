import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/admin-access";
import { disconnectInstagram } from "@/lib/instagram-oauth";

export const runtime = "nodejs";

export async function POST() {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;
  try {
    await disconnectInstagram();
    return NextResponse.redirect(new URL("/dashboard?module=connections&instagram_oauth=ok&instagram_oauth_message=Instagram%20disconnected.", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"), 303);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not disconnect Instagram." }, { status: 500 });
  }
}
