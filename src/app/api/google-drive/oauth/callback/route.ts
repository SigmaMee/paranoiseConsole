import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { upsertGoogleDriveOAuthTokens } from "@/lib/google-drive-oauth";

function dashboardUrlWithParams(message: string, isError = false) {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const url = new URL("/dashboard", base);
  url.searchParams.set("drive_oauth", isError ? "error" : "ok");
  url.searchParams.set("drive_oauth_message", message);
  return url;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      dashboardUrlWithParams(`Google OAuth canceled or failed: ${oauthError}`, true),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      dashboardUrlWithParams("Missing OAuth authorization code.", true),
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"));
  }

  try {
    await upsertGoogleDriveOAuthTokens(code, user.email);
    return NextResponse.redirect(
      dashboardUrlWithParams("Google Drive connected successfully."),
    );
  } catch (error) {
    return NextResponse.redirect(
      dashboardUrlWithParams(
        error instanceof Error ? error.message : "Failed to store OAuth token.",
        true,
      ),
    );
  }
}
