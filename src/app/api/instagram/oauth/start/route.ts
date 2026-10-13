import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/admin-access";
import { buildInstagramAuthorizationUrl } from "@/lib/instagram-oauth";

export const runtime = "nodejs";

export async function GET() {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  try {
    const state = randomBytes(32).toString("base64url");
    const response = NextResponse.redirect(buildInstagramAuthorizationUrl(state));
    response.cookies.set("instagram_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/instagram/oauth",
      maxAge: 10 * 60,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start Instagram authorization." },
      { status: 500 },
    );
  }
}
