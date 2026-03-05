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

  // The 18 "new" producers from the scan
  const newProducersEmails = [
    "vertigo2007@hotmail.com",
    "silenic.studio@gmail.com",
    "ilianeper@gmail.com",
    "spyreytos@gmail.com",
    "spyridon.moraitis@klarna.com",
    "spyros.moraitis@wolt.com",
    "djbooker1@yahoo.com",
    "fkarapatsios@gmail.com",
    "zapente@yahoo.com",
    "ponylickstv@gmail.com",
    "vertigo.est2007@gmail.com",
    "rom.pap@gmail.com",
    "jessieonze@proton.me",
    "gennadios.arvanitis@gmail.com",
    "deppytsik78@gmail.com",
    "gsoutos@gmail.com",
    "azemscapes@hotmail.com",
    "nervous.tribe.dj@gmail.com",
  ];

  // Get all Supabase users
  const allSupabaseUsers = new Map<string, any>();
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) throw new Error(`Failed to list users: ${error.message}`);

    const users = data?.users || [];

    for (const user of users) {
      const email = normalizeEmail(user.email ?? "");
      if (email) {
        allSupabaseUsers.set(email, user);
      }
    }

    if (users.length < perPage) break;
    page += 1;
  }

  console.log("\n🔍 Checking if the 18 'new' producers already exist in Supabase:\n");

  let alreadyExist = 0;
  const notInSupabase: string[] = [];

  for (const email of newProducersEmails) {
    const normalizedEmail = normalizeEmail(email);
    const exists = allSupabaseUsers.has(normalizedEmail);

    if (exists) {
      alreadyExist++;
      const user = allSupabaseUsers.get(normalizedEmail);
      console.log(`✅ EXISTS: ${email} (created ${user?.created_at})`);
    } else {
      notInSupabase.push(email);
      console.log(`❌ NOT FOUND: ${email}`);
    }
  }

  console.log(`\n📊 Results: ${alreadyExist}/18 already exist in Supabase`);
  console.log(`📊 Results: ${notInSupabase.length}/18 are truly new\n`);

  if (notInSupabase.length > 0) {
    console.log("The truly new ones are:");
    notInSupabase.forEach((e) => console.log(`  - ${e}`));
  }
}

main().catch(console.error);
