import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

type AdminCapableUser = Pick<User, "email" | "app_metadata">;
type AdminAuthorization =
  | { user: User; response: null }
  | { user: null; response: NextResponse };

function configuredAdminEmails() {
  return new Set(
    (process.env.ADMIN_EMAIL || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Roles come from Supabase app metadata, which is not user-editable. The
 * configured admin email remains as a migration path for the existing admin.
 */
export function isAdminUser(user: AdminCapableUser | null | undefined) {
  if (!user) return false;

  const role = user.app_metadata?.role;
  const roles = user.app_metadata?.roles;
  if (
    role === "admin" ||
    (Array.isArray(roles) && roles.some((candidate) => candidate === "admin"))
  ) {
    return true;
  }

  const email = user.email?.trim().toLowerCase();
  return Boolean(email && configuredAdminEmails().has(email));
}

export async function requireAdminUser(): Promise<AdminAuthorization> {
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

  if (!isAdminUser(user)) {
    return {
      user: null,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { user, response: null };
}
