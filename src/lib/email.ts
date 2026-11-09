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
// 1. Media submission confirmations
// ---------------------------------------------------------------------------

export type MediaConfirmationEmailPayload = {
  to: string;
  producerName: string;
  showTitle: string;
  showStartAt: string | null;
};

export type CoverConfirmationEmailPayload = MediaConfirmationEmailPayload & {
  storyArtwork?: {
    filename: string;
    content: Buffer;
    contentType: string;
  } | null;
};

function buildMediaConfirmationHtml(
  payload: MediaConfirmationEmailPayload,
  subject: string,
  message: string,
): { html: string; subject: string } {
  const showDateFormatted = payload.showStartAt
    ? formatInTimeZone(new Date(payload.showStartAt), ATHENS_TZ, "d MMMM yyyy 'at' HH:mm")
    : null;

  const body = `
    <tr>
      <td style="padding:36px 0 20px;">
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:${C.white};">${subject}</h1>
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
        <p style="margin:0 0 8px;font-size:14px;color:#ccc;line-height:1.6;">${message}</p>
        <p style="margin:0;font-size:13px;color:${C.muted};line-height:1.6;">${payload.showTitle}</p>
      </td>
    </tr>`;

  return { html: emailWrapper(body), subject };
}

export function buildCoverConfirmationHtml(payload: CoverConfirmationEmailPayload) {
  return buildMediaConfirmationHtml(
    payload,
    "Your upcoming show on Paranoise now has a cover",
    "Thanks for the pic! 😎 Here's a version in attachment of it you can use in a story. Don't forget to tag the radio!",
  );
}

export function buildAudioConfirmationHtml(payload: MediaConfirmationEmailPayload) {
  return buildMediaConfirmationHtml(
    payload,
    "Audio is in, loud and clear!",
    "On air soon, if it hasn't already aired, and soon on mixcloud and website. Thanks for the transmission!",
  );
}

export async function sendCoverConfirmationEmail(
  payload: CoverConfirmationEmailPayload,
): Promise<void> {
  const resend = getResend();
  const { html, subject } = buildCoverConfirmationHtml(payload);
  await resend.emails.send({
    from: FROM,
    to: payload.to,
    subject,
    html,
    attachments: payload.storyArtwork
      ? [{
          filename: payload.storyArtwork.filename,
          content: payload.storyArtwork.content,
          contentType: payload.storyArtwork.contentType,
        }]
      : undefined,
  });
}

export async function sendAudioConfirmationEmail(
  payload: MediaConfirmationEmailPayload,
): Promise<void> {
  const resend = getResend();
  const { html, subject } = buildAudioConfirmationHtml(payload);
  await resend.emails.send({
    from: FROM,
    to: payload.to,
    subject,
    html,
  });
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
  const readyToStream = opts.shows.filter(
    (show) => show.status === "match" && show.audioUploaded,
  ).length;
  const notReadyToStream = opts.shows.length - readyToStream;

  const statusBadge = (status: DailyReportShow["status"]) => {
    if (status === "match")
      return `<span style="color:${C.blue};font-weight:700;">✓ Match</span>`;
    if (status === "date_mismatch")
      return `<span style="color:${C.amber};font-weight:700;">⚠ Date mismatch</span>`;
    if (status === "time_mismatch")
      return `<span style="color:${C.amber};font-weight:700;">⚠ Time mismatch</span>`;
    return `<span style="color:${C.red};font-weight:700;">✗ No playlist found</span>`;
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
              ${summaryTag(C.greenBg, C.green, `✓ ${readyToStream} ready to stream`)}
              ${notReadyToStream > 0 ? summaryTag(C.redBg, C.red, `✗ ${notReadyToStream} not ready to stream`) : ""}
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
