import { formatInTimeZone } from "date-fns-tz";
import { findActiveReminder } from "@/lib/show-reminders";
import styles from "./page.module.css";

export default async function ReminderAccessPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reminder = await findActiveReminder(token);
  if (!reminder) {
    return <main className={styles.screen}><section className={styles.panel}><h1>Link unavailable</h1><p>This reminder link has expired or has already been used. You can still sign in to Console normally.</p><a href="/login">Go to Console login</a></section></main>;
  }
  const schedule = formatInTimeZone(new Date(reminder.show_start_at), "Europe/Athens", "d MMMM yyyy 'at' HH:mm");
  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="reminder-title">
        <p className={styles.overline}>Paranoise Console</p>
        <h1 id="reminder-title">Get ready for your show</h1>
        <p className={styles.show}>{reminder.show_title}</p>
        <p>{schedule} Greece time</p>
        <form action="/api/reminders/redeem" method="post" className={styles.actions}>
          <input type="hidden" name="token" value={token} />
          <button type="submit" name="intent" value="submit">Open submission form</button>
          <button className={styles.cancel} type="submit" name="intent" value="cancel">Cancel show</button>
        </form>
        <p className={styles.note}>Opening this page does not cancel anything. Cancellation always requires confirmation.</p>
      </section>
    </main>
  );
}
