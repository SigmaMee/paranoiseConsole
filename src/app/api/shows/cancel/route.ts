import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getProducerCalendarEmails, getProducerEmail } from "@/lib/producer-identity";
import { deleteCalendarShowOccurrence, getCalendarShowOccurrenceById } from "@/lib/google-calendar";
import { revokeReminderAccess } from "@/lib/show-reminders";

export const runtime = "nodejs";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Cancellation audit storage is not configured.");
  return createAdminClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function writeAudit(values: Record<string, unknown>) {
  const { error } = await getAdminClient().from("show_cancellation_events").insert(values);
  if (error) throw new Error(`Could not record show cancellation: ${error.message}`);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as { eventId?: unknown } | null;
  const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
  if (!eventId || eventId.length > 1024) {
    return NextResponse.json({ error: "A valid show occurrence is required." }, { status: 400 });
  }

  const actorEmail = user.email.toLowerCase();
  const producerEmail = getProducerEmail(user);
  const admin = getAdminClient();
  const { data: prior } = await admin.from("show_cancellation_events").select("id")
    .eq("calendar_event_id", eventId).eq("producer_email", producerEmail)
    .eq("outcome", "cancelled").limit(1).maybeSingle();
  if (prior) return NextResponse.json({ message: "This show occurrence was already cancelled." });

  try {
    const show = await getCalendarShowOccurrenceById(eventId);
    if (!show) return NextResponse.json({ error: "This show occurrence is no longer available." }, { status: 404 });
    const allowedEmails = new Set(getProducerCalendarEmails(user));
    const isAttendee = show.attendeeEmails.some((email) => allowedEmails.has(email.toLowerCase()));
    const startsAt = new Date(show.startsAt);

    // Expanded recurring occurrences use their concrete occurrence ID. Series masters carry
    // a recurrence rule and must never reach the delete call.
    const isConcreteOccurrence = Boolean(show.startsAt) && !/^\d{4}-\d{2}-\d{2}$/.test(show.startsAt);
    if (!isAttendee || !isConcreteOccurrence || show.isSeriesMaster || show.status === "cancelled") {
      await writeAudit({ calendar_event_id: eventId, recurring_event_id: show.recurringEventId, producer_email: producerEmail, actor_email: actorEmail, show_start_at: show.startsAt || null, show_title: show.title, outcome: "rejected", error_message: "Not an authorized concrete occurrence." });
      return NextResponse.json({ error: "You cannot cancel this show occurrence." }, { status: 403 });
    }
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "Only future show occurrences can be cancelled." }, { status: 409 });
    }

    await deleteCalendarShowOccurrence(eventId);
    await writeAudit({ calendar_event_id: eventId, recurring_event_id: show.recurringEventId, producer_email: producerEmail, actor_email: actorEmail, show_start_at: show.startsAt, show_title: show.title, outcome: "cancelled" });
    await revokeReminderAccess(producerEmail, show.startsAt);
    return NextResponse.json({ message: "This show occurrence has been cancelled." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown cancellation error";
    try {
      await writeAudit({ calendar_event_id: eventId, producer_email: producerEmail, actor_email: actorEmail, outcome: "error", error_message: message });
    } catch (auditError) {
      console.error("Failed to persist cancellation failure audit", auditError);
    }
    console.error("Show occurrence cancellation failed", { eventId, actorEmail, message });
    return NextResponse.json({ error: "The show could not be cancelled. Please try again." }, { status: 502 });
  }
}
