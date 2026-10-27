import type { Metadata } from "next";
import Image from "next/image";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Engineering Console — Paranoise Console",
  description:
    "A public engineering record of how Paranoise Console evolved from a submission tool into a radio operations platform.",
};

const weeklyActivity = [
  { week: "16 Feb", commits: 5 },
  { week: "23 Feb", commits: 27 },
  { week: "02 Mar", commits: 13 },
  { week: "09 Mar", commits: 8 },
  { week: "16 Mar", commits: 15 },
  { week: "23 Mar", commits: 1 },
  { week: "30 Mar", commits: 1 },
  { week: "13 Apr", commits: 3 },
  { week: "31 Aug", commits: 3 },
  { week: "07 Sep", commits: 1 },
  { week: "14 Sep", commits: 1 },
  { week: "05 Oct", commits: 2 },
  { week: "12 Oct", commits: 10 },
  { week: "19 Oct", commits: 2 },
] as const;

const milestones = [
  {
    phase: "01 / Foundation",
    date: "20 Feb 2026",
    hash: "e9373c2",
    title: "Initial integrated workflow",
    copy: "The MVP connected submission, scheduling, storage and downstream delivery.",
    outcome: "Submission tasks moved into one interface.",
  },
  {
    phase: "02 / Production hardening",
    date: "26 Feb 2026",
    hash: "0012630",
    title: "Direct-to-storage uploads",
    copy: "A concentrated week of presigning, route, memory and transfer changes responded to the realities of large audio on serverless infrastructure.",
    outcome: "Media no longer travelled through the application server.",
  },
  {
    phase: "03 / Publishing",
    date: "06 Mar 2026",
    hash: "c19eea2",
    title: "Mixcloud publishing",
    copy: "Mixcloud publishing extended Console beyond broadcast delivery into archive publishing.",
    outcome: "Submissions could be published from the admin interface.",
  },
  {
    phase: "04 / Resilience",
    date: "16 Mar 2026",
    hash: "4521578",
    title: "Adaptive multipart uploads",
    copy: "Multipart retries, failure telemetry and adaptive part sizing made long uploads recoverable rather than opaque.",
    outcome: "Failures became observable states with recovery paths.",
  },
  {
    phase: "05 / Operations",
    date: "18 Mar 2026",
    hash: "aaa4f73",
    title: "Operational reporting",
    copy: "Confirmation email and daily schedule-readiness reporting gave operators visibility outside the dashboard.",
    outcome: "The product became an operational feedback loop.",
  },
  {
    phase: "06 / Access",
    date: "01 Sep 2026",
    hash: "09baa9c",
    title: "Passwordless producer access",
    copy: "Invitation-only passwordless access aligned producer identity with the schedule while keeping public signup closed.",
    outcome: "Access became easier for residents and safer to operate.",
  },
  {
    phase: "07 / Platform",
    date: "14 Oct 2026",
    hash: "becd889",
    title: "Multi-channel publishing",
    copy: "Calendar and social publishing joined artwork, Mixcloud and Webflow in a wider orchestration layer.",
    outcome: "Console now coordinates more of the episode journey.",
  },
] as const;

const decisions = [
  {
    number: "D-01",
    title: "Upload directly to object storage",
    constraint: "Audio files can reach 900 MB, beyond a sensible serverless request path.",
    decision: "The browser uploads to R2 with short-lived presigned instructions, then submits only object keys and metadata.",
    consequence: "Lower server load and fewer request-size failures, with more client-side orchestration to manage.",
  },
  {
    number: "D-02",
    title: "Represent partial success explicitly",
    constraint: "FTP, Drive, database and email delivery can succeed or fail independently.",
    decision: "Persist destination-level outcomes instead of reducing the workflow to one success boolean.",
    consequence: "Operators can see what completed, recover what did not and avoid repeating successful work.",
  },
  {
    number: "D-03",
    title: "Move publishing into a durable workflow",
    constraint: "A browser request is the wrong lifetime for uploading and reconciling a long Mixcloud publication.",
    decision: "Start a retryable background workflow and make reconciliation and cleanup separate steps.",
    consequence: "Navigation cannot interrupt publishing, and cleanup failure cannot erase a successful publication.",
  },
] as const;

