import { redirect } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";
import { SubmissionForm } from "@/components/submission-form";
import { getUpcomingShowsByProducerEmail } from "@/lib/google-calendar";

function formatUpcomingShow(startsAt: string) {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) {
    return startsAt;
  }

  const formattedDate = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);

  const formattedTime = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  return `${formattedDate} - ${formattedTime}`;
}

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
  const producerName =
    typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : user.email?.split("@")[0] || "Producer";

  let upcomingShows: Awaited<ReturnType<typeof getUpcomingShowsByProducerEmail>> = [];

  if (user.email) {
    try {
      upcomingShows = await getUpcomingShowsByProducerEmail(user.email);
    } catch {}
  }

  const upcomingShowText = upcomingShows[0]?.startsAt
    ? formatUpcomingShow(upcomingShows[0].startsAt)
    : "TBD";

  return (
    <main className="dashboard-screen">
      <div className="dashboard-shell">
        <section className="dashboard-panel">
          <div className="dashboard-header-row">
            <div className="dashboard-brand-group">
              <Image
                src="/branding/navbar-logo.png"
                alt="Paranoise Radio"
                width={256}
                height={55}
                className="dashboard-logo"
                priority
              />
              <p className="dashboard-overline">Console</p>
            </div>
            <form action={signOut}>
              <button className="btn-neutral" type="submit">
                Sign out
              </button>
            </form>
          </div>
          <div className="dashboard-greeting-row">
            <h1 className="dashboard-greeting">Hello {producerName}!</h1>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="dashboard-banner">
            <span>UPCOMING SHOW:</span>
            <span>{upcomingShowText}</span>
          </div>
        </section>

        <section className="dashboard-panel">
          <div className="section-head">
            <h2 className="dashboard-section-title">Submit your radio show</h2>
          </div>
          <SubmissionForm />
        </section>

        {isAdmin ? (
          <section className="dashboard-panel">
            <div className="section-head">
              <h2 className="dashboard-section-title">Google Drive Connection</h2>
            </div>
            <p className="muted">
              Connect the Paranoise Google account once so cover uploads can run in background
              without asking producers to sign into Google.
            </p>
            <a className="dashboard-connect" href="/api/google-drive/oauth/start">
              Connect Google Drive (Paranoise)
            </a>
          </section>
        ) : null}
      </div>
    </main>
  );
}
