import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ProfileDraftPayload = {
  full_name: string;
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

  const fallbackName = getDefaultFullName(user);

  const { data: existingByUserId, error: selectByUserIdError } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (selectByUserIdError) {
    throw new Error(selectByUserIdError.message);
  }

  if (existingByUserId) {
    const needsEmailUpdate =
      typeof existingByUserId.producer_email === "string"
        ? existingByUserId.producer_email.toLowerCase() !== email
        : true;
    const needsNameUpdate =
      typeof existingByUserId.full_name !== "string" || !existingByUserId.full_name.trim();

    if (!needsEmailUpdate && !needsNameUpdate) {
      return existingByUserId;
    }

    const { data: patchedByUserId, error: patchByUserIdError } = await supabase
      .from("profiles")
      .update({
        producer_email: email,
        full_name: needsNameUpdate ? fallbackName : existingByUserId.full_name,
      })
      .eq("id", existingByUserId.id)
      .select("*")
      .single();

    if (patchByUserIdError) {
      throw new Error(patchByUserIdError.message);
    }

    return patchedByUserId;
  }

  const { data: existingByEmail, error: selectByEmailError } = await supabase
    .from("profiles")
    .select("*")
    .eq("producer_email", email)
    .maybeSingle();

  if (selectByEmailError) {
    throw new Error(selectByEmailError.message);
  }

  if (existingByEmail) {
    const name =
      typeof existingByEmail.full_name === "string" && existingByEmail.full_name.trim()
        ? existingByEmail.full_name.trim()
        : fallbackName;

    const { data: linkedByEmail, error: linkByEmailError } = await supabase
      .from("profiles")
      .update({
        user_id: user.id,
        producer_email: email,
        full_name: name,
      })
      .eq("id", existingByEmail.id)
      .select("*")
      .single();

    if (linkByEmailError) {
      throw new Error(linkByEmailError.message);
    }

    return linkedByEmail;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("profiles")
    .insert({
      user_id: user.id,
      producer_email: email,
      full_name: fallbackName,
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

    return NextResponse.json({ profile: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save profile draft." },
      { status: 500 },
    );
  }
}
