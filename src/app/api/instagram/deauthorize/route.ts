import { NextResponse } from "next/server";
import { handleMetaDeauthorization, verifyMetaSignedRequest } from "@/lib/instagram-oauth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const signedRequest = form.get("signed_request");
    if (typeof signedRequest !== "string") return NextResponse.json({ error: "Missing signed_request." }, { status: 400 });
    const payload = verifyMetaSignedRequest(signedRequest);
    if (typeof payload.user_id !== "string") return NextResponse.json({ error: "Missing Meta user ID." }, { status: 400 });
    await handleMetaDeauthorization(payload.user_id);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Invalid deauthorization request." }, { status: 400 });
  }
}
