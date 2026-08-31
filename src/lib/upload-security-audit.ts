import { createClient } from "@supabase/supabase-js";

export type UploadSecurityEvent = {
  traceId: string;
  actorUserId: string;
  actorEmail: string;
  eventType: "presign_issued" | "delivery_attempted" | "delivery_completed";
  outcome: "accepted" | "pending" | "success" | "partial" | "failed";
  uploadType?: "audio" | "cover" | "description" | "all";
  stagedObjectKeys?: string[];
  audioFilename?: string;
  imageFilename?: string;
  targetProducerFolder?: string;
  details?: Record<string, unknown>;
};

function getAuditClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Upload audit storage is not configured.");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Audit storage is intentionally fail-closed for upload delivery: an upload
 * that cannot be recorded must not be routed to external media systems.
 */
export async function writeUploadSecurityEvent(event: UploadSecurityEvent) {
  const auditClient = getAuditClient();
  const { error } = await auditClient.from("upload_security_events").insert({
    trace_id: event.traceId,
    actor_user_id: event.actorUserId,
    actor_email: event.actorEmail,
    event_type: event.eventType,
    outcome: event.outcome,
    upload_type: event.uploadType ?? null,
    staged_object_keys: event.stagedObjectKeys ?? [],
    audio_filename: event.audioFilename ?? null,
    image_filename: event.imageFilename ?? null,
    target_producer_folder: event.targetProducerFolder ?? null,
    details: event.details ?? {},
  });

  if (error) {
    throw new Error(`Could not persist upload security audit event: ${error.message}`);
  }
}
