import { NextResponse } from "next/server";
import {
  buildSubmissionConfirmationHtml,
  buildDailyReportHtml,
} from "@/lib/email";

// ---------------------------------------------------------------------------
// Dev-only email template preview — NOT available in production
// ---------------------------------------------------------------------------

export const runtime = "nodejs";

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not available in production" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const template = searchParams.get("template") ?? "confirmation";

  let html: string;

  if (template === "report") {
    ({ html } = buildDailyReportHtml({
      reportDate: "19 March 2026",
      shows: [
        {
          calendarTitle: "Azem",
          calendarDate: "2026-03-20",
          calendarTime: "22:00",
          centovaDate: "2026-03-20",
          centovaTime: "22:00",
          audioUploaded: true,
          status: "match",
        },
        {
          calendarTitle: "Yardy",
          calendarDate: "2026-03-20",
          calendarTime: "20:00",
          centovaDate: "2026-03-21",
          centovaTime: "20:00",
          audioUploaded: true,
          status: "date_mismatch",
        },
        {
          calendarTitle: "Deep Cuts",
          calendarDate: "2026-03-20",
          calendarTime: "18:00",
          centovaDate: null,
          centovaTime: null,
          audioUploaded: false,
          status: "missing_in_centova",
        },
      ],
      unmatchedCentova: [
        { title: "LateBroadcast", scheduledTime: "23:30" },
      ],
    }));
  } else {
    ({ html } = buildSubmissionConfirmationHtml({
      to: "producer@example.com",
      producerName: "Azem",
      showTitle: "Azem — Culture Gazon mix",
      showStartAt: "2026-04-19T19:00:00.000Z",
      audioFilename: "Azem - Culture Gazon mix-190426.mp3",
      imageFilename: "Azem-190426.jpg",
      hasDescription: true,
      ftpSuccess: true,
      driveSuccess: true,
      centovaResult: {
        success: true,
        message: "Scheduled playlist \"Azem\" for 2026-04-19 22:00:00 Athens time",
      },
    }));
  }

  const nav = `<div style="font-family:Arial,sans-serif;background:#333;padding:10px 20px;display:flex;gap:16px;align-items:center;">
    <span style="color:#aaa;font-size:12px;text-transform:uppercase;letter-spacing:.06em;">Email Preview</span>
    <a href="?template=confirmation" style="color:${template === "confirmation" ? "#44c8f5" : "#fff"};text-decoration:none;font-size:13px;">Submission confirmation</a>
    <a href="?template=report"       style="color:${template === "report"       ? "#44c8f5" : "#fff"};text-decoration:none;font-size:13px;">Daily report</a>
  </div>`;

  return new NextResponse(nav + html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
