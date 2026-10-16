import { redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isAdminUser, PRIMARY_ADMIN_EMAIL } from "@/lib/admin-access";
import { signOut } from "@/app/actions";
import { ShowSubmissionToggle } from "@/components/show-submission-toggle";
import CalendarUserSync from "./_client/CalendarUserSync";
import CalendarModule, { type CalendarDay, type CalendarPicture } from "./_client/CalendarModule";
import ActivityLogWrapper from "./ActivityLogWrapper";
import ResidentsModule, { type ResidentRow } from "./_client/ResidentsModule";
import {
  getMostRecentPastAndFutureShowsByProducerEmail,
  getShowsForDate,
  getUpcomingShowsForAllProducers,
} from "@/lib/google-calendar";
import { buildDailyProgrammeCopy } from "@/lib/programme-copy";
import { fileExistsInR2, getSignedR2Url } from "@/lib/r2-utils";
import { audioExistsOnFtp } from "@/lib/ftp-media";
import { getInstagramConnection, type InstagramConnection } from "@/lib/instagram-oauth";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { getProducerCalendarEmails } from "@/lib/producer-identity";
import { listWebflowResidentProfiles } from "@/lib/webflow-api";

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ADMIN_TIME_ZONE = "Europe/Brussels";
const PUBLISH_MONITORING_START = "2026-10-01";

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getMondayIso(value = new Date()) {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return toIsoDate(date);
}

function normalizeWeekIso(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return getMondayIso();
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? getMondayIso() : getMondayIso(parsed);
}

