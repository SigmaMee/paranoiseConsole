import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createHook, FatalError, getWorkflowMetadata, RetryableError } from "workflow";
import {
  findMixcloudUploadByName,
  MixcloudApiError,
  uploadToMixcloud,
} from "@/lib/mixcloud-api";
import { deleteFromR2, fileExistsInR2, getSignedR2Url } from "@/lib/r2-utils";
import { downloadAudioFromFtp } from "@/lib/ftp-media";

type PublishWorkflowResult = {
  status: "published" | "already-published" | "duplicate";
  submissionId: string;
  mixcloudUrl?: string;
  runId?: string;
};

type SubmissionRecord = {
  id: string;
  producer_email: string;
  airing_date: string;
  audio_filename: string | null;
  audio_object_key: string | null;
  audio_ftp_folder: string | null;
  image_object_key: string | null;
  submitted_description: string | null;
  submitted_tags: string[] | null;
  mixcloud: string | null;
  mixcloud_url: string | null;
};

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function adminClient() {
  return createAdminClient(
    getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function showName(filename: string) {
  return filename.replace(/\.[^.]+$/, "").replace(/-\d{6}$/, "") || "Show";
}

function permanentMixcloudFailure(error: unknown) {
  if (!(error instanceof MixcloudApiError) || error.status === null) return false;
  return error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
}

function retryableFailureMessage(phase: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Mixcloud ${phase} failed: ${detail}`;
}

async function recordRetryableFailure(
  supabase: ReturnType<typeof adminClient>,
  producerEmail: string,
  airingDate: string,
  phase: string,
  error: unknown,
) {
  const message = retryableFailureMessage(phase, error);
  console.warn("[MIXCLOUD_WORKFLOW_RETRYABLE_FAILURE]", { producerEmail, airingDate, message });
  const { error: updateError } = await supabase
    .from("submissions")
    .update({ mixcloud: "publishing", mixcloud_error: message })
    .eq("producer_email", producerEmail)
    .eq("airing_date", airingDate)
    .neq("mixcloud", "published");
  if (updateError) throw updateError;
}

async function publishShowFromR2(submissionId: string, workflowRunId: string) {
  "use step";

  console.info("[MIXCLOUD_WORKFLOW_PUBLISH_START]", { submissionId });
  const supabase = adminClient();
  const { data: selected, error: selectedError } = await supabase
    .from("submissions")
    .select("producer_email,airing_date")
    .eq("id", submissionId)
    .maybeSingle();
  if (selectedError) throw selectedError;
  if (!selected?.producer_email || !selected.airing_date) {
    throw new FatalError("The selected submission no longer exists or has no airing date.");
  }

  const { error: publishingStateError } = await supabase
    .from("submissions")
    .update({
      mixcloud: "publishing",
      mixcloud_error: null,
      mixcloud_workflow_run_id: workflowRunId,
      mixcloud_started_at: new Date().toISOString(),
    })
    .eq("producer_email", selected.producer_email)
    .eq("airing_date", selected.airing_date)
    .neq("mixcloud", "published");
  if (publishingStateError) throw publishingStateError;

  const { data, error } = await supabase
    .from("submissions")
    .select("id,producer_email,airing_date,audio_filename,audio_object_key,audio_ftp_folder,image_object_key,submitted_description,submitted_tags,mixcloud,mixcloud_url")
    .eq("producer_email", selected.producer_email)
    .eq("airing_date", selected.airing_date)
    // A late upload replaces an earlier draft for the same broadcast.
    .order("created_at", { ascending: false });
  if (error) throw error;

  const rows = (data || []) as SubmissionRecord[];
  const alreadyPublished = rows.find((row) => row.mixcloud === "published" && row.mixcloud_url);
  if (alreadyPublished?.mixcloud_url) {
    return {
      status: "already-published" as const,
      submissionId,
      mixcloudUrl: alreadyPublished.mixcloud_url,
      audioObjectKey: rows.find((row) => row.audio_object_key)?.audio_object_key || null,
    };
  }

  const audioRow = rows.find((row) => row.audio_object_key && row.audio_filename)
    || rows.find((row) => row.audio_filename);
  if (!audioRow?.audio_filename) {
    throw new FatalError("No audio file is recorded for this show.");
  }

  const name = showName(audioRow.audio_filename);
  let existing;
  try {
    existing = await findMixcloudUploadByName(name);
  } catch (lookupError) {
    if (permanentMixcloudFailure(lookupError)) {
      throw new FatalError(lookupError instanceof Error ? lookupError.message : "Mixcloud lookup failed.");
    }
    await recordRetryableFailure(supabase, selected.producer_email, selected.airing_date, "lookup", lookupError);
    throw new RetryableError(
      lookupError instanceof Error ? lookupError.message : "Mixcloud lookup temporarily failed.",
      { retryAfter: "30s" },
    );
  }

  let result = existing;
  if (!result) {
    const audioObjectKey = audioRow.audio_object_key;
    const audioAvailableInR2 = Boolean(audioObjectKey && await fileExistsInR2(audioObjectKey));
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("producer_email", selected.producer_email)
      .maybeSingle();

    let audioUrl: string | undefined;
    let audioBuffer: Buffer | undefined;
    if (audioAvailableInR2 && audioObjectKey) {
      audioUrl = await getSignedR2Url(audioObjectKey);
    } else if (audioRow.audio_ftp_folder || profile?.full_name) {
      // Transitional support for submissions created before audio_object_key existed.
      const ftpFolder = audioRow.audio_ftp_folder || profile?.full_name;
      audioBuffer = ftpFolder
        ? (await downloadAudioFromFtp(audioRow.audio_filename, ftpFolder.trim())) || undefined
        : undefined;
    }
    if (!audioUrl && !audioBuffer) {
      throw new FatalError("Audio is no longer available in R2 and no legacy FTP copy could be read.");
    }

    const pictureObjectKey = rows.find((row) => row.image_object_key)?.image_object_key || null;
    const pictureUrl = pictureObjectKey && await fileExistsInR2(pictureObjectKey)
      ? await getSignedR2Url(pictureObjectKey)
      : undefined;
    const tags = Array.from(new Set(rows.flatMap((row) => row.submitted_tags || [])));
    const description = rows.find((row) => row.submitted_description?.trim())?.submitted_description?.trim();

    try {
      result = await uploadToMixcloud({
        audioUrl,
        audioBuffer,
        name,
        tags,
        description,
        pictureUrl,
      });
    } catch (uploadError) {
      if (permanentMixcloudFailure(uploadError)) {
        throw new FatalError(uploadError instanceof Error ? uploadError.message : "Mixcloud rejected the upload.");
      }
      await recordRetryableFailure(supabase, selected.producer_email, selected.airing_date, "upload", uploadError);
      throw new RetryableError(
        uploadError instanceof Error ? uploadError.message : "Mixcloud upload temporarily failed.",
        { retryAfter: "1m" },
      );
    }
  }

  const mixcloudUrl = new URL(result.key, "https://www.mixcloud.com").toString();
  const { error: updateError } = await supabase
    .from("submissions")
    .update({
      mixcloud: "published",
      mixcloud_key: result.key,
      mixcloud_url: mixcloudUrl,
      mixcloud_error: null,
      mixcloud_published_at: new Date().toISOString(),
      webflow_status: "ready",
      webflow_error: null,
    })
    .eq("producer_email", selected.producer_email)
    .eq("airing_date", selected.airing_date);
  if (updateError) throw updateError;

  console.info("[MIXCLOUD_WORKFLOW_PUBLISH_COMPLETE]", { submissionId, mixcloudUrl });
  return {
    status: "published" as const,
    submissionId,
    mixcloudUrl,
    audioObjectKey: audioRow.audio_object_key,
  };
}
// Large audio files can be interrupted by transient upstream connections.
// Each attempt checks Mixcloud first, so retrying cannot create a duplicate post.
publishShowFromR2.maxRetries = 4;

async function markPublishFailed(submissionId: string, message: string) {
  "use step";

  console.error("[MIXCLOUD_WORKFLOW_FAILED]", { submissionId, message });
  const supabase = adminClient();
  const { data: selected } = await supabase
    .from("submissions")
    .select("producer_email,airing_date,mixcloud_error")
    .eq("id", submissionId)
    .maybeSingle();
  if (!selected?.producer_email || !selected.airing_date) return;

  const storedDetail = typeof selected.mixcloud_error === "string" ? selected.mixcloud_error.trim() : "";
  const finalMessage = message.includes("exceeded max retries") && storedDetail
    ? storedDetail
    : message;
  const { error } = await supabase
    .from("submissions")
    .update({ mixcloud: "failed", mixcloud_error: finalMessage })
    .eq("producer_email", selected.producer_email)
    .eq("airing_date", selected.airing_date)
    .neq("mixcloud", "published");
  if (error) throw error;
}

async function deletePublishedAudio(submissionId: string, audioObjectKey: string) {
  "use step";

  console.info("[MIXCLOUD_WORKFLOW_R2_CLEANUP_START]", { submissionId, audioObjectKey });
  await deleteFromR2(audioObjectKey);
  const supabase = adminClient();
  const { error } = await supabase
    .from("submissions")
    .update({ r2_audio_deleted_at: new Date().toISOString() })
    .eq("audio_object_key", audioObjectKey);
  if (error) throw error;
  console.info("[MIXCLOUD_WORKFLOW_R2_CLEANUP_COMPLETE]", { submissionId, audioObjectKey });
}
deletePublishedAudio.maxRetries = 3;

export async function publishShowToMixcloud(
  submissionId: string,
  lockKey: string,
): Promise<PublishWorkflowResult> {
  "use workflow";

  console.info("[MIXCLOUD_WORKFLOW_START]", { submissionId, lockKey });
  using lock = createHook({ token: `mixcloud-publish:${lockKey}` });
  const conflict = await lock.getConflict();
  if (conflict) {
    return { status: "duplicate", submissionId, runId: conflict.runId };
  }

  let published: Awaited<ReturnType<typeof publishShowFromR2>>;
  try {
    published = await publishShowFromR2(submissionId, getWorkflowMetadata().workflowRunId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mixcloud publishing failed.";
    await markPublishFailed(submissionId, message);
    throw error;
  }

  if (published.audioObjectKey) {
    try {
      await deletePublishedAudio(submissionId, published.audioObjectKey);
    } catch (cleanupError) {
      console.warn("[MIXCLOUD_WORKFLOW_R2_CLEANUP_DEFERRED]", {
        submissionId,
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  return {
    status: published.status,
    submissionId,
    mixcloudUrl: published.mixcloudUrl,
  };
}
