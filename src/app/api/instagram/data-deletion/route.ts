import { NextResponse } from "next/server";
import { handleMetaDataDeletion, verifyMetaSignedRequest } from "@/lib/instagram-oauth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const signedRequest = form.get("signed_request");
    if (typeof signedRequest !== "string") return NextResponse.json({ error: "Missing signed_request." }, { status: 400 });
    const payload = verifyMetaSignedRequest(signedRequest);
    if (typeof payload.user_id !== "string") return NextResponse.json({ error: "Missing Meta user ID." }, { status: 400 });
    const confirmationCode = await handleMetaDataDeletion(payload.user_id);
    const statusUrl = new URL("/api/instagram/data-deletion/status", process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000");
    statusUrl.searchParams.set("code", confirmationCode);
    return NextResponse.json({ url: statusUrl.toString(), confirmation_code: confirmationCode });
  } catch {
    return NextResponse.json({ error: "Invalid data deletion request." }, { status: 400 });
  }
}
