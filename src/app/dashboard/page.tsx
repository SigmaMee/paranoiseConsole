import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";
import { SubmissionForm } from "@/components/submission-form";
import { getUpcomingShowsByProducerEmail } from "@/lib/google-calendar";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
  const isAdmin = Boolean(user.email && adminEmail && user.email.toLowerCase() === adminEmail);

  let upcomingShows: Awaited<ReturnType<typeof getUpcomingShowsByProducerEmail>> = [];
  let scheduleError: string | null = null;

  if (user.email) {
    try {
      upcomingShows = await getUpcomingShowsByProducerEmail(user.email);
    } catch {
      scheduleError =
        "Could not load upcoming shows. Check Google Calendar service account environment settings.";
    }
  }

  return (
    <main className="container stack-lg">
      <section className="card">
        <div className="row row-top">
          <div>
            <p className="eyebrow">Paranoise Console</p>
            <h1 className="title">Producer Dashboard</h1>
          </div>
          <form action={signOut}>
            <button className="button button-ghost button-inline" type="submit">
              Sign out
            </button>
          </form>
        </div>
        <p className="muted">Signed in as {user.email}</p>
        <span className="pill">MVP foundation ready</span>
      </section>

      <section className="card">
        <div className="section-head">
          <h2 className="section-title">Upcoming Shows</h2>
        </div>
        {scheduleError ? <p className="message message-error">{scheduleError}</p> : null}
        {!scheduleError && upcomingShows.length === 0 ? (
          <p className="muted">No upcoming shows found for your producer email.</p>
        ) : null}
        {!scheduleError && upcomingShows.length > 0 ? (
          <div className="stack">
            {upcomingShows.map((show) => (
              <div className="row schedule-item" key={show.id}>
                <div>
                  <p>{show.title}</p>
                  <p className="muted">Starts: {show.startsAt}</p>
                </div>
                <span className="pill">Scheduled</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="section-head">
          <h2 className="section-title">Radio Show Submission</h2>
        </div>
        <p className="muted">
          Backlog C-0/C-1/C-2/C-6: combined form (title + MP3 up to 200MB + image).
        </p>
        <SubmissionForm />
      </section>

      {isAdmin ? (
        <section className="card">
          <div className="section-head">
            <h2 className="section-title">Google Drive Connection</h2>
          </div>
          <p className="muted">
            Connect the Paranoise Google account once so cover uploads can run in background
            without asking producers to sign into Google.
          </p>
          <a className="button button-inline" href="/api/google-drive/oauth/start">
            Connect Google Drive (Paranoise)
          </a>
        </section>
      ) : null}
    </main>
  );
}
