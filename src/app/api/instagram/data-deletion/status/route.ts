import { NextResponse } from "next/server";
import { getDataDeletionStatus } from "@/lib/instagram-oauth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") || "";
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  const requestedAt = await getDataDeletionStatus(code).catch(() => null);
  if (!requestedAt) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  return NextResponse.json({ status: "completed", requestedAt });
}
