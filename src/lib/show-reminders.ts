import { createHash, randomBytes } from "node:crypto";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export function hashReminderToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createReminderToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashReminderToken(token) };
}

export function getReminderAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Reminder storage is not configured.");
  return createAdminClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function findActiveReminder(token: string) {
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(token)) return null;
  const admin = getReminderAdminClient();
  const { data, error } = await admin.from("show_reminder_deliveries")
    .select("id,calendar_event_id,producer_email,recipient_email,show_title,show_start_at,expires_at,delivery_status,used_at")
    .eq("token_hash", hashReminderToken(token)).eq("delivery_status", "sent").maybeSingle();
  if (error) throw new Error(`Could not validate reminder access: ${error.message}`);
  if (!data || data.used_at || new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data;
}

export async function revokeReminderAccess(producerEmail: string, showStartAt: string) {
  const { error } = await getReminderAdminClient().from("show_reminder_deliveries")
    .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("producer_email", producerEmail.toLowerCase()).eq("show_start_at", showStartAt).is("used_at", null);
  if (error) throw new Error(`Could not revoke reminder access: ${error.message}`);
}
