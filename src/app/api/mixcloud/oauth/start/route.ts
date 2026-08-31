import { NextResponse } from "next/server";
import { getMixcloudOAuthAuthUrl } from "@/lib/mixcloud-oauth";
import { requireAdminUser } from "@/lib/admin-access";

export const runtime = "nodejs";

export async function GET() {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  try {
    const authUrl = getMixcloudOAuthAuthUrl();
    return NextResponse.redirect(authUrl);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to start Mixcloud OAuth: ${error.message}`
            : "Failed to start Mixcloud OAuth.",
      },
      { status: 500 },
    );
  }
}
