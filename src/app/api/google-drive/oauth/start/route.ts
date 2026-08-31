import { NextResponse } from "next/server";
import { getGoogleDriveOAuthAuthUrl } from "@/lib/google-drive-oauth";
import { requireAdminUser } from "@/lib/admin-access";

export const runtime = "nodejs";

export async function GET() {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

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
