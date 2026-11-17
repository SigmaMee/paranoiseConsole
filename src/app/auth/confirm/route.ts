import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") === "magiclink" ? "magiclink" : null;
  const requestedNext = url.searchParams.get("next") || "/dashboard";
  const next = requestedNext.startsWith("/dashboard") ? requestedNext : "/dashboard";
  if (!tokenHash || !type) return NextResponse.redirect(new URL("/login?error=invalid_link", url));
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) return NextResponse.redirect(new URL("/login?error=expired_link", url));
  return NextResponse.redirect(new URL(next, url));
}
