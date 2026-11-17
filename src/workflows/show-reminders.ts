import { sleep } from "workflow";
import { deliverShowReminders } from "@/app/api/cron/show-reminders/route";

async function deliverReminderStep() {
  "use step";
  const response = await deliverShowReminders();
  if (!response.ok) throw new Error(`Reminder delivery failed with status ${response.status}.`);
  return response.json();
}

export async function scheduleShowReminders(deliverAtIso: string) {
  "use workflow";
  const deliverAt = new Date(deliverAtIso);
  if (deliverAt.getTime() > Date.now()) await sleep(deliverAt);
  return deliverReminderStep();
}
