import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type AuthUserSummary = {
  id: string;
  email: string;
};

async function listAllAuthUsers(adminClient: ReturnType<typeof createClient>) {
  const users: AuthUserSummary[] = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Failed to list auth users: ${error.message}`);
    }

    const batch = (data.users || [])
      .filter((user) => typeof user.email === "string" && user.email.trim())
      .map((user) => ({
        id: user.id,
        email: user.email!.toLowerCase(),
      }));

    users.push(...batch);

    if (!data.users || data.users.length < perPage) {
      break;
    }

    page += 1;
    if (page > 25) {
      break;
    }
  }

  return users;
}

export async function GET() {
  try {
    const sessionClient = await createSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
    const isAdmin = Boolean(user.email && adminEmail && user.email.toLowerCase() === adminEmail);

    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { error: "Missing Supabase admin configuration." },
        { status: 500 },
      );
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const [authUsers, unlinkedProfilesResult, linkedProfilesResult] = await Promise.all([
      listAllAuthUsers(adminClient),
      adminClient
        .from("profiles")
        .select("id, producer_email, full_name, user_id, created_at")
        .is("user_id", null)
        .order("created_at", { ascending: true }),
      adminClient
        .from("profiles")
        .select("id, producer_email, full_name, user_id, created_at")
        .not("user_id", "is", null)
        .order("created_at", { ascending: true }),
    ]);

    if (unlinkedProfilesResult.error) {
      return NextResponse.json({ error: unlinkedProfilesResult.error.message }, { status: 500 });
    }

    if (linkedProfilesResult.error) {
      return NextResponse.json({ error: linkedProfilesResult.error.message }, { status: 500 });
    }

    const authEmailById = new Map(authUsers.map((u) => [u.id, u.email]));
    const authIdsByEmail = new Map<string, string[]>();

    for (const authUser of authUsers) {
      const bucket = authIdsByEmail.get(authUser.email) || [];
      bucket.push(authUser.id);
      authIdsByEmail.set(authUser.email, bucket);
    }

    const unlinkedProfiles = (unlinkedProfilesResult.data || []).map((profile) => {
      const profileEmail = String(profile.producer_email || "").toLowerCase();
      const matchingAuthIds = authIdsByEmail.get(profileEmail) || [];
      return {
        id: profile.id,
        producer_email: profile.producer_email,
        full_name: profile.full_name,
        created_at: profile.created_at,
        has_auth_email_match: matchingAuthIds.length > 0,
        matching_auth_user_ids: matchingAuthIds,
      };
    });

    const linkedEmailMismatches = (linkedProfilesResult.data || [])
      .map((profile) => {
        const authEmail = profile.user_id ? authEmailById.get(profile.user_id) : null;
        const profileEmail = String(profile.producer_email || "").toLowerCase();
        const mismatch = Boolean(authEmail && authEmail !== profileEmail);

        return {
          id: profile.id,
          user_id: profile.user_id,
          full_name: profile.full_name,
          producer_email: profile.producer_email,
          auth_email: authEmail,
          mismatch,
        };
      })
      .filter((row) => row.mismatch);

    return NextResponse.json({
      success: true,
      summary: {
        auth_users_count: authUsers.length,
        unlinked_profiles_count: unlinkedProfiles.length,
        unlinked_with_auth_email_match_count: unlinkedProfiles.filter((p) => p.has_auth_email_match).length,
        linked_email_mismatch_count: linkedEmailMismatches.length,
      },
      unlinked_profiles: unlinkedProfiles,
      linked_email_mismatches: linkedEmailMismatches,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to build profile drift report.",
      },
      { status: 500 },
    );
  }
}
