import { NextResponse } from "next/server";
import { formatInTimeZone } from "date-fns-tz";
import { start } from "workflow/api";
import { scheduleShowReminders } from "@/workflows/show-reminders";

export const runtime = "nodejs";
const ATHENS_TZ = "Europe/Athens";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization")?.trim() !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  const athensHour = formatInTimeZone(now, ATHENS_TZ, "HH");
  const delayMs = athensHour === "08" ? 60 * 60 * 1000 : 0;
  const deliverAt = new Date(now.getTime() + delayMs);
  const run = await start(scheduleShowReminders, [deliverAt.toISOString()]);
  return NextResponse.json({ runId: run.runId, deliverAt: deliverAt.toISOString() });
}
