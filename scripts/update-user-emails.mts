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

// Define the email updates here as [oldEmail, newEmail]
const emailUpdates: [string, string][] = [
  // Example:
  // ["old@example.com", "new@example.com"],
];

async function main() {
  if (emailUpdates.length === 0) {
    console.log("❌ No email updates defined. Add mappings to emailUpdates variable.");
    process.exit(1);
  }

  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  console.log(`\n🔄 Updating ${emailUpdates.length} user emails...\n`);

  let successful = 0;
  let failed = 0;

  for (const [oldEmail, newEmail] of emailUpdates) {
    const normalizedOld = normalizeEmail(oldEmail);
    const normalizedNew = normalizeEmail(newEmail);

    // Get user by old email
    const { data: listData, error: listError } = await supabase.auth.admin.listUsers();
    const user = listData?.users?.find((u) => normalizeEmail(u.email ?? "") === normalizedOld);

    if (!user) {
      console.log(`❌ User not found: ${oldEmail}`);
      failed++;
      continue;
    }

    // Update email
    const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
      email: normalizedNew,
      email_confirm: true, // Auto-confirm the new email
    });

    if (error) {
      console.log(`❌ Failed to update ${oldEmail} → ${newEmail}: ${error.message}`);
      failed++;
    } else {
      console.log(`✅ Updated: ${oldEmail} → ${normalizedNew}`);
      successful++;
    }
  }

  console.log(`\n📊 Results: ${successful} successful, ${failed} failed\n`);
}

main().catch(console.error);
