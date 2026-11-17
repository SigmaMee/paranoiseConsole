import { NextResponse } from "next/server";
import { formatInTimeZone } from "date-fns-tz";
import { getShowsForDate } from "@/lib/google-calendar";
import { sendShowReminderEmail } from "@/lib/email";
import { createReminderToken, getReminderAdminClient } from "@/lib/show-reminders";

export const runtime = "nodejs";
export const maxDuration = 60;

const ATHENS_TZ = "Europe/Athens";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret && request.headers.get("authorization")?.trim() === `Bearer ${secret}`);
}

function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://console.paranoiseradio.com").replace(/\/$/, "");
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

async function hasAnySubmission(producerEmail: string, showStartAt: string) {
  const admin = getReminderAdminClient();
  const airingDate = formatInTimeZone(new Date(showStartAt), ATHENS_TZ, "yyyy-MM-dd");
  const [{ data: submissions, error: submissionsError }, { data: slots, error: slotsError }] = await Promise.all([
    admin.from("submissions").select("audio_filename,image_filename,submitted_description,submitted_tags")
      .ilike("producer_email", producerEmail).eq("airing_date", airingDate),
    admin.from("submission_slots").select("audio_submitted_at,image_submitted_at")
      .ilike("producer_email", producerEmail).eq("show_start_at", showStartAt),
  ]);
  if (submissionsError || slotsError) throw new Error(submissionsError?.message || slotsError?.message);
  return (slots ?? []).some((row) => row.audio_submitted_at || row.image_submitted_at)
    || (submissions ?? []).some((row) => hasText(row.audio_filename) || hasText(row.image_filename)
      || hasText(row.submitted_description) || (Array.isArray(row.submitted_tags) && row.submitted_tags.length > 0));
}

async function residentByCalendarEmail() {
  const admin = getReminderAdminClient();
  const { data: profiles, error } = await admin.from("profiles").select("producer_email");
  if (error) throw new Error(`Could not read residents: ${error.message}`);
  const residents = new Map<string, { producerEmail: string; recipientEmail: string }>();
  for (const profile of profiles ?? []) {
    if (!hasText(profile.producer_email)) continue;
    const email = profile.producer_email.trim().toLowerCase();
    residents.set(email, { producerEmail: email, recipientEmail: email });
  }
  for (let page = 1; ; page += 1) {
    const { data, error: usersError } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (usersError) throw new Error(`Could not read resident logins: ${usersError.message}`);
    for (const user of data.users) {
      const login = user.email?.trim().toLowerCase();
      const canonical = typeof user.app_metadata?.producer_email === "string"
        ? user.app_metadata.producer_email.trim().toLowerCase() : login;
      if (login && canonical && residents.has(canonical)) {
        residents.set(login, { producerEmail: canonical, recipientEmail: login });
      }
    }
    if (data.users.length < 1000) break;
  }
  return residents;
}

export async function deliverShowReminders(now = new Date()) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dateIso = formatInTimeZone(tomorrow, ATHENS_TZ, "yyyy-MM-dd");
  const [shows, residents] = await Promise.all([getShowsForDate(dateIso), residentByCalendarEmail()]);
  const admin = getReminderAdminClient();
  const results: Array<{ eventId: string; status: string }> = [];

  for (const show of shows) {
    const resident = (show.attendeeEmails ?? []).map((email) => residents.get(email.toLowerCase())).find(Boolean);
    if (!resident || await hasAnySubmission(resident.producerEmail, show.startsAt)) {
      results.push({ eventId: show.id, status: "skipped" });
      continue;
    }
    const { data: existing } = await admin.from("show_reminder_deliveries").select("id,delivery_status")
      .eq("calendar_event_id", show.id).eq("producer_email", resident.producerEmail).maybeSingle();
    if (existing?.delivery_status === "sent") {
      results.push({ eventId: show.id, status: "already_sent" });
      continue;
    }

    const { token, tokenHash } = createReminderToken();
    const values = {
      calendar_event_id: show.id,
      producer_email: resident.producerEmail,
      recipient_email: resident.recipientEmail,
      show_title: show.title,
      show_start_at: show.startsAt,
      token_hash: tokenHash,
      expires_at: show.startsAt,
      delivery_status: "pending",
      updated_at: now.toISOString(),
      error_message: null,
    };
    const write = existing
      ? admin.from("show_reminder_deliveries").update(values).eq("id", existing.id)
      : admin.from("show_reminder_deliveries").insert(values);
    const { error: writeError } = await write;
    if (writeError) throw new Error(`Could not reserve reminder delivery: ${writeError.message}`);

    try {
      await sendShowReminderEmail({
        to: resident.recipientEmail,
        showTitle: show.title,
        showStartAt: show.startsAt,
        accessUrl: `${siteUrl()}/reminder/${encodeURIComponent(token)}`,
      });
      await admin.from("show_reminder_deliveries").update({ delivery_status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("calendar_event_id", show.id).eq("producer_email", resident.producerEmail);
      results.push({ eventId: show.id, status: "sent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown delivery failure";
      await admin.from("show_reminder_deliveries").update({ delivery_status: "failed", error_message: message, updated_at: new Date().toISOString() })
        .eq("calendar_event_id", show.id).eq("producer_email", resident.producerEmail);
      results.push({ eventId: show.id, status: "failed" });
    }
  }
  return NextResponse.json({ date: dateIso, results });
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (formatInTimeZone(new Date(), ATHENS_TZ, "HH:mm") !== "09:00") {
    return NextResponse.json({ skipped: true, reason: "Outside the 09:00 Greece-time window" });
  }
  return deliverShowReminders();
}
