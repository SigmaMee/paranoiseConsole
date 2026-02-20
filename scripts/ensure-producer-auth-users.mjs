import crypto from "node:crypto";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeName(name) {
  return String(name || "").trim();
}

async function listAllUsersByEmail(supabase) {
  const usersByEmail = new Map();
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      throw new Error(`Failed to list auth users: ${error.message}`);
    }

    const users = data?.users || [];

    for (const user of users) {
      const email = normalizeEmail(user.email);
      if (email) {
        usersByEmail.set(email, user);
      }
    }

    if (users.length < perPage) {
      break;
    }

    page += 1;
  }

  return usersByEmail;
}

async function run() {
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = required("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("producer_email, full_name")
    .not("producer_email", "is", null)
    .not("full_name", "is", null);

  if (profilesError) {
    throw new Error(`Failed to read profiles: ${profilesError.message}`);
  }

  const validProfiles = (profiles || [])
    .map((profile) => ({
      email: normalizeEmail(profile.producer_email),
      fullName: normalizeName(profile.full_name),
    }))
    .filter((profile) => profile.email && profile.fullName);

  const usersByEmail = await listAllUsersByEmail(supabase);

  let created = 0;
  let alreadyPresent = 0;
  const errors = [];

  for (const profile of validProfiles) {
    const existing = usersByEmail.get(profile.email);

    if (existing) {
      alreadyPresent += 1;
      continue;
    }

    const temporaryPassword = `tmp-${crypto.randomUUID()}-pw`;

    const { data, error } = await supabase.auth.admin.createUser({
      email: profile.email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: {
        full_name: profile.fullName,
      },
    });

    if (error || !data?.user) {
      errors.push(`${profile.email}: ${error?.message || "unknown error"}`);
      continue;
    }

    usersByEmail.set(profile.email, data.user);
    created += 1;
  }

  console.log(`Profiles considered: ${validProfiles.length}`);
  console.log(`Auth users already present: ${alreadyPresent}`);
  console.log(`Auth users created: ${created}`);

  if (errors.length > 0) {
    console.error(`Create errors: ${errors.length}`);
    for (const entry of errors.slice(0, 20)) {
      console.error(`- ${entry}`);
    }
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
