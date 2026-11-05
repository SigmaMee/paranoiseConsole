import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getProducerEmail } from "@/lib/producer-identity";

export const runtime = "nodejs";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getAdminSupabase() {
  return createAdminClient(
    getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

async function getAuthenticatedResident() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { unauthorized: true as const, resident: null };

  const adminSupabase = getAdminSupabase();
  const { data: profile, error: profileError } = await adminSupabase
    .from("profiles")
    .select("id")
    .ilike("producer_email", getProducerEmail(user))
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile?.id) return { unauthorized: false as const, resident: null };

  const { data: resident, error: residentError } = await adminSupabase
    .from("resident_profiles")
    .select("producer_name,radio_show,city,profile_picture_path,source_profile_picture_url")
    .eq("profile_id", profile.id)
    .maybeSingle();
  if (residentError) throw residentError;
  return { unauthorized: false as const, resident };
}

export async function GET(request: Request) {
  try {
    const { unauthorized, resident } = await getAuthenticatedResident();
    if (unauthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!resident) return new NextResponse(null, { status: 204 });

    const url = new URL(request.url);
    if (url.searchParams.get("image") !== "1") {
      return NextResponse.json({
        producerName: resident.producer_name,
        radioShow: resident.radio_show,
        city: resident.city,
        profilePictureUrl:
          resident.profile_picture_path || resident.source_profile_picture_url
            ? "/api/submissions/artwork-profile?image=1"
            : null,
      });
    }

    if (resident.profile_picture_path) {
      const adminSupabase = getAdminSupabase();
      const { data, error } = await adminSupabase.storage
        .from("resident-profile-pictures")
        .download(resident.profile_picture_path);
      if (error || !data) return new NextResponse(null, { status: 204 });
      return new NextResponse(await data.arrayBuffer(), {
        headers: {
          "Content-Type": data.type || "image/jpeg",
          "Cache-Control": "private, max-age=300",
        },
      });
    }

    if (!resident.source_profile_picture_url) return new NextResponse(null, { status: 204 });
    const response = await fetch(resident.source_profile_picture_url, { cache: "no-store" });
    if (!response.ok) return new NextResponse(null, { status: 204 });
    return new NextResponse(await response.arrayBuffer(), {
      headers: {
        "Content-Type": response.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("Failed to load resident artwork profile:", error);
    return NextResponse.json({ error: "Failed to load resident artwork profile." }, { status: 500 });
  }
}
