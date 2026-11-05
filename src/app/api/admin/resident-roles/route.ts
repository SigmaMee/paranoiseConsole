import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { requireAdminUser } from "@/lib/admin-access";

export async function PATCH(request: Request) {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  const payload = (await request.json()) as { profileId?: unknown; sharing?: unknown };
  if (typeof payload.profileId !== "string" || typeof payload.sharing !== "boolean") {
    return NextResponse.json({ error: "Invalid resident role update." }, { status: 400 });
  }

  const supabase = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const roles = payload.sharing ? ["production", "sharing"] : ["production"];
  const { data, error } = await supabase
    .from("resident_profiles")
    .update({ roles })
    .eq("profile_id", payload.profileId)
    .select("roles")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) {
    return NextResponse.json({ error: "The resident profile must be provisioned before roles can be changed." }, { status: 404 });
  }
  return NextResponse.json({ roles: data.roles });
}
