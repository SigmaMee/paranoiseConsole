import { redirect } from "next/navigation";
import Image from "next/image";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/actions";
import { ShowSubmissionToggle } from "@/components/show-submission-toggle";
import styles from "./status-chips.module.css";
import ActivityLogWrapper from "./ActivityLogWrapper";
import bulkStyles from "./bulk-action.module.css";
import {
  getMostRecentPastAndFutureShowsByProducerEmail,
  getScheduledShowCountsForMonth,
} from "@/lib/google-calendar";

function formatAiringDate(airingDateIso: string | null) {
  if (!airingDateIso) {
    return "-";
  }

  const match = airingDateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return airingDateIso;
  }

  return `${match[3]}/${match[2]}/${match[1]}`;
}

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const ACTIVITY_PAGE_SIZE = 12;

function getCurrentMonthIso() {
  return new Date().toISOString().slice(0, 7);
}

function normalizeMonthIso(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) {
    return getCurrentMonthIso();
  }

  return value > getCurrentMonthIso() ? getCurrentMonthIso() : value;
}

function shiftMonthIso(monthIso: string, offset: number) {
  const [yearStr, monthStr] = monthIso.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getMonthBounds(monthIso: string) {
  const [yearStr, monthStr] = monthIso.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);

  const monthStart = `${monthIso}-01`;
  const monthEnd = `${yearStr}-${monthStr}-${String(
    new Date(Date.UTC(year, month, 0)).getUTCDate(),
  ).padStart(2, "0")}`;

  return { monthStart, monthEnd, year, month };
}