function shiftDateIso(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function formatWeekLabel(startIso: string, endIso: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${formatter.format(new Date(`${startIso}T00:00:00Z`))} – ${formatter.format(new Date(`${endIso}T00:00:00Z`))}`;
}

function titleFromArtworkFilename(filename: string, producerName: string) {
  const producerSlug = producerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const withoutArtworkSuffix = withoutExtension.replace(/-artwork-?\d*$/i, "");
  const withoutProducer = withoutArtworkSuffix.toLowerCase().startsWith(`${producerSlug}-`)
    ? withoutArtworkSuffix.slice(producerSlug.length + 1)
    : withoutArtworkSuffix;
  return withoutProducer
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "Untitled show";
}

function parseCalendarResidentTitle(title: string | undefined) {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle || /^guest mix\b/i.test(trimmedTitle)) return null;
  const separatorMatch = /\s+[-–—]\s+/.exec(trimmedTitle);
  if (!separatorMatch) return { producerName: trimmedTitle, showName: null };
  const producerName = trimmedTitle.slice(0, separatorMatch.index).trim();
  const showName = trimmedTitle.slice(separatorMatch.index + separatorMatch[0].length).trim();
  return producerName && showName ? { producerName, showName } : null;
}

function normalizeResidentGroupingValue(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  const getParam = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : "";

  const driveOauthState = typeof params.drive_oauth === "string" ? params.drive_oauth : "";
  const driveOauthMessage =
    typeof params.drive_oauth_message === "string" ? params.drive_oauth_message : "";
  const mixcloudOauthState = typeof params.mixcloud_oauth === "string" ? params.mixcloud_oauth : "";
  const mixcloudOauthMessage =
    typeof params.mixcloud_oauth_message === "string" ? params.mixcloud_oauth_message : "";
  const instagramOauthState = typeof params.instagram_oauth === "string" ? params.instagram_oauth : "";
  const instagramOauthMessage =
    typeof params.instagram_oauth_message === "string" ? params.instagram_oauth_message : "";
  const weekParam = getParam("week");
  const requestedModule = getParam("module");
  const adminModule = ["calendar", "activity", "residents", "connections"].includes(requestedModule)
    ? requestedModule
    : "calendar";
  const selectedWeekStart = normalizeWeekIso(weekParam);
  const selectedWeekEnd = shiftDateIso(selectedWeekStart, 6);
  const previousWeek = shiftDateIso(selectedWeekStart, -7);
  const nextWeek = shiftDateIso(selectedWeekStart, 7);
  const weekLabel = formatWeekLabel(selectedWeekStart, selectedWeekEnd);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const isAdmin = isAdminUser(user);
  const producerName =
    typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : user.email?.split("@")[0] || "Producer";

  let mostRecentPastShow: { title: string; startsAt: string } | null = null;
  let mostRecentFutureShow: { title: string; startsAt: string } | null = null;

  if (user.email && !isAdmin) {
    try {
      const selection = await getMostRecentPastAndFutureShowsByProducerEmail(
        getProducerCalendarEmails(user),
      );
      mostRecentPastShow = selection.mostRecentPastShow
        ? { title: selection.mostRecentPastShow.title, startsAt: selection.mostRecentPastShow.startsAt }
        : null;
      mostRecentFutureShow = selection.mostRecentFutureShow
        ? { title: selection.mostRecentFutureShow.title, startsAt: selection.mostRecentFutureShow.startsAt }
        : null;
    } catch {}
  }

  let driveConnected = false;
  let driveConnectedAt: string | null = null;
  let driveConnectedBy: string | null = null;
  let mixcloudConnected = false;
  let mixcloudConnectedAt: string | null = null;
  let mixcloudConnectedBy: string | null = null;
  let instagramConnection: InstagramConnection | null = null;
  const scheduledShowsByDate: Record<string, number> = {};
  const calendarShowTitleByKey: Record<string, string> = {};
  const scheduledShowsForWeek: Record<string, Array<{
    title: string;
    startsAt: string;
    endsAt?: string;
    attendeeEmails: string[];
  }>> = {};
  const uploadedShowKeys = new Set<string>();
  let submissionMetadataByShow: Record<string, { description: string; tags: string[] }> = {};
  let calendarProducerNames: Record<string, string> = {};
  let uploadsByDate: Record<string, number> = {};
  let calendarPictures: CalendarPicture[] = [];
  let residentRows: ResidentRow[] = [];
  let activityLogRows: Array<{
    id: string;
    producer: string;
    calendarTitle: string;
    showStartAt: string | null;
    airingDate: string | null;
    hasAudio: boolean;
    hasCoverImage: boolean;
    hasDescription: boolean;
    hasTags: boolean;
    mixcloud: string;
    mixcloudUrl: string | null;
    mixcloudError: string | null;
    webflow: string;
    webflowItemId: string | null;
    webflowError: string | null;
  }> = [];

  if (isAdmin && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      instagramConnection = await getInstagramConnection();
    } catch {}

    if (adminModule === "connections") try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const { data } = await adminSupabase
        .from("google_oauth_tokens")
        .select("provider,updated_at,updated_by_email")
        .eq("provider", "google_drive")
        .maybeSingle();

      if (data?.provider === "google_drive") {
        driveConnected = true;
        driveConnectedAt = data.updated_at || null;
        driveConnectedBy = data.updated_by_email || null;
      }

      const { data: mixcloudData } = await adminSupabase
        .from("google_oauth_tokens")
        .select("provider,updated_at,updated_by_email")
        .eq("provider", "mixcloud")
        .maybeSingle();

      if (mixcloudData?.provider === "mixcloud") {
        mixcloudConnected = true;
        mixcloudConnectedAt = mixcloudData.updated_at || null;
        mixcloudConnectedBy = mixcloudData.updated_by_email || null;
      }
    } catch {}

    if (adminModule === "calendar") try {
      const weekDates = Array.from({ length: 7 }, (_, index) => shiftDateIso(selectedWeekStart, index));
      const showsByDay = await Promise.all(weekDates.map(async (dateIso) => ({
        dateIso,
        shows: await getShowsForDate(dateIso),
      })));
      for (const { dateIso, shows } of showsByDay) {
        scheduledShowsByDate[dateIso] = shows.length;
        scheduledShowsForWeek[dateIso] = shows.map((show) => ({
          title: show.title,
          startsAt: show.startsAt,
          endsAt: show.endsAt,
          attendeeEmails: show.attendeeEmails || [],
        }));
        for (const show of shows) {
          for (const email of show.attendeeEmails || []) {
            calendarShowTitleByKey[`${email.toLowerCase()}|${dateIso}`] = show.title;
          }
        }
      }
    } catch {}

    if (adminModule === "calendar") try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const { data } = await adminSupabase
        .from("submissions")
        .select("id,airing_date,producer_email,image_filename,image_object_key,submitted_description,submitted_tags,show_start_at,created_at")
        .gte("airing_date", selectedWeekStart)
        .lte("airing_date", selectedWeekEnd);

      const scheduledEmails = Object.values(scheduledShowsForWeek).flatMap((shows) => shows.flatMap((show) => show.attendeeEmails));
      const calendarEmails = Array.from(new Set([
        ...(data || []).map((row) => String(row.producer_email || "").toLowerCase()),
        ...scheduledEmails.map((email) => email.toLowerCase()),
      ].filter(Boolean)));
      if (calendarEmails.length > 0) {
        const { data: profiles } = await adminSupabase
          .from("profiles")
          .select("producer_email,full_name")
          .in("producer_email", calendarEmails);
        calendarProducerNames = (profiles || []).reduce<Record<string, string>>((names, profile) => {
          const email = String(profile.producer_email || "").toLowerCase();
          names[email] = String(profile.full_name || profile.producer_email || "Unknown producer");
          return names;
        }, {});
      }

      submissionMetadataByShow = (data || []).reduce<Record<string, { description: string; tags: string[] }>>((metadata, row) => {
        const email = String(row.producer_email || "").toLowerCase();
        const dateIso = typeof row.airing_date === "string" ? row.airing_date : "";
        if (!email || !dateIso) return metadata;
        const key = `${email}|${dateIso}`;
        const existing = metadata[key] || { description: "", tags: [] };
        const description = typeof row.submitted_description === "string" ? row.submitted_description.trim() : "";
        const tags = Array.isArray(row.submitted_tags)
          ? row.submitted_tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())).map((tag) => tag.trim())
          : [];
        metadata[key] = {
          description: existing.description || description,
          tags: Array.from(new Set([...existing.tags, ...tags])),
        };
        return metadata;
      }, {});

      const pictureRows = await Promise.all((data || []).map(async (row): Promise<CalendarPicture | null> => {
        const filename = typeof row.image_filename === "string" ? row.image_filename.trim() : "";
        const dateIso = typeof row.airing_date === "string" ? row.airing_date : "";
        if (!filename || !dateIso || typeof row.id !== "string") return null;
        const email = String(row.producer_email || "").toLowerCase();
        const producer = calendarProducerNames[email] || email || "Unknown producer";
        const metadata = submissionMetadataByShow[`${email}|${dateIso}`] || { description: "", tags: [] };
        const title = calendarShowTitleByKey[`${email}|${dateIso}`] || titleFromArtworkFilename(filename, producer);
        const objectKey = typeof row.image_object_key === "string" ? row.image_object_key.trim() : "";
        const showStartAt = typeof row.show_start_at === "string" ? row.show_start_at : null;
        const createdAt = typeof row.created_at === "string" ? row.created_at : null;
        const imageUrl = objectKey
          ? await getSignedR2Url(objectKey).catch(() => null)
          : null;
        return { id: row.id, dateIso, filename, title, producer, imageUrl, showStartAt, createdAt, ...metadata };
      }));
      calendarPictures = pictureRows
        .filter((picture): picture is CalendarPicture => picture !== null)
        .sort((a, b) =>
          a.dateIso.localeCompare(b.dateIso)
          || (a.showStartAt || "9999").localeCompare(b.showStartAt || "9999")
          || (a.createdAt || "").localeCompare(b.createdAt || "")
          || a.id.localeCompare(b.id),
        );

      // Group by producer_email + airing_date to count unique shows, not individual submissions
      const showKeys = new Set<string>();
      for (const row of data || []) {
        const airingDate = typeof row.airing_date === "string" ? row.airing_date : "";
        const producerEmail = typeof row.producer_email === "string" ? row.producer_email : "";
        if (!airingDate || !producerEmail) {
          continue;
        }
        showKeys.add(`${airingDate}|${producerEmail}`);
        uploadedShowKeys.add(`${producerEmail.toLowerCase()}|${airingDate}`);
      }

      // Count shows per date
      uploadsByDate = {};
      for (const key of showKeys) {
        const [airingDate] = key.split("|");
        uploadsByDate[airingDate] = (uploadsByDate[airingDate] || 0) + 1;
      }
    } catch {}

    if (adminModule === "activity") try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const todayInBrussels = formatInTimeZone(new Date(), ADMIN_TIME_ZONE, "yyyy-MM-dd");
      const currentMonth = todayInBrussels.slice(0, 7);
      const currentMonthStart = fromZonedTime(`${currentMonth}-01T00:00:00`, ADMIN_TIME_ZONE).toISOString();

      // Completed cards are intentionally ephemeral: clear them at the first admin visit
      // after the Brussels calendar month changes. External Mixcloud/Webflow items remain.
      const { error: expiredPublishedError } = await adminSupabase
        .from("submissions")
        .delete()
        .eq("webflow_status", "published")
        .lt("webflow_published_at", currentMonthStart);
      if (expiredPublishedError) throw expiredPublishedError;
      const { error: undatedPublishedError } = await adminSupabase
        .from("submissions")
        .delete()
        .eq("webflow_status", "published")
        .is("webflow_published_at", null);
      if (undatedPublishedError) throw undatedPublishedError;

      const { data: submissions } = await adminSupabase
          .from("submissions")
          .select(
            "id,producer_email,show_start_at,airing_date,audio_filename,audio_object_key,image_filename,submitted_description,submitted_tags,ftp_status,created_at,mixcloud,mixcloud_url,webflow_status,webflow_item_id,webflow_error,webflow_published_at",
          )
          .gte("airing_date", PUBLISH_MONITORING_START)
          .order("airing_date", { ascending: true });

      const activityDates = Array.from(new Set(
        (submissions || []).map((row) => String(row.airing_date || "")).filter(Boolean),
      ));
      try {
        const calendarDays = await Promise.all(activityDates.map(async (dateIso) => ({
          dateIso,
          shows: await getShowsForDate(dateIso),
        })));
        for (const { dateIso, shows } of calendarDays) {
          for (const show of shows) {
            for (const email of show.attendeeEmails || []) {
              calendarShowTitleByKey[`${email.toLowerCase()}|${dateIso}`] = show.title;
            }
          }
        }
      } catch (error) {
        console.error("Could not load calendar titles for Archive cards:", error);
      }

      // The error column is additive. Keep the board functional while the migration
      // is being rolled out, then hydrate durable errors once it exists.
      const submissionIds = (submissions || []).map((row) => String(row.id || "")).filter(Boolean);
      const { data: mixcloudErrorRows } = submissionIds.length > 0
        ? await adminSupabase.from("submissions").select("id,mixcloud_error").in("id", submissionIds)
        : { data: [] };
      const mixcloudErrorById = new Map(
        (mixcloudErrorRows || []).map((row) => [String(row.id), typeof row.mixcloud_error === "string" ? row.mixcloud_error : null]),
      );

      const producerEmails = Array.from(
        new Set(
          (submissions || [])
            .map((row) => String(row.producer_email || "").toLowerCase())
            .filter(Boolean),
        ),
      );

      let producerNameByEmail: Record<string, string> = {};

      if (producerEmails.length > 0) {
        const { data: profiles } = await adminSupabase
          .from("profiles")
          .select("producer_email,full_name")
          .in("producer_email", producerEmails);

        producerNameByEmail = (profiles || []).reduce<Record<string, string>>((acc, row) => {
          const email = String(row.producer_email || "").toLowerCase();
          const fullName = typeof row.full_name === "string" ? row.full_name.trim() : "";
          if (email && fullName) {
            acc[email] = fullName;
          }
          return acc;
        }, {});
      }

      // Group submissions by producer_email + airing_date
      const groupedSubmissions = new Map<string, {
        ids: string[];
        producer: string;
        producerEmail: string;
        showStartAt: string | null;
        airingDate: string | null;
        audioFilename: string | null;
        audioObjectKey: string | null;
        audioDeliverySucceeded: boolean;
        hasCoverImage: boolean;
        hasDescription: boolean;
        hasTags: boolean;
        mixcloudStatuses: string[];
        hasMixcloudUrl: boolean;
        webflowStatuses: string[];
        webflowItemId: string | null;
        webflowError: string | null;
        mixcloudUrl: string | null;
        mixcloudError: string | null;
      }>();

      for (const row of submissions || []) {
        const producerEmail = String(row.producer_email || "").toLowerCase();
        const producer =
          producerNameByEmail[producerEmail] || producerEmail || "Unknown producer";
        const airingDate = typeof row.airing_date === "string" ? row.airing_date : null;
        const showStartAt = typeof row.show_start_at === "string" ? row.show_start_at : null;
        const audioFilename = typeof row.audio_filename === "string" ? row.audio_filename.trim() : "";
        const imageFilename = typeof row.image_filename === "string" ? row.image_filename.trim() : "";
        const submittedDescription = typeof row.submitted_description === "string" ? row.submitted_description.trim() : "";
        const submittedTags = Array.isArray(row.submitted_tags) ? row.submitted_tags : [];
        const submissionId = typeof row.id === "string" ? row.id : "";
        const mixcloudStatus = typeof row.mixcloud === "string" ? row.mixcloud : "not ready";

        const groupKey = `${producerEmail}|${showStartAt || airingDate || "no-date"}`;

        const existing = groupedSubmissions.get(groupKey);
        if (existing) {
          // Aggregate flags across all submissions for this group
          existing.ids.push(submissionId);
          existing.audioFilename ||= audioFilename || null;
          existing.audioObjectKey ||= typeof row.audio_object_key === "string" ? row.audio_object_key : null;
          existing.audioDeliverySucceeded ||= row.ftp_status === "success" && Boolean(audioFilename);
          existing.hasCoverImage = existing.hasCoverImage || Boolean(imageFilename);
          existing.hasDescription ||= Boolean(submittedDescription);
          existing.hasTags ||= submittedTags.some((tag) => typeof tag === "string" && tag.trim());
          existing.mixcloudStatuses.push(mixcloudStatus);
          existing.hasMixcloudUrl = existing.hasMixcloudUrl || Boolean(row.mixcloud_url);
          existing.mixcloudUrl ||= typeof row.mixcloud_url === "string" ? row.mixcloud_url : null;
          existing.mixcloudError ||= mixcloudErrorById.get(submissionId) || null;
          existing.webflowStatuses.push(typeof row.webflow_status === "string" ? row.webflow_status : "not ready");
          existing.webflowItemId ||= typeof row.webflow_item_id === "string" ? row.webflow_item_id : null;
          existing.webflowError ||= typeof row.webflow_error === "string" ? row.webflow_error : null;
        } else {
          groupedSubmissions.set(groupKey, {
            ids: [submissionId],
            producer,
            producerEmail,
            showStartAt,
            airingDate,
            audioFilename: audioFilename || null,
            audioObjectKey: typeof row.audio_object_key === "string" ? row.audio_object_key : null,
            audioDeliverySucceeded: row.ftp_status === "success" && Boolean(audioFilename),
            hasCoverImage: Boolean(imageFilename),
            hasDescription: Boolean(submittedDescription),
            hasTags: submittedTags.some((tag) => typeof tag === "string" && tag.trim()),
            mixcloudStatuses: [mixcloudStatus],
            hasMixcloudUrl: Boolean(row.mixcloud_url),
            mixcloudUrl: typeof row.mixcloud_url === "string" ? row.mixcloud_url : null,
            mixcloudError: mixcloudErrorById.get(submissionId) || null,
            webflowStatuses: [typeof row.webflow_status === "string" ? row.webflow_status : "not ready"],
            webflowItemId: typeof row.webflow_item_id === "string" ? row.webflow_item_id : null,
            webflowError: typeof row.webflow_error === "string" ? row.webflow_error : null,
          });
        }
      }

      // Convert grouped submissions to activity log rows
      const eligibleGroups = Array.from(groupedSubmissions.values()).filter((group) => {
        const websitePublished = group.webflowStatuses.includes("published");
        const mixcloudPublished = group.mixcloudStatuses.includes("published") && group.hasMixcloudUrl;
        if (websitePublished || mixcloudPublished) return true;
        return Boolean(group.airingDate && group.airingDate < todayInBrussels && group.audioFilename);
      });

      const resolvedActivityRows: typeof activityLogRows = [];
      for (const group of eligibleGroups) {
          // Determine overall mixcloud status for the group
          let mixcloudStatus = "not ready";
          
          // If any submission in the group is published, mark as published
          if (group.mixcloudStatuses.includes("published")) {
            mixcloudStatus = "published";
          }
          else if (group.mixcloudStatuses.includes("publishing")) {
            mixcloudStatus = "publishing";
          }
          // A completed delivery is recorded at submission time. Do not hide a
          // past show merely because a later storage presence check is delayed
          // or temporarily unavailable.
          else if (group.audioFilename && (
            group.audioDeliverySucceeded
            || (group.audioObjectKey && await fileExistsInR2(group.audioObjectKey))
            || await audioExistsOnFtp(group.audioFilename, group.producer)
          )) {
            mixcloudStatus = "ready";
          }

          if (!["published", "publishing", "ready"].includes(mixcloudStatus)) continue;

          resolvedActivityRows.push({
            id: group.ids[0], // Use the first ID for bulk actions
            producer: group.producer,
            calendarTitle: calendarShowTitleByKey[`${group.producerEmail}|${group.airingDate || ""}`] || group.producer,
            showStartAt: group.showStartAt,
            airingDate: group.airingDate,
            hasAudio: true,
            hasCoverImage: group.hasCoverImage,
            hasDescription: group.hasDescription,
            hasTags: group.hasTags,
            mixcloud: mixcloudStatus,
            mixcloudUrl: group.mixcloudUrl,
            mixcloudError: group.mixcloudError,
            webflow: group.webflowStatuses.includes("published")
              ? "published"
              : group.webflowStatuses.includes("publishing")
                ? "publishing"
                : group.webflowStatuses.includes("failed")
                  ? "failed"
                  : mixcloudStatus === "published" && group.hasCoverImage && group.hasMixcloudUrl
                    ? "ready"
                    : "not ready",
            webflowItemId: group.webflowItemId,
            webflowError: group.webflowError,
          });
        }
      activityLogRows = resolvedActivityRows;
    } catch {}

    if (adminModule === "residents") try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );
      const { data: profiles, error: profilesError } = await adminSupabase
        .from("profiles")
        .select("id,producer_email,full_name")
        .order("full_name");
      if (profilesError) throw profilesError;

      const authUsers = [];
      for (let page = 1; ; page += 1) {
        const { data, error } = await adminSupabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        authUsers.push(...data.users);
        if (data.users.length < 1000) break;
      }

      const emailsByCanonical = new Map<string, Set<string>>();
      for (const authUser of authUsers) {
        const email = authUser.email?.trim().toLowerCase();
        const canonical = typeof authUser.app_metadata?.producer_email === "string"
          ? authUser.app_metadata.producer_email.trim().toLowerCase()
          : email;
        if (!canonical || !email) continue;
        const emails = emailsByCanonical.get(canonical) || new Set<string>();
        emails.add(canonical);
        emails.add(email);
        emailsByCanonical.set(canonical, emails);
      }

      let upcomingShows: Awaited<ReturnType<typeof getUpcomingShowsForAllProducers>> = [];
      let webflowResidents: Awaited<ReturnType<typeof listWebflowResidentProfiles>> = [];
      const [calendarResult, webflowResult] = await Promise.allSettled([
        getUpcomingShowsForAllProducers(),
        listWebflowResidentProfiles(),
      ]);
      if (calendarResult.status === "fulfilled") upcomingShows = calendarResult.value;
      else console.error("Could not load Calendar profiles for Residents:", calendarResult.reason);
      if (webflowResult.status === "fulfilled") webflowResidents = webflowResult.value;
      else console.error("Could not load Webflow profiles for Residents:", webflowResult.reason);
      const webflowResidentByName = new Map(
        webflowResidents.map((profile) => [normalizeResidentGroupingValue(profile.name), profile]),
      );

      const mappedResidents = (profiles || []).filter((profile) =>
        String(profile.producer_email || "").trim().toLowerCase() !== PRIMARY_ADMIN_EMAIL,
      ).map((profile) => {
        const canonicalEmail = String(profile.producer_email || "").trim().toLowerCase();
        const emails = Array.from(emailsByCanonical.get(canonicalEmail) || new Set([canonicalEmail]))
          .filter((email) => Boolean(email) && email !== PRIMARY_ADMIN_EMAIL)
          .sort();
        const knownEmails = new Set(emails);
        const nextShow = upcomingShows.find((show) =>
          (show.attendeeEmails || []).some((email) => knownEmails.has(email.toLowerCase())),
        );
        const calendarTitle = parseCalendarResidentTitle(nextShow?.title);
        const producerName = calendarTitle?.producerName || String(profile.full_name || canonicalEmail || "Unknown resident");
        const webflowProfile = webflowResidentByName.get(normalizeResidentGroupingValue(producerName));

        return {
          groupKey: `producer:${normalizeResidentGroupingValue(producerName)}`,
          id: String(profile.id),
          producerName,
          showName: calendarTitle ? calendarTitle.showName : nextShow?.title || null,
          showType: "Recorded" as const,
          emails,
          webflowProfilePictureUrl: webflowProfile?.profilePictureUrl || null,
          webflowProfilePictureAlt: webflowProfile?.profilePictureAlt || null,
          webflowRadioShow: webflowProfile?.radioShow || null,
          webflowCity: webflowProfile?.city || null,
          webflowAbout: webflowProfile?.about || null,
          webflowFollowLink: webflowProfile?.followLink || null,
        };
      });

      const groupedResidents = new Map<string, ResidentRow>();
      for (const resident of mappedResidents) {
        const existing = groupedResidents.get(resident.groupKey);
        if (existing) {
          existing.emails = Array.from(new Set([...existing.emails, ...resident.emails])).sort();
          if (!existing.showName && resident.showName) existing.showName = resident.showName;
          continue;
        }
        groupedResidents.set(resident.groupKey, {
          id: resident.id,
          producerName: resident.producerName,
          showName: resident.showName,
          showType: resident.showType,
          emails: resident.emails,
          webflowProfilePictureUrl: resident.webflowProfilePictureUrl,
          webflowProfilePictureAlt: resident.webflowProfilePictureAlt,
          webflowRadioShow: resident.webflowRadioShow,
          webflowCity: resident.webflowCity,
          webflowAbout: resident.webflowAbout,
          webflowFollowLink: resident.webflowFollowLink,
        });
      }
      residentRows = Array.from(groupedResidents.values()).sort((first, second) =>
        first.producerName.localeCompare(second.producerName),
      );
    } catch (error) {
      console.error("Could not load Residents:", error);
    }
  }

  const todayIsoDate = new Date().toISOString().slice(0, 10);
  const programmeCopyByDate = Object.entries(scheduledShowsForWeek).reduce<Record<string, string>>(
    (copies, [dateIso, shows]) => {
      if (shows.length === 0 || shows.some((show) => !show.endsAt)) return copies;

      try {
        const copy = buildDailyProgrammeCopy(shows.map((show) => ({
          calendarTitle: show.title,
          startsAt: show.startsAt,
          endsAt: show.endsAt as string,
          tags: show.attendeeEmails.flatMap((email) =>
            submissionMetadataByShow[`${email.toLowerCase()}|${dateIso}`]?.tags || [],
          ),
        })));
        if (copy) copies[dateIso] = copy;
      } catch {}
      return copies;
    },
    {},
  );

  const coverageDays: CalendarDay[] = Array.from({ length: 7 }, (_, index) => {
    const dateIso = shiftDateIso(selectedWeekStart, index);
    const dayNumber = Number(dateIso.slice(-2));
    const scheduledCount = scheduledShowsByDate[dateIso] || 0;
    const uploadCount = uploadsByDate[dateIso] || 0;
    const isFutureDay = dateIso > todayIsoDate;

    const status: CalendarDay["status"] = isFutureDay
      ? "future"
      : scheduledCount === 0
        ? "none"
        : uploadCount === 0
          ? "zero"
          : uploadCount >= scheduledCount
            ? "full"
            : "partial";

    return {
      dateIso,
      dayNumber,
      dayLabel: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${dateIso}T00:00:00Z`)),
      scheduledCount,
      uploadCount,
      status,
      missingShows: (scheduledShowsForWeek[dateIso] || []).flatMap((show) => {
        const uploadedEmail = show.attendeeEmails.find((email) => uploadedShowKeys.has(`${email.toLowerCase()}|${dateIso}`));
        if (uploadedEmail) return [];
        const producerEmail = show.attendeeEmails.find((email) =>
          calendarProducerNames[email.toLowerCase()] && email.toLowerCase() !== user.email?.toLowerCase(),
        );
        return [{
          title: show.title,
          producer: producerEmail
            ? calendarProducerNames[producerEmail.toLowerCase()]
            : show.title.trim().toLowerCase().startsWith("guest mix")
              ? ""
              : "Unassigned producer",
        }];
      }),
    };
  });

  return (
    <main className="dashboard-screen">
      <div className="dashboard-shell">
        <section className="dashboard-panel">
          <div className="dashboard-header-row">
            <div className="dashboard-brand-group">
              <Image
                src="/branding/navbar-logo.png"
                alt="Paranoise Radio"
                width={256}
                height={55}
                className="dashboard-logo"
                priority
              />
              <p className="dashboard-overline">Console</p>
            </div>
            <div className="dashboard-account">
              <span>{producerName}</span>
              <form action={signOut}>
                <button className="btn-neutral" type="submit">Sign out</button>
              </form>
            </div>
          </div>
        </section>

        {!isAdmin ? (
          <ShowSubmissionToggle
            mostRecentPastShow={mostRecentPastShow}
            mostRecentFutureShow={mostRecentFutureShow}
          />
        ) : null}

        {isAdmin ? (
          <>
            <nav className="dashboard-module-nav" aria-label="Admin modules">
              {[
                ["calendar", "ON AIR"],
                ["activity", "ARCHIVE"],
                ["residents", "Residents"],
                ["connections", "Connections"],
              ].map(([key, label]) => (
                <Link
                  key={key}
                  href={`/dashboard?module=${key}${key === "calendar" ? `&week=${selectedWeekStart}` : ""}`}
                  className={adminModule === key ? "dashboard-module-link dashboard-module-link-active" : "dashboard-module-link"}
                  aria-current={adminModule === key ? "page" : undefined}
                >
                  {label}
                </Link>
              ))}
            </nav>

            <section
              className={`dashboard-panel ${adminModule === "calendar" ? "dashboard-calendar-panel" : ""}`}
              aria-label={adminModule === "calendar" ? "Upload calendar" : undefined}
            >
              {adminModule === "calendar" ? (
                <>
                  <div className="dashboard-module-heading">
                    <form method="get" className="dashboard-month-navigation">
                      <input type="hidden" name="module" value="calendar" />
                      <button className="btn-tertiary dashboard-week-button" type="submit" name="week" value={previousWeek} aria-label="Previous week">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                      </button>
                      <div className="dashboard-month-group">
                        <p className="muted dashboard-month-label">{weekLabel}</p>
                        <button className="dashboard-month-reset" type="submit">Current week</button>
                      </div>
                      <button className="btn-tertiary dashboard-week-button" type="submit" name="week" value={nextWeek} aria-label="Next week">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                      </button>
                    </form>
                  </div>
                  <CalendarModule
                    days={coverageDays}
                    pictures={calendarPictures}
                    programmeCopyByDate={programmeCopyByDate}
                    instagramConnected={instagramConnection?.status === "connected"}
                  />
                </>
              ) : null}

              {adminModule === "activity" ? (
                <ActivityLogWrapper rows={activityLogRows} />
              ) : null}

              {adminModule === "residents" ? (
                <ResidentsModule rows={residentRows} />
              ) : null}

              {adminModule === "connections" ? (
                <div className="dashboard-connections">
                  <section>
                    <h2 className="dashboard-section-title">Google Drive</h2>
                    <p className="muted">Reconnect Google Drive here if submissions stop syncing.</p>
                    <a className="dashboard-connect" href="/api/google-drive/oauth/start">Connect Google Drive</a>
                    {driveConnected ? <p className="dashboard-connection-status">Connected {driveConnectedAt ? `on ${new Date(driveConnectedAt).toLocaleString("en-GB")}` : ""}{driveConnectedBy ? ` by ${driveConnectedBy}` : ""}.</p> : null}
                    {driveOauthState ? <p className={driveOauthState === "ok" ? "success" : "error"}>{driveOauthMessage || (driveOauthState === "ok" ? "Google Drive connected successfully." : "Google Drive connection failed.")}</p> : null}
                  </section>
                  <section>
                    <h2 className="dashboard-section-title">Mixcloud</h2>
                    <p className="muted">Connect Mixcloud for publishing from the activity module.</p>
                    <a className="dashboard-connect" href="/api/mixcloud/oauth/start">Connect Mixcloud</a>
                    {mixcloudConnected ? <p className="dashboard-connection-status">Connected {mixcloudConnectedAt ? `on ${new Date(mixcloudConnectedAt).toLocaleString("en-GB")}` : ""}{mixcloudConnectedBy ? ` by ${mixcloudConnectedBy}` : ""}.</p> : null}
                    {mixcloudOauthState ? <p className={mixcloudOauthState === "ok" ? "success" : "error"}>{mixcloudOauthMessage || (mixcloudOauthState === "ok" ? "Mixcloud connected successfully." : "Mixcloud connection failed.")}</p> : null}
                  </section>
                  <section>
                    <h2 className="dashboard-section-title">Instagram</h2>
                    <p className="muted">Connect the Paranoise professional account to publish calendar carousels.</p>
                    <a className="dashboard-connect" href="/api/instagram/oauth/start">
                      {instagramConnection?.status === "connected" ? "Reconnect Instagram" : "Connect Instagram"}
                    </a>
                    {instagramConnection?.status === "connected" ? (
                      <>
                        <p className="dashboard-connection-status">
                          Connected to @{instagramConnection.accountUsername || instagramConnection.accountId}
                          {instagramConnection.pageName ? ` through ${instagramConnection.pageName}` : ""}
                          {instagramConnection.connectedAt ? ` on ${new Date(instagramConnection.connectedAt).toLocaleString("en-GB")}` : ""}
                          {instagramConnection.connectedByEmail ? ` by ${instagramConnection.connectedByEmail}` : ""}.
                        </p>
                        <form action="/api/instagram/disconnect" method="post">
                          <button className="btn-neutral" type="submit">Disconnect Instagram</button>
                        </form>
                      </>
                    ) : instagramConnection ? (
                      <p className="dashboard-connection-status">Instagram is {instagramConnection.status.replace("_", " ")}.</p>
                    ) : null}
                    {instagramOauthState ? (
                      <p className={instagramOauthState === "ok" ? "success" : "error"} role="status">
                        {instagramOauthMessage || (instagramOauthState === "ok" ? "Instagram connected successfully." : "Instagram connection failed.")}
                      </p>
                    ) : null}
                  </section>
                  <CalendarUserSync />
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
