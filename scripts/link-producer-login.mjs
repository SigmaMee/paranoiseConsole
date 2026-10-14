import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
};

async function findUserByEmail(supabase, targetEmail) {
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = (data.users || []).find((user) => normalizeEmail(user.email) === targetEmail);
    if (match) return match;
    if ((data.users || []).length < 200) return null;
    page += 1;
  }
}

async function run() {
  const aliasEmail = normalizeEmail(process.argv[2]);
  const canonicalEmail = normalizeEmail(process.argv[3]);
  if (!aliasEmail || !canonicalEmail) {
    throw new Error("Usage: node scripts/link-producer-login.mjs <login-email> <canonical-producer-email>");
  }

  const supabase = createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
  );
  const canonicalUser = await findUserByEmail(supabase, canonicalEmail);
  if (!canonicalUser) throw new Error(`Canonical Auth user not found: ${canonicalEmail}`);

  let aliasUser = await findUserByEmail(supabase, aliasEmail);
  if (!aliasUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: aliasEmail,
      email_confirm: true,
      app_metadata: { producer_email: canonicalEmail },
      user_metadata: canonicalUser.user_metadata,
    });
    if (error || !data.user) throw error || new Error("Auth user creation returned no user.");
    aliasUser = data.user;
  } else {
    const { data, error } = await supabase.auth.admin.updateUserById(aliasUser.id, {
      app_metadata: { ...aliasUser.app_metadata, producer_email: canonicalEmail },
    });
    if (error || !data.user) throw error || new Error("Auth user update returned no user.");
    aliasUser = data.user;
  }

  console.log(`Linked ${aliasUser.email} to producer account ${canonicalEmail}.`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