function formatMonthLabel(monthIso: string) {
  const [yearStr, monthStr] = monthIso.split("-");
  const date = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(date);
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams;
  const getParam = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : "";

  const driveOauthState = typeof params.drive_oauth === "string" ? params.drive_oauth : "";
  const driveOauthMessage =
    typeof params.drive_oauth_message === "string" ? params.drive_oauth_message : "";
  const metricMonthParam = typeof params.metric_month === "string" ? params.metric_month : "";
  const activityPageParam = getParam("activity_page");
  const parsedActivityPage = Number.parseInt(activityPageParam || "1", 10);
  const activityPage = Number.isNaN(parsedActivityPage) || parsedActivityPage < 1
    ? 1
    : parsedActivityPage;
  const selectedMetricMonth = normalizeMonthIso(metricMonthParam);
  const previousMetricMonth = shiftMonthIso(selectedMetricMonth, -1);
  const nextMetricMonth = shiftMonthIso(selectedMetricMonth, 1);
  const canNavigateNext = selectedMetricMonth < getCurrentMonthIso();
  const { monthStart, monthEnd, year: metricYear, month: metricMonth } =
    getMonthBounds(selectedMetricMonth);
  const metricMonthLabel = formatMonthLabel(selectedMetricMonth);

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

  let mostRecentPastShow: { title: string; startsAt: string } | null = null;
  let mostRecentFutureShow: { title: string; startsAt: string } | null = null;

  if (user.email && !isAdmin) {
    try {
      const selection = await getMostRecentPastAndFutureShowsByProducerEmail(user.email);
      mostRecentPastShow = selection.mostRecentPastShow
        ? { title: selection.mostRecentPastShow.title, startsAt: selection.mostRecentPastShow.startsAt }
        : null;
      mostRecentFutureShow = selection.mostRecentFutureShow
        ? { title: selection.mostRecentFutureShow.title, startsAt: selection.mostRecentFutureShow.startsAt }
        : null;
    } catch {}
  }

  let driveConnected = false;
  let driveConnectedAt: string | null = null;
  let driveConnectedBy: string | null = null;
  let scheduledShowsByDate: Record<string, number> = {};
  let uploadsByDate: Record<string, number> = {};
  let allTimeTagCounts: Array<{ tag: string; count: number }> = [];
  let activityLogRows: Array<{
    producer: string;
    airingDate: string | null;
    hasAudio: boolean;
    hasCoverImage: boolean;
    hasDescription: boolean;
    hasTags: boolean;
    mixcloud: string;
  }> = [];
  let activityTotalCount = 0;

  if (isAdmin && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const { data } = await adminSupabase
        .from("google_oauth_tokens")
        .select("provider,updated_at,updated_by_email")
        .eq("provider", "google_drive")
        .maybeSingle();

      if (data?.provider === "google_drive") {
        driveConnected = true;
        driveConnectedAt = data.updated_at || null;
        driveConnectedBy = data.updated_by_email || null;
      }
    } catch {}

    try {
      scheduledShowsByDate = await getScheduledShowCountsForMonth(selectedMetricMonth);
    } catch {}

    try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const { data } = await adminSupabase
        .from("submissions")
        .select("airing_date")
        .gte("airing_date", monthStart)
        .lte("airing_date", monthEnd);

      uploadsByDate = (data || []).reduce<Record<string, number>>((acc, row) => {
        const airingDate = typeof row.airing_date === "string" ? row.airing_date : "";
        if (!airingDate) {
          return acc;
        }

        acc[airingDate] = (acc[airingDate] || 0) + 1;
        return acc;
      }, {});
    } catch {}

    try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const { data } = await adminSupabase.from("submissions").select("submitted_tags");

      const counts = (data || []).reduce<Record<string, number>>((acc, row) => {
        const tags = Array.isArray(row.submitted_tags) ? row.submitted_tags : [];

        for (const rawTag of tags) {
          if (typeof rawTag !== "string") {
            continue;
          }

          const normalizedTag = rawTag.trim().toLowerCase();
          if (!normalizedTag) {
            continue;
          }

          acc[normalizedTag] = (acc[normalizedTag] || 0) + 1;
        }

        return acc;
      }, {});

      allTimeTagCounts = Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 120)
        .map(([tag, count]) => ({ tag, count }));
    } catch {}

    try {
      const adminSupabase = createAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      );

      const activityFrom = (activityPage - 1) * ACTIVITY_PAGE_SIZE;
      const activityTo = activityFrom + ACTIVITY_PAGE_SIZE - 1;

      const { data: submissions } = await adminSupabase
          .from("submissions")
          .select(
            "producer_email,airing_date,audio_filename,image_filename,submitted_tags,ftp_message,created_at,mixcloud",
            { count: "exact" },
          )
          .order("created_at", { ascending: false })
          .range(activityFrom, activityTo);

      activityTotalCount = submissions ? submissions.length : 0;

      const { count } = await adminSupabase
        .from("submissions")
        .select("id", { count: "exact", head: true });

      if (typeof count === "number") {
        activityTotalCount = count;
      }

      const producerEmails = Array.from(
        new Set(
          (submissions || [])
            .map((row) => String(row.producer_email || "").toLowerCase())
            .filter(Boolean),
        ),
      );

      let producerNameByEmail: Record<string, string> = {};

      if (producerEmails.length > 0) {
        const { data: profiles } = await adminSupabase
          .from("profiles")
          .select("producer_email,full_name")
          .in("producer_email", producerEmails);

        producerNameByEmail = (profiles || []).reduce<Record<string, string>>((acc, row) => {
          const email = String(row.producer_email || "").toLowerCase();
          const fullName = typeof row.full_name === "string" ? row.full_name.trim() : "";
          if (email && fullName) {
            acc[email] = fullName;
          }
          return acc;
        }, {});
      }

      activityLogRows = (submissions || []).map((row) => {
        const producerEmail = String(row.producer_email || "").toLowerCase();
        const producer =
          producerNameByEmail[producerEmail] || producerEmail || "Unknown producer";
        const airingDate = typeof row.airing_date === "string" ? row.airing_date : null;
        const audioFilename = typeof row.audio_filename === "string" ? row.audio_filename.trim() : "";
        const imageFilename = typeof row.image_filename === "string" ? row.image_filename.trim() : "";
        const ftpMessage = typeof row.ftp_message === "string" ? row.ftp_message.toLowerCase() : "";
        const submittedTags = Array.isArray(row.submitted_tags) ? row.submitted_tags : [];

        return {
          producer,
          airingDate,
          hasAudio: Boolean(audioFilename),
          hasCoverImage: Boolean(imageFilename),
          hasDescription:
            ftpMessage.includes("description uploaded") ||
            ftpMessage.includes("description upload failed"),
          hasTags: submittedTags.length > 0,
          mixcloud: typeof row.mixcloud === "string" ? row.mixcloud : "not ready",
        };
      });
    } catch {}
  }

  const activityTotalPages = Math.max(1, Math.ceil(activityTotalCount / ACTIVITY_PAGE_SIZE));
  const safeActivityPage = Math.min(activityPage, activityTotalPages);
  const hasPreviousActivityPage = safeActivityPage > 1;
  const hasNextActivityPage = safeActivityPage < activityTotalPages;

  const buildActivityPageQuery = (page: number) => {
    const nextParams = new URLSearchParams();
    nextParams.set("metric_month", selectedMetricMonth);
    nextParams.set("activity_page", String(page));
    return `/dashboard?${nextParams.toString()}`;
  };

  const daysInMonth = new Date(Date.UTC(metricYear, metricMonth, 0)).getUTCDate();
  const firstDayWeekday = new Date(Date.UTC(metricYear, metricMonth - 1, 1)).getUTCDay();
  const leadingEmptyDays = (firstDayWeekday + 6) % 7;
  const todayIsoDate = new Date().toISOString().slice(0, 10);

  const coverageDays = Array.from({ length: daysInMonth }, (_, index) => {
    const dayNumber = index + 1;
    const dateIso = `${selectedMetricMonth}-${String(dayNumber).padStart(2, "0")}`;
    const scheduledCount = scheduledShowsByDate[dateIso] || 0;
    const uploadCount = uploadsByDate[dateIso] || 0;
    const isFutureDay = dateIso > todayIsoDate;

    const status = isFutureDay
      ? "future"
      : scheduledCount === 0
        ? "none"
        : uploadCount === 0
          ? "zero"
          : uploadCount >= scheduledCount
            ? "full"
            : "partial";

    return {
      dateIso,
      dayNumber,
      scheduledCount,
      uploadCount,
      status,
    };
  });

  const maxTagCount = allTimeTagCounts[0]?.count || 1;
  const minTagCount = allTimeTagCounts[allTimeTagCounts.length - 1]?.count || 1;

  function tagWeight(count: number) {
    if (maxTagCount === minTagCount) {
      return 0.5;
    }

    return (count - minTagCount) / (maxTagCount - minTagCount);
  }

  const totalTags = allTimeTagCounts.length;

  const positionedCloudTags = allTimeTagCounts.map((entry, index) => {
    const weight = tagWeight(entry.count);
    const fontSize = 0.9 + weight * 1.9;
    const opacity = 0.7 + weight * 0.3;
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt((index + 1) / Math.max(totalTags, 1)) * 43;
    const x = 50 + Math.cos(angle) * radius;
    const y = 50 + Math.sin(angle) * radius;

    return {
      ...entry,
      fontSize,
      opacity,
      x,
      y,
    };
  });

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

        {!isAdmin ? (
          <ShowSubmissionToggle
            mostRecentPastShow={mostRecentPastShow}
            mostRecentFutureShow={mostRecentFutureShow}
          />
        ) : null}

        {isAdmin ? (
          <section className="dashboard-panel">
            <h2 className="dashboard-section-title">Submissions overview</h2>
            <form method="get" className="dashboard-header-row">
              <input type="hidden" name="activity_page" value="1" />
              <button className="btn-neutral" type="submit" name="metric_month" value={previousMetricMonth}>
                Prev month
              </button>
              <div className="dashboard-month-group">
                <p className="muted dashboard-month-label">{metricMonthLabel}</p>
                <button className="dashboard-month-reset" type="submit">
                Go to current month
                </button>
              </div>
              <button
                className="btn-neutral"
                type="submit"
                name="metric_month"
                value={nextMetricMonth}
                disabled={!canNavigateNext}
              >
                Next month
              </button>
            </form>
            <div className="dashboard-coverage-legend">
              <span className="dashboard-coverage-pill dashboard-coverage-pill-full">Alls shows there!</span>
              <span className="dashboard-coverage-pill dashboard-coverage-pill-partial">Some shows are missing</span>
              <span className="dashboard-coverage-pill dashboard-coverage-pill-zero">No shows uploaded</span>
              <span className="dashboard-coverage-pill">Future</span>
            </div>

            <div className="dashboard-coverage-weekdays">
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
              <span>Sun</span>
            </div>

            <div className="dashboard-coverage-grid">
              {Array.from({ length: leadingEmptyDays }).map((_, index) => (
                <div key={`empty-${index}`} className="dashboard-coverage-day dashboard-coverage-day-empty" />
              ))}
              {coverageDays.map((day) => (
                <div
                  key={day.dateIso}
                  className={`dashboard-coverage-day dashboard-coverage-day-${day.status}`}
                  title={`${day.dateIso}: ${day.uploadCount}/${day.scheduledCount}`}
                >
                  <span className="dashboard-coverage-day-number">{day.dayNumber}</span>
                  <span className="dashboard-coverage-day-ratio">
                    {day.scheduledCount > 0 ? `${day.uploadCount}/${day.scheduledCount}` : "-"}
                  </span>
                </div>
              ))}
            </div>

            <h2 className="dashboard-section-title">Genres and styles</h2>
            {positionedCloudTags.length > 0 ? (
              <div className="dashboard-tag-cloud-scroll">
                <div className="dashboard-tag-cloud-canvas">
                  {positionedCloudTags.map((entry) => (
                    <span
                      key={entry.tag}
                      className="dashboard-tag-cloud-word"
                      style={{
                        fontSize: `${entry.fontSize}rem`,
                        opacity: entry.opacity,
                        left: `${entry.x}%`,
                        top: `${entry.y}%`,
                      }}
                      data-count={`${entry.count} shows`}
                    >
                      {entry.tag}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="muted">No tags available yet.</p>
            )}

            <h2 className="dashboard-section-title">Activity Log</h2>
            {activityLogRows.length > 0 ? (
              <ActivityLogWrapper rows={activityLogRows} />
            ) : (
              <p className="muted">No activity rows yet.</p>
            )}

            <h2 className="dashboard-section-title">Google Drive Connection</h2>
            <p className="muted">
              If there is an issue with the connection to google drive, you can reconnect here. If problems persist, please contact Stefanos.
            </p>
            <a className="dashboard-connect" href="/api/google-drive/oauth/start">
              Connect Google Drive
            </a>

            <CalendarUserSync />
          </section>
        ) : null}
      </div>
    </main>
  );
}
