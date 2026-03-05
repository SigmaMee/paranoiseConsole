import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing: ${name}`);
  return value;
}

function normalizeEmail(email: string) {
  return String(email || "").trim().toLowerCase();
}

async function main() {
  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  console.log("🔍 Finding users with unconfirmed email addresses...\n");

  let page = 1;
  const perPage = 200;
  const unconfirmedUsers: any[] = [];

  // Fetch all users
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) throw new Error(`Failed to list users: ${error.message}`);

    const users = data?.users || [];

    for (const user of users) {
      // Check if email is not confirmed
      if (!user.email_confirmed_at) {
        unconfirmedUsers.push(user);
      }
    }

    if (users.length < perPage) break;
    page += 1;
  }

  if (unconfirmedUsers.length === 0) {
    console.log("✅ No users with unconfirmed emails found.\n");
    return;
  }

  console.log(`Found ${unconfirmedUsers.length} users with unconfirmed emails:\n`);
  for (const user of unconfirmedUsers) {
    console.log(`  📧 ${user.email} (created: ${user.created_at})`);
  }

  console.log("\n🗑️  Deleting these users...\n");

  let successful = 0;
  let failed = 0;

  for (const user of unconfirmedUsers) {
    const { error } = await supabase.auth.admin.deleteUser(user.id);

    if (error) {
      console.log(`❌ Failed to delete ${user.email}: ${error.message}`);
      failed++;
    } else {
      console.log(`✅ Deleted: ${user.email}`);
      successful++;
    }
  }

  console.log(`\n📊 Results: ${successful} deleted, ${failed} failed`);
  console.log("\n✨ Now run 'Scan Calendar' in the admin dashboard to recreate them with confirmed emails.\n");
}

main().catch(console.error);
