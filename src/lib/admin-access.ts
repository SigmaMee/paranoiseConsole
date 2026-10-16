import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

type AdminCapableUser = Pick<User, "email">;
type AdminAuthorization =
  | { user: User; response: null }
  | { user: null; response: NextResponse };

export const PRIMARY_ADMIN_EMAIL = "paranoise.webradio@gmail.com";

/**
 * Administration is intentionally reserved for the single Paranoise account.
 * App metadata remains protected, but cannot promote another email to admin.
 */
export function isAdminUser(user: AdminCapableUser | null | undefined) {
  if (!user) return false;
  const email = user.email?.trim().toLowerCase();
  return email === PRIMARY_ADMIN_EMAIL;
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
