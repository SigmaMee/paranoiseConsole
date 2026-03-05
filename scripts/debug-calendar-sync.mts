import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import dotenv from "dotenv";

// Load .env.local
dotenv.config({ path: ".env.local" });

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeEmail(email: string) {
  return String(email || "").trim().toLowerCase();
}

function extractProducerNameFromEvent(eventTitle: string): string | null {
  const match = eventTitle.match(/^([^-]+)\s*-/);
  if (!match) return null;
  return match[1].trim();
}

async function main() {
  console.log("🔍 Debugging Calendar Sync...\n");

  // Get calendar events
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );
  const calendarId = getRequiredEnv("GOOGLE_CALENDAR_ID");

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0).toISOString();
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 3, 0, 23, 59, 59, 999).toISOString();

  const response = await calendar.events.list({
    calendarId,
    timeMin: windowStart,
    timeMax: windowEnd,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 1000,
  });

  const items = response.data.items ?? [];
  const producerMap = new Map<string, { email: string; password: string; eventTitle: string }>();

  for (const event of items) {
    if (event.status === "cancelled") continue;

    const eventTitle = event.summary || "";
    const producerName = extractProducerNameFromEvent(eventTitle);

    if (!producerName) continue;

    const attendees = event.attendees ?? [];

    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email || "");
      if (!email || email.endsWith("@group.calendar.google.com")) continue;

      if (!producerMap.has(email)) {
        producerMap.set(email, {
          email,
          password: producerName,
          eventTitle,
        });
      }
    }
  }

  console.log(`📅 Found ${producerMap.size} total producers in calendar\n`);

  // Get existing users from Supabase
  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  const allSupabaseUsers = new Map<string, any>();
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      throw new Error(`Failed to list auth users: ${error.message}`);
    }

    const users = data?.users || [];

    for (const user of users) {
      const email = normalizeEmail(user.email ?? "");
      if (email) {
        allSupabaseUsers.set(email, user);
      }
    }

    if (users.length < perPage) {
      break;
    }

    page += 1;
  }

  console.log(`👥 Found ${allSupabaseUsers.size} existing users in Supabase auth\n`);

  // Compare each producer
  const newProducers: Array<{ email: string; password: string; eventTitle: string }> = [];
  const existingProducers: Array<{ email: string; password: string; eventTitle: string }> = [];

  for (const producer of producerMap.values()) {
    if (allSupabaseUsers.has(producer.email)) {
      existingProducers.push(producer);
    } else {
      newProducers.push(producer);
    }
  }

  console.log(`✅ New producers: ${newProducers.length}`);
  console.log(`❌ Already existing: ${existingProducers.length}\n`);

  console.log("🆕 NEW PRODUCERS:");
  for (const producer of newProducers) {
    console.log(`  ${producer.email} | Password: ${producer.password} | Event: "${producer.eventTitle}"`);
  }

  console.log("\n⚠️  ALREADY EXISTING (should have been filtered out):");
  for (const producer of existingProducers) {
    const supabaseUser = allSupabaseUsers.get(producer.email);
    console.log(
      `  ${producer.email} | Password: ${producer.password} | Event: "${producer.eventTitle}" | Created: ${supabaseUser?.created_at}`,
    );
  }
}

main().catch(console.error);
