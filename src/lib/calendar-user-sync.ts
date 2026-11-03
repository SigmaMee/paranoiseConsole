import { google } from "googleapis";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { isResidentSlug, toCanonicalResidentSlug } from "@/lib/resident-slug";
import { provisionResidentServices, type ResidentProvisioningResult } from "@/lib/resident-provisioning";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeEmail(email: string | null | undefined) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Parse event name to extract the producer name.
 * Format: producer-name - radio show name
 * Returns the producer-name part
 */
function extractResidentNamesFromEvent(eventTitle: string) {
  const match = eventTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (!match) return null;
  return {
    producerName: match[1].trim(),
    radioShow: match[2].trim(),
  };
}

function isGuestMixEvent(eventTitle: string): boolean {
  return /^guest mix\b/i.test(eventTitle.trim());
}

export type CalendarProducer = {
  email: string;
  producerName: string;
  radioShow: string;
  slug: string;
  fullName: string | null;
  eventTitle: string;
  nextShowStartAt: string;
  slugConflict: string | null;
};

export type CreateUsersResult = {
  scanned: number;
  created: number;
  alreadyExists: number;
  provisioned: number;
  errors: Array<{ email: string; error: string }>;
  provisioning: Array<{
    email: string;
    slug: string;
    result: ResidentProvisioningResult;
  }>;
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
  const scanStartedAt = Date.now();

  for (const event of items) {
    if (event.status === "cancelled") continue;

    const eventTitle = event.summary || "";
    if (isGuestMixEvent(eventTitle)) continue;

    const residentNames = extractResidentNamesFromEvent(eventTitle);
    const showStartAt = event.start?.dateTime || event.start?.date;
    
    if (!residentNames || !showStartAt) continue;

    const attendees = event.attendees ?? [];
    
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email || "");
      if (!email || email.endsWith("@group.calendar.google.com")) continue;

      const existing = producerMap.get(email);
      const candidateTime = new Date(showStartAt).getTime();
      const existingTime = existing ? new Date(existing.nextShowStartAt).getTime() : Number.NaN;
      const candidateIsUpcoming = candidateTime >= scanStartedAt;
      const existingIsUpcoming = Number.isFinite(existingTime) && existingTime >= scanStartedAt;

      if (
        !existing ||
        (candidateIsUpcoming && !existingIsUpcoming) ||
        (candidateIsUpcoming && existingIsUpcoming && candidateTime < existingTime)
      ) {
        producerMap.set(email, {
          email,
          producerName: residentNames.producerName,
          radioShow: residentNames.radioShow,
          slug: toCanonicalResidentSlug(residentNames.producerName),
          fullName: attendee.displayName || null,
          eventTitle,
          nextShowStartAt: new Date(showStartAt).toISOString(),
          slugConflict: null,
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

    const knownEmailByProfileId = new Map<string, string>();
    const candidateEmails = newProducers.map((producer) => producer.email);
    if (candidateEmails.length > 0) {
      const { data: existingProfiles, error: existingProfilesError } = await supabase
        .from("profiles")
        .select("id,producer_email,slug")
        .in("producer_email", candidateEmails);
      if (existingProfilesError) throw existingProfilesError;

      const establishedSlugByEmail = new Map(
        (existingProfiles || [])
          .filter((profile) => profile.slug)
          .map((profile) => [normalizeEmail(profile.producer_email), profile.slug]),
      );
      for (const profile of existingProfiles || []) {
        knownEmailByProfileId.set(profile.id, normalizeEmail(profile.producer_email));
      }
      for (const producer of newProducers) {
        producer.slug = establishedSlugByEmail.get(producer.email) || producer.slug;
      }
    }

    const slugCounts = new Map<string, number>();
    for (const producer of newProducers) {
      slugCounts.set(producer.slug, (slugCounts.get(producer.slug) || 0) + 1);
      if (!isResidentSlug(producer.slug)) {
        producer.slugConflict = "Producer name cannot produce a valid slug";
      }
    }

    const candidateSlugs = [...slugCounts.keys()].filter(Boolean);
    if (candidateSlugs.length > 0) {
      const [profilesResult, residentProfilesResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("id,producer_email,slug")
          .in("slug", candidateSlugs),
        supabase
          .from("resident_profiles")
          .select("profile_id,producer_name,slug")
          .in("slug", candidateSlugs),
      ]);
      const { data: profiles, error: profilesError } = profilesResult;
      if (profilesError) throw profilesError;
      const { data: residentProfiles, error: residentProfilesError } = residentProfilesResult;
      if (residentProfilesError) throw residentProfilesError;

      const ownerBySlug = new Map(
        (profiles || []).map((profile) => [profile.slug, profile.producer_email]),
      );
      const emailByProfileId = new Map(
        [
          ...knownEmailByProfileId,
          ...(profiles || []).map(
            (profile) => [profile.id, normalizeEmail(profile.producer_email)] as const,
          ),
        ],
      );
      const residentOwnerBySlug = new Map(
        (residentProfiles || []).map((profile) => [profile.slug, {
          email: profile.profile_id ? emailByProfileId.get(profile.profile_id) : null,
          name: profile.producer_name,
        }]),
      );
      for (const producer of newProducers) {
        if (producer.slugConflict) continue;
        const existingOwner = ownerBySlug.get(producer.slug);
        const residentOwner = residentOwnerBySlug.get(producer.slug);
        producer.slugConflict = existingOwner && normalizeEmail(existingOwner) !== producer.email
          ? `Already assigned to ${existingOwner}`
          : residentOwner && residentOwner.email !== producer.email
            ? `Already assigned to resident ${residentOwner.name}`
          : (slugCounts.get(producer.slug) || 0) > 1
            ? "Generated for more than one scanned resident"
            : null;
      }
    }
    
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
async function listAllUsersByEmail(supabase: SupabaseClient): Promise<Map<string, User>> {
  const usersByEmail = new Map<string, User>();
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
 * Event format: producer-name - radio show name.
 * Accounts are passwordless and can sign in only through their email address.
 */
export async function createUsersFromCalendar(
  producers: CalendarProducer[],
): Promise<CreateUsersResult> {
  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  // Get existing users
  const existingUsers = await listAllUsersByEmail(supabase);

  const result: CreateUsersResult = {
    scanned: producers.length,
    created: 0,
    alreadyExists: 0,
    provisioned: 0,
    errors: [],
    provisioning: [],
  };

  for (const producer of producers) {
    // Check if user already exists
    if (existingUsers.has(producer.email)) {
      result.alreadyExists++;
      continue;
    }

    const { data: existingProfile, error: existingProfileError } = await supabase
      .from("profiles")
      .select("id,user_id,full_name,slug,ftp_folder_name,centova_playlist_name")
      .eq("producer_email", producer.email)
      .maybeSingle();
    if (existingProfileError) {
      result.errors.push({ email: producer.email, error: existingProfileError.message });
      continue;
    }

    const generatedSlug = toCanonicalResidentSlug(producer.producerName);
    if (existingProfile?.slug && existingProfile.slug !== producer.slug) {
      result.errors.push({
        email: producer.email,
        error: `Reviewed slug "${producer.slug}" no longer matches the established slug "${existingProfile.slug}". Scan again.`,
      });
      continue;
    }
    if (!existingProfile?.slug && generatedSlug !== producer.slug) {
      result.errors.push({
        email: producer.email,
        error: `Reviewed slug "${producer.slug}" no longer matches the generated slug "${generatedSlug}". Scan again.`,
      });
      continue;
    }

    const canonicalSlug = producer.slug;
    const { data: conflictingProfile, error: slugLookupError } = await supabase
      .from("profiles")
      .select("producer_email")
      .eq("slug", canonicalSlug)
      .neq("producer_email", producer.email)
      .maybeSingle();
    if (slugLookupError) {
      result.errors.push({ email: producer.email, error: slugLookupError.message });
      continue;
    }
    if (conflictingProfile) {
      result.errors.push({
        email: producer.email,
        error: `Canonical slug "${canonicalSlug}" is already assigned to ${conflictingProfile.producer_email}.`,
      });
      continue;
    }

    const { data: conflictingResident, error: residentSlugLookupError } = await supabase
      .from("resident_profiles")
      .select("profile_id,producer_name")
      .eq("slug", canonicalSlug)
      .maybeSingle();
    if (residentSlugLookupError) {
      result.errors.push({ email: producer.email, error: residentSlugLookupError.message });
      continue;
    }
    if (conflictingResident && conflictingResident.profile_id !== existingProfile?.id) {
      result.errors.push({
        email: producer.email,
        error: `Canonical slug "${canonicalSlug}" is already assigned to resident ${conflictingResident.producer_name}.`,
      });
      continue;
    }

    const provisioningResult = await provisionResidentServices(
      canonicalSlug,
      producer.nextShowStartAt,
    );
    result.provisioning.push({
      email: producer.email,
      slug: canonicalSlug,
      result: provisioningResult,
    });
    if (!provisioningResult.ftp.success || !provisioningResult.centova.success) {
      result.errors.push({
        email: producer.email,
        error: [provisioningResult.ftp, provisioningResult.centova]
          .filter((step) => !step.success)
          .map((step) => step.message)
          .join(" "),
      });
      continue;
    }
    result.provisioned++;

    const { data, error } = await supabase.auth.admin.createUser({
      email: producer.email,
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

    const profileFullName = producer.fullName || producer.producerName;
    const { data: savedProfile, error: profileError } = await supabase
      .from("profiles")
      .upsert(
        {
          user_id: data.user.id,
          producer_email: producer.email,
          full_name: profileFullName,
          slug: canonicalSlug,
          ftp_folder_name: existingProfile?.ftp_folder_name || canonicalSlug,
          centova_playlist_name: existingProfile?.centova_playlist_name || canonicalSlug,
        },
        {
          onConflict: "producer_email",
        },
      )
      .select("id")
      .single();

    if (profileError) {
      const { error: rollbackError } = await supabase.auth.admin.deleteUser(data.user.id);
      result.errors.push({
        email: producer.email,
        error: rollbackError
          ? `Profile sync failed: ${profileError.message}. Auth rollback also failed: ${rollbackError.message}`
          : `Profile sync failed and the new auth account was rolled back: ${profileError.message}`,
      });
      continue;
    }

    const { error: residentProfileError } = await supabase.from("resident_profiles").upsert(
      {
        profile_id: savedProfile.id,
        slug: canonicalSlug,
        producer_name: producer.producerName,
        radio_show: producer.radioShow,
        show_type: "Recorded",
        webflow_sync_status: "pending",
        webflow_sync_error: null,
      },
      { onConflict: "profile_id" },
    );

    if (residentProfileError) {
      if (existingProfile) {
        await supabase
          .from("profiles")
          .update({
            user_id: existingProfile.user_id,
            full_name: existingProfile.full_name,
            slug: existingProfile.slug,
            ftp_folder_name: existingProfile.ftp_folder_name,
            centova_playlist_name: existingProfile.centova_playlist_name,
          })
          .eq("id", existingProfile.id);
      } else {
        await supabase.from("profiles").delete().eq("id", savedProfile.id);
      }
      const { error: rollbackError } = await supabase.auth.admin.deleteUser(data.user.id);
      result.errors.push({
        email: producer.email,
        error: rollbackError
          ? `Resident profile creation failed: ${residentProfileError.message}. Auth rollback also failed: ${rollbackError.message}`
          : `Resident profile creation failed and the new account was rolled back: ${residentProfileError.message}`,
      });
      continue;
    }

    result.created++;
  }

  return result;
}
