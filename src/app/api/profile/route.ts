import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ProfileDraftPayload = {
  full_name: string;
  bio: string;
  location: string;
  avatar_url: string;
  social_url: string;
};

function getDefaultFullName(user: {
  user_metadata?: Record<string, unknown>;
  email?: string;
}) {
  const fromMetadata = user.user_metadata?.full_name;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    return fromMetadata.trim();
  }

  return user.email?.split("@")[0] || "Producer";
}

async function ensureProfileExists(user: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}) {
  const supabase = await createClient();
  const email = user.email?.toLowerCase();

  if (!email) {
    throw new Error("Authenticated user email is required.");
  }

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("*")
    .eq("producer_email", email)
    .maybeSingle();

  if (selectError) {
    throw new Error(selectError.message);
  }

  if (existing) {
    return existing;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("profiles")
    .insert({
      user_id: user.id,
      producer_email: email,
      full_name: getDefaultFullName(user),
      sync_status: "pending",
      draft_updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(insertError.message);
  }

  return inserted;
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const profile = await ensureProfileExists(user);
    return NextResponse.json({ profile });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load profile." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as Partial<ProfileDraftPayload>;

  const fullName = String(body.full_name || "").trim();
  if (!fullName) {
    return NextResponse.json({ error: "Full name is required." }, { status: 400 });
  }

  try {
    const profile = await ensureProfileExists(user);

    const updatePayload = {
      full_name: fullName,
      bio: String(body.bio || "").trim() || null,
      location: String(body.location || "").trim() || null,
      avatar_url: String(body.avatar_url || "").trim() || null,
      social_url: String(body.social_url || "").trim() || null,
      sync_status: "pending",
      sync_error: null,
      draft_updated_at: new Date().toISOString(),
    };

    const { data: updated, error: updateError } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", profile.id)
      .select("*")
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const { error: syncJobError } = await supabase.from("profile_sync_jobs").insert({
      profile_id: profile.id,
      producer_email: user.email.toLowerCase(),
      status: "pending",
      payload: updatePayload,
    });

    if (syncJobError) {
      return NextResponse.json(
        {
          error: `Profile updated but sync job enqueue failed: ${syncJobError.message}`,
          profile: updated,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ profile: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save profile draft." },
      { status: 500 },
    );
  }
}
