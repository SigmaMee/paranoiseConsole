import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGoogleDriveOAuthAuthUrl } from "@/lib/google-drive-oauth";

export const runtime = "nodejs";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"));
  }

  try {
    const authUrl = getGoogleDriveOAuthAuthUrl();
    return NextResponse.redirect(authUrl);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to start Google OAuth: ${error.message}`
            : "Failed to start Google OAuth.",
      },
      { status: 500 },
    );
  }
}