const submissionFlow = [
  { number: "01", action: "Select the scheduled show", detail: "Console reads upcoming occurrences and matches them to the authenticated producer.", systems: "Google Calendar → Supabase Auth" },
  { number: "02", action: "Stage media", detail: "The browser uploads audio and artwork directly using short-lived presigned instructions.", systems: "Browser → Cloudflare R2" },
  { number: "03", action: "Validate and record", detail: "Console validates metadata, stores the submission record and tracks each delivery state separately.", systems: "Next.js → Supabase" },
  { number: "04", action: "Deliver for broadcast", detail: "Audio is streamed from staging storage to the producer folder and scheduled for airing.", systems: "R2 → FTP → Centova" },
  { number: "05", action: "Publish and archive", detail: "A durable workflow publishes the episode and reconciles the resulting archive records.", systems: "Mixcloud → Webflow" },
  { number: "06", action: "Report the outcome", detail: "Confirmation, partial failures and schedule readiness are reported to residents and operators.", systems: "Supabase → Resend" },
] as const;

function ActivityChart() {
  return (
    <figure className={styles.activityFigure} aria-labelledby="activity-title">
      <div className={styles.chart} role="img" aria-label="Weekly commit activity from February to October 2026. The busiest week began on 23 February with 27 commits.">
        {weeklyActivity.map((item) => (
          <div className={styles.barColumn} key={item.week}>
            <span className={styles.barValue}>{item.commits}</span>
            <span className={`${styles.bar} ${styles[`bar${item.commits}`]}`} />
            <span className={styles.barLabel}>{item.week}</span>
          </div>
        ))}
      </div>
      <figcaption>
        Weekly commits on the production branch.
      </figcaption>
    </figure>
  );
}

export default function DevPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="#top" aria-label="Paranoise Console engineering home">
          <Image src="/branding/navbar-logo.png" width={173} height={45} alt="Paranoise" priority />
          <span>Engineering</span>
        </a>
        <nav className={styles.nav} aria-label="Page sections">
          <a href="#evolution">Evolution</a>
          <a href="#architecture">Architecture</a>
          <a href="#decisions">Decisions</a>
        </nav>
      </header>

      <section className={styles.hero} id="top">
        <div className={styles.heroMeta}>
          <div className={styles.heroStatus}>
            <span className={styles.liveDot} aria-hidden="true" />
            Production system · V0
          </div>
          <dl className={styles.repositoryMeta}>
            <div><dt>Repository window</dt><dd>20 Feb — 19 Oct 2026</dd></div>
            <div><dt>Last reviewed</dt><dd>27 Oct 2026</dd></div>
          </dl>
        </div>
        <h1>Paranoise Console<br />Engineering record</h1>
        <dl className={styles.stats}>
          <div><dt>Commits</dt><dd>92</dd></div>
          <div><dt>Residents</dt><dd>63</dd></div>
          <div><dt>Media processed</dt><dd>28 GB</dd></div>
          <div><dt>Published audio</dt><dd>126 h</dd></div>
        </dl>
      </section>

      <section className={styles.section} id="evolution">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>01 / Evolution through code</p>
          <h2>Implementation history</h2>
          <p>Selected production milestones from the repository history.</p>
        </div>

        <div className={styles.timeline}>
          {milestones.map((milestone) => (
            <article className={styles.milestone} key={milestone.hash}>
              <div className={styles.milestoneMeta}>
                <span>{milestone.phase}</span>
                <time>{milestone.date}</time>
                <code>{milestone.hash}</code>
              </div>
              <div className={styles.milestoneBody}>
                <h3>{milestone.title}</h3>
                <p>{milestone.copy}</p>
                <p className={styles.outcome}><span>Result</span>{milestone.outcome}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={`${styles.section} ${styles.activitySection}`}>
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>02 / Development intensity</p>
          <h2 id="activity-title">Weekly commit activity</h2>
          <p>Production branch activity from February to October 2026.</p>
        </div>
        <ActivityChart />
      </section>

      <section className={styles.section} id="architecture">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>03 / Architecture</p>
          <h2>Submission and publishing flow</h2>
          <p>The systems involved from show selection to delivery and reporting.</p>
        </div>

        <ol className={styles.flowList}>
          {submissionFlow.map((step) => (
            <li key={step.number}>
              <span className={styles.flowNumber}>{step.number}</span>
              <div className={styles.flowCopy}>
                <h3>{step.action}</h3>
                <p>{step.detail}</p>
              </div>
              <code>{step.systems}</code>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} id="decisions">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>04 / Decision log</p>
          <h2>Technical decisions</h2>
          <p>Decisions addressing media size, external dependencies and partial failure.</p>
        </div>

        <div className={styles.decisionList}>
          {decisions.map((item) => (
            <details className={styles.decision} key={item.number}>
              <summary>
                <span>{item.number}</span>
                <strong>{item.title}</strong>
                <i aria-hidden="true">+</i>
              </summary>
              <div className={styles.decisionBody}>
                <p><span>Constraint</span>{item.constraint}</p>
                <p><span>Decision</span>{item.decision}</p>
                <p><span>Consequence</span>{item.consequence}</p>
              </div>
            </details>
          ))}
        </div>
      </section>

    </main>
  );
}
