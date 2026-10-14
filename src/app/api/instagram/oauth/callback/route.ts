import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireAdminUser } from "@/lib/admin-access";
import { connectInstagram } from "@/lib/instagram-oauth";

export const runtime = "nodejs";

function dashboardUrl(message: string, isError = false) {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const url = new URL("/dashboard", base);
  url.searchParams.set("module", "connections");
  url.searchParams.set("instagram_oauth", isError ? "error" : "ok");
  url.searchParams.set("instagram_oauth_message", message);
  return url;
}

function statesMatch(expected: string, supplied: string) {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("instagram_oauth_state")?.value || "";
  cookieStore.delete("instagram_oauth_state");

  if (oauthError) return NextResponse.redirect(dashboardUrl(`Instagram authorization failed: ${oauthError}`, true));
  if (!code || !state || !expectedState || !statesMatch(expectedState, state)) {
    return NextResponse.redirect(dashboardUrl("Instagram authorization could not be verified. Please try again.", true));
  }

  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  try {
    await connectInstagram(code, authorization.user.id, authorization.user.email || null);
    return NextResponse.redirect(dashboardUrl("Instagram connected successfully."));
  } catch (error) {
    return NextResponse.redirect(dashboardUrl(error instanceof Error ? error.message : "Instagram connection failed.", true));
  }
}
