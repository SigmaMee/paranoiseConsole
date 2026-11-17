import { NextResponse } from "next/server";
import { findActiveReminder, getReminderAdminClient } from "@/lib/show-reminders";

export async function POST(request: Request) {
  const form = await request.formData();
  const token = typeof form.get("token") === "string" ? String(form.get("token")) : "";
  const intent = form.get("intent") === "cancel" ? "cancel" : "submit";
  const reminder = await findActiveReminder(token);
  if (!reminder) return NextResponse.redirect(new URL("/login?reminder=expired", request.url), 303);

  const admin = getReminderAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: reminder.recipient_email });
  if (error || !data.properties?.hashed_token) {
    console.error("Could not create reminder sign-in link", { reminderId: reminder.id, error: error?.message });
    return NextResponse.redirect(new URL(`/reminder/${encodeURIComponent(token)}?error=signin`, request.url), 303);
  }
  const next = intent === "cancel"
    ? `/dashboard?cancel_show=${encodeURIComponent(reminder.calendar_event_id)}`
    : "/dashboard?show_selection=future";
  const confirm = new URL("/auth/confirm", request.url);
  confirm.searchParams.set("token_hash", data.properties.hashed_token);
  confirm.searchParams.set("type", "magiclink");
  confirm.searchParams.set("next", next);
  return NextResponse.redirect(confirm, 303);
}
