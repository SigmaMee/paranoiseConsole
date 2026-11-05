import { createClient as createAdminClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin-access";
import { getProducerEmail } from "@/lib/producer-identity";
import { createClient } from "@/lib/supabase/server";

export const RESIDENT_MODULE_ROLES = ["production", "sharing"] as const;
export type ResidentModuleRole = (typeof RESIDENT_MODULE_ROLES)[number];

type ModuleAuthorization =
  | { user: User; response: null }
  | { user: null; response: NextResponse };

function normalizeRoles(value: unknown): ResidentModuleRole[] {
  if (!Array.isArray(value)) return ["production"];
  const roles = value.filter(
    (role): role is ResidentModuleRole =>
      typeof role === "string" && RESIDENT_MODULE_ROLES.includes(role as ResidentModuleRole),
  );
  return Array.from(new Set(["production" as const, ...roles]));
}

export async function getResidentModuleRoles(user: User): Promise<ResidentModuleRole[]> {
  if (isAdminUser(user)) return [...RESIDENT_MODULE_ROLES];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const producerEmail = getProducerEmail(user);
  if (!url || !serviceRoleKey || !producerEmail) return ["production"];

  const supabase = createAdminClient(url, serviceRoleKey);
  const { data: profileByUserId } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  const { data: profileByEmail } = profileByUserId
    ? { data: null }
    : await supabase
        .from("profiles")
        .select("id")
        .ilike("producer_email", producerEmail)
        .maybeSingle();
  const profile = profileByUserId || profileByEmail;
  if (!profile?.id) return ["production"];

  const { data: residentProfile } = await supabase
    .from("resident_profiles")
    .select("roles")
    .eq("profile_id", profile.id)
    .maybeSingle();
  return normalizeRoles(residentProfile?.roles);
}

export async function canAccessSharing(user: User) {
  return (await getResidentModuleRoles(user)).includes("sharing");
}

export async function requireSharingUser(): Promise<ModuleAuthorization> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      user: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!(await canAccessSharing(user))) {
    return {
      user: null,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { user, response: null };
}
