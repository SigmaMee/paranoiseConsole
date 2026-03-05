import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

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

/**
 * Parse event name to extract producer name (password)
 * Format: producer-name - radio show name
 * Returns the producer-name part
 */
function extractProducerNameFromEvent(eventTitle: string): string | null {
  const match = eventTitle.match(/^([^-]+)\s*-/);
  if (!match) return null;
  return match[1].trim();
}

function isGuestMixEvent(eventTitle: string): boolean {
  return /^guest mix\b/i.test(eventTitle.trim());
}

export type CalendarProducer = {
  email: string;
  password: string;
  fullName: string | null;
  eventTitle: string;
};

export type CreateUsersResult = {
  scanned: number;
  created: number;
  alreadyExists: number;
  errors: Array<{ email: string; error: string }>;
};

/**
 * Scan calendar for events and extract producer information
 * Filters out producers who already have auth accounts
 */
export async function scanCalendarForProducers(): Promise<CalendarProducer[]> {
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
  
  // Scan from 3 months ago to 2 months in the future
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
  const producerMap = new Map<string, CalendarProducer>();

  for (const event of items) {
    if (event.status === "cancelled") continue;

    const eventTitle = event.summary || "";
    if (isGuestMixEvent(eventTitle)) continue;

    const producerName = extractProducerNameFromEvent(eventTitle);
    
    if (!producerName) continue;

    const attendees = event.attendees ?? [];
    
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email || "");
      if (!email || email.endsWith("@group.calendar.google.com")) continue;

      // Use email as unique key to avoid duplicates
      if (!producerMap.has(email)) {
        producerMap.set(email, {
          email,
          password: producerName,
          fullName: attendee.displayName || null,
          eventTitle,
        });
      }
    }
  }

  // Filter out users who already exist
  try {
    const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
    const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = createClient(supabaseUrl, serviceRole);

    const existingUsers = await listAllUsersByEmail(supabase);
    console.log(`[Calendar Sync] Found ${existingUsers.size} existing auth users`);
    
    const newProducers = Array.from(producerMap.values()).filter((producer) => {
      const exists = existingUsers.has(producer.email);
      if (exists) {
        console.log(`[Calendar Sync] Filtering out existing user: ${producer.email}`);
      }
      return !exists;
    });
    
    console.log(`[Calendar Sync] Returning ${newProducers.length} new producers (from ${producerMap.size} total)`);
    return newProducers;
  } catch (error) {
    console.error("[Calendar Sync] Error filtering existing users:", error);
    // If filtering fails, return all producers (safer than returning empty list)
    return Array.from(producerMap.values());
  }
}

/**
 * List all existing auth users by email
 */
async function listAllUsersByEmail(supabase: any): Promise<Map<string, any>> {
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

/**
 * Create auth users from calendar events
 * Event format: producer-name - radio show name
 * Password is derived from producer-name
 */
export async function createUsersFromCalendar(): Promise<CreateUsersResult> {
  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  // Scan calendar for producers
  const producers = await scanCalendarForProducers();

  // Get existing users
  const existingUsers = await listAllUsersByEmail(supabase);

  const result: CreateUsersResult = {
    scanned: producers.length,
    created: 0,
    alreadyExists: 0,
    errors: [],
  };

  for (const producer of producers) {
    // Check if user already exists
    if (existingUsers.has(producer.email)) {
      result.alreadyExists++;
      continue;
    }

    // Create user with derived password
    const { data, error } = await supabase.auth.admin.createUser({
      email: producer.email,
      password: producer.password,
      email_confirm: true,
      user_metadata: {
        full_name: producer.fullName || producer.email.split("@")[0],
      },
    });

    if (error || !data?.user) {
      result.errors.push({
        email: producer.email,
        error: error?.message || "Unknown error",
      });
      continue;
    }

    result.created++;
  }

  return result;
}
