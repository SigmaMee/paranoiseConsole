import { Resend } from "resend";
import { formatInTimeZone } from "date-fns-tz";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROM = "Paranoise Console <console@paranoiseradio.com>";
const LOGO_URL = "https://console.paranoiseradio.com/branding/monogram-white.png";
const ATHENS_TZ = "Europe/Athens";

const C = {
  black: "#0c0c0c",
  white: "#ffffff",
  orange: "#ff6700",
  blue: "#44c8f5",
  grey: "#1a1a1a",
  muted: "#9e9e9e",
  green: "#66bb6a",
  amber: "#ffb300",
  red: "#ef5350",
  greenBg: "#0f1f0f",
  amberBg: "#1f1a0a",
  redBg: "#1f0f0f",
};

// ---------------------------------------------------------------------------
// Resend client (lazy — only throws at call time if key is missing)
// ---------------------------------------------------------------------------

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Missing RESEND_API_KEY environment variable.");
  return new Resend(apiKey);
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

function emailWrapper(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Paranoise Console</title>
</head>
<body style="margin:0;padding:0;background:${C.black};font-family:Arial,Helvetica,sans-serif;color:${C.white};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.black};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="padding-bottom:32px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td style="padding:0;vertical-align:middle;">
                    <img src="${LOGO_URL}" alt="Paranoise Radio" height="32" style="display:block;" />
                  </td>
                  <td style="padding:0 0 0 12px;vertical-align:middle;color:${C.orange};font-size:24px;font-weight:700;line-height:1;text-transform:uppercase;letter-spacing:0.04em;">
                    Console
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${body}

          <!-- Footer -->
          <tr>
            <td style="padding-top:32px;border-top:1px solid #2a2a2a;color:${C.muted};font-size:12px;line-height:1.6;">
              Paranoise Console &mdash; <a href="https://console.paranoiseradio.com" style="color:${C.muted};text-decoration:none;">console.paranoiseradio.com</a>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const tick = `<span style="color:${C.blue};font-weight:700;">✓</span>`;
const cross = `<span style="color:${C.red};font-weight:700;">✗</span>`;
const dash = `<span style="color:${C.muted};">–</span>`;

function tableHeader(...cols: string[]) {
  const cells = cols
    .map(
      (c) =>
        `<td style="padding:10px 12px;font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;">${c}</td>`,
    )
    .join("");
  return `<tr style="background:${C.grey};">${cells}</tr>`;
}

// ---------------------------------------------------------------------------
// 1. Submission confirmation
// ---------------------------------------------------------------------------

export type SubmissionEmailPayload = {
  to: string;
  producerName: string;
  showTitle: string;
  showStartAt: string | null;
  audioFilename: string;
  imageFilename: string;
  hasDescription: boolean;
  ftpSuccess: boolean;
  driveSuccess: boolean;
  centovaResult: { success: boolean; message: string } | null;
};

export function buildSubmissionConfirmationHtml(payload: SubmissionEmailPayload): { html: string; subject: string } {
  const showDateFormatted = payload.showStartAt
    ? formatInTimeZone(new Date(payload.showStartAt), ATHENS_TZ, "d MMMM yyyy 'at' HH:mm")
    : null;

  const audioStatus = payload.ftpSuccess && payload.audioFilename ? tick : payload.audioFilename ? cross : dash;
  const coverStatus = payload.imageFilename ? (payload.driveSuccess ? tick : cross) : dash;
  const descStatus = payload.hasDescription ? tick : dash;

  const centovaRow =
    payload.centovaResult !== null
      ? `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.white};">Centova scheduling</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;">${payload.centovaResult.success ? tick : cross}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};font-size:13px;">${payload.centovaResult.message}</td>
        </tr>`
      : "";

  const body = `
    <tr>
      <td style="padding:36px 0 20px;">
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:${C.white};">Show submitted</h1>
        ${
          showDateFormatted
            ? `<p style="margin:0;color:${C.blue};font-size:15px;">Scheduled for ${showDateFormatted} Athens time</p>`
            : ""
        }
      </td>
    </tr>
    <tr>
      <td style="padding-bottom:24px;">
        <p style="margin:0 0 8px;font-size:15px;color:${C.white};">Hi ${payload.producerName},</p>
        <p style="margin:0;font-size:14px;color:#ccc;line-height:1.6;">Here is a summary of your submission for <strong style="color:${C.white};">${payload.showTitle}</strong>.</p>
      </td>
    </tr>
    <tr>
      <td>
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px;">
          ${tableHeader("Item", "Status", "Detail")}
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.white};">Audio</td>
            <td style="padding:8px 12px;border-bottom:1px solid #222;">${audioStatus}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};font-size:13px;">${payload.audioFilename || "Not included"}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.white};">Cover</td>
            <td style="padding:8px 12px;border-bottom:1px solid #222;">${coverStatus}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};font-size:13px;">${payload.imageFilename || "Not included"}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.white};">Description</td>
            <td style="padding:8px 12px;border-bottom:1px solid #222;">${descStatus}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};font-size:13px;">${payload.hasDescription ? "Included" : "Not included"}</td>
          </tr>
          ${centovaRow}
        </table>
      </td>
    </tr>`;

  const subject = showDateFormatted
    ? `Show submitted — ${payload.showTitle} · ${showDateFormatted}`
    : `Show submitted — ${payload.showTitle}`;

  return { html: emailWrapper(body), subject };
}

export async function sendSubmissionConfirmationEmail(
  payload: SubmissionEmailPayload,
): Promise<void> {
  const resend = getResend();
  const { html, subject } = buildSubmissionConfirmationHtml(payload);
  await resend.emails.send({ from: FROM, to: payload.to, subject, html });
}

// ---------------------------------------------------------------------------
// 2. Daily Centova vs Calendar report
// ---------------------------------------------------------------------------

export type DailyReportShow = {
  calendarTitle: string;
  calendarDate: string | null; // YYYY-MM-DD (Athens)
  calendarTime: string | null; // HH:mm Athens
  centovaDate: string | null;  // YYYY-MM-DD
  centovaTime: string | null;  // HH:mm Athens
  audioUploaded: boolean;
  status: "match" | "time_mismatch" | "date_mismatch" | "missing_in_centova";
};

export type UnmatchedCentovaPlaylist = {
  title: string;
  scheduledTime: string; // HH:mm
};

export function buildDailyReportHtml(opts: {
  reportDate: string;
  shows: DailyReportShow[];
  unmatchedCentova: UnmatchedCentovaPlaylist[];
}): { html: string; subject: string } {
  const matched = opts.shows.filter((s) => s.status === "match").length;
  const mismatched = opts.shows.filter((s) => s.status === "time_mismatch" || s.status === "date_mismatch").length;
  const missing = opts.shows.filter((s) => s.status === "missing_in_centova").length;

  const statusBadge = (status: DailyReportShow["status"]) => {
    if (status === "match")
      return `<span style="color:${C.blue};font-weight:700;">✓ Match</span>`;
    if (status === "date_mismatch")
      return `<span style="color:${C.amber};font-weight:700;">⚠ Date mismatch</span>`;
    if (status === "time_mismatch")
      return `<span style="color:${C.amber};font-weight:700;">⚠ Time mismatch</span>`;
    return `<span style="color:${C.red};font-weight:700;">✗ Not in Centova</span>`;
  };

  const audioBadge = (uploaded: boolean) =>
    uploaded
      ? `<span style="color:${C.blue};font-weight:700;">✓ Uploaded</span>`
      : `<span style="color:${C.red};font-weight:700;">✗ Not found</span>`;

  const summaryTag = (bg: string, fg: string, label: string) =>
    `<span style="display:inline-block;padding:5px 14px;border-radius:4px;background:${bg};color:${fg};font-size:13px;font-weight:700;margin-right:8px;">${label}</span>`;

  const calendarRows = opts.shows
    .map(
      (show) => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.white};">${show.calendarTitle}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">${show.calendarDate ?? "–"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">${show.calendarTime ?? "–"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">${show.centovaDate ?? "–"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">${show.centovaTime ?? "–"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #222;">${audioBadge(show.audioUploaded)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #222;">${statusBadge(show.status)}</td>
    </tr>`,
    )
    .join("");

  const unmatchedRows =
    opts.unmatchedCentova.length > 0
      ? `<tr>
          <td colspan="4" style="padding:20px 12px 6px;font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;">
            In Centova but not in Calendar
          </td>
        </tr>` +
        opts.unmatchedCentova
          .map(
            (p) => `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.white};">${p.title}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">–</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">–</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">–</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">${p.scheduledTime}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.muted};">–</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;color:${C.amber};font-weight:700;">⚠ Not in Calendar</td>
        </tr>`,
          )
          .join("")
      : "";

  const noShowsNote =
    opts.shows.length === 0 && opts.unmatchedCentova.length === 0
      ? `<tr><td style="padding:24px 12px;color:${C.muted};font-size:14px;">No shows scheduled for this date in either Calendar or Centova.</td></tr>`
      : "";

  const body = `
    <tr>
      <td style="padding:36px 0 20px;">
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:${C.white};">Daily show report</h1>
        <p style="margin:0;font-size:14px;color:${C.muted};">Shows scheduled for <strong style="color:${C.white};">${opts.reportDate}</strong></p>
      </td>
    </tr>
    ${
      opts.shows.length > 0 || opts.unmatchedCentova.length > 0
        ? `<tr>
            <td style="padding-bottom:24px;">
              ${summaryTag(C.greenBg, C.green, `✓ ${matched} matched`)}
              ${mismatched > 0 ? summaryTag(C.amberBg, C.amber, `⚠ ${mismatched} mismatch`) : ""}
              ${missing > 0 ? summaryTag(C.redBg, C.red, `✗ ${missing} missing`) : ""}
              ${opts.unmatchedCentova.length > 0 ? summaryTag(C.amberBg, C.amber, `⚠ ${opts.unmatchedCentova.length} Centova-only`) : ""}
            </td>
          </tr>`
        : ""
    }
    <tr>
      <td>
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px;">
          ${opts.shows.length > 0 || opts.unmatchedCentova.length > 0 ? tableHeader("Show (Calendar)", "Calendar date", "Calendar time", "Centova date", "Centova time", "Audio", "Status") : ""}
          ${calendarRows}
          ${unmatchedRows}
          ${noShowsNote}
        </table>
      </td>
    </tr>`;

  return { html: emailWrapper(body), subject: `Daily show report — ${opts.reportDate}` };
}

export async function sendDailyReportEmail(opts: {
  reportDate: string;
  shows: DailyReportShow[];
  unmatchedCentova: UnmatchedCentovaPlaylist[];
}): Promise<void> {
  const resend = getResend();
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) throw new Error("Missing ADMIN_EMAIL environment variable.");
  const { html, subject } = buildDailyReportHtml(opts);
  await resend.emails.send({ from: FROM, to: adminEmail, subject, html });
}
