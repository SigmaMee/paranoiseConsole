import { NextResponse } from "next/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { HookNotFoundError } from "workflow/errors";
import { getHookByToken, start } from "workflow/api";
import { requireAdminUser } from "@/lib/admin-access";
import { publishShowToMixcloud } from "@/workflows/mixcloud-publish";

export const runtime = "nodejs";

type SelectedSubmission = {
  id: string;
  producer_email: string;
  airing_date: string;
  mixcloud: string | null;
};

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function showLockKey(submission: SelectedSubmission) {
  return `${submission.producer_email.toLowerCase()}|${submission.airing_date}`;
}

export async function POST(request: Request) {
  const authorization = await requireAdminUser();
  if (authorization.response) return authorization.response;

  try {
    const { submissionIds } = await request.json() as { submissionIds?: unknown };
    if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
      return NextResponse.json({ error: "No submissions selected." }, { status: 400 });
    }

    const ids = Array.from(new Set(submissionIds.filter((id): id is string => typeof id === "string" && id.length > 0)));
    const supabase = createAdminClient(
      getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
      getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    );
    const { data, error } = await supabase
      .from("submissions")
      .select("id,producer_email,airing_date,mixcloud")
      .in("id", ids);
    if (error) throw error;

    const uniqueShows = new Map<string, SelectedSubmission>();
    for (const row of (data || []) as SelectedSubmission[]) {
      if (!row.producer_email || !row.airing_date || row.mixcloud === "published") continue;
      uniqueShows.set(showLockKey(row), row);
    }
    if (uniqueShows.size === 0) {
      return NextResponse.json({ error: "No unpublished shows were selected." }, { status: 400 });
    }

    const results = [];
    for (const [lockKey, submission] of uniqueShows) {
      const token = `mixcloud-publish:${lockKey}`;
      let runId: string | null = null;
      let reused = false;

      try {
        const activeHook = await getHookByToken(token);
        runId = activeHook.runId;
        reused = true;
      } catch (hookError) {
        if (!HookNotFoundError.is(hookError)) throw hookError;
      }

      const { error: publishingError } = await supabase
        .from("submissions")
        .update({
          mixcloud: "publishing",
          mixcloud_error: null,
          mixcloud_started_at: new Date().toISOString(),
        })
        .eq("producer_email", submission.producer_email)
        .eq("airing_date", submission.airing_date)
        .neq("mixcloud", "published");
      if (publishingError) throw publishingError;

      if (!runId) {
        try {
          const run = await start(publishShowToMixcloud, [submission.id, lockKey]);
          runId = run.runId;
        } catch (startError) {
          const message = startError instanceof Error ? startError.message : "The publishing workflow could not be started.";
          await supabase
            .from("submissions")
            .update({ mixcloud: "failed", mixcloud_error: message })
            .eq("producer_email", submission.producer_email)
            .eq("airing_date", submission.airing_date)
            .neq("mixcloud", "published");
          throw startError;
        }
      }

      results.push({
        submissionId: submission.id,
        status: "publishing",
        runId,
        reused,
      });
    }

    return NextResponse.json({ success: true, results }, { status: 202 });
  } catch (error) {
    console.error("Could not start Mixcloud publishing workflow:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The Mixcloud publishing workflow could not be started." },
      { status: 500 },
    );
  }
}
