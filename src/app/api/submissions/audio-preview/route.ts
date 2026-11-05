import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { getProducerEmail } from "@/lib/producer-identity";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

function toAiringDateIso(showStart: string) {
  const directMatch = showStart.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];

  const parsed = new Date(showStart);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function requestedRange(request: Request, totalBytes: number) {
  const header = request.headers.get("range");
  const match = header?.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= totalBytes) {
    return null;
  }

  return { start, end: Math.min(Math.max(start, requestedEnd), totalBytes - 1) };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const showStart = url.searchParams.get("showStart")?.trim() || "";
  const airingDate = showStart ? toAiringDateIso(showStart) : null;
  if (!airingDate) return new NextResponse(null, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const baseSelection = "audio_filename,audio_object_key" as const;
  const { data: exactRows, error: exactError } = await supabase
    .from("submissions")
    .select(baseSelection)
    .eq("show_start_at", showStart)
    .ilike("producer_email", getProducerEmail(user))
    .eq("ftp_status", "success")
    .neq("audio_filename", "")
    .order("created_at", { ascending: false })
    .limit(20);

  if (exactError) return NextResponse.json({ error: "Audio preview could not be loaded." }, { status: 500 });

  const fallbackResult = exactRows?.length ? null : await supabase
    .from("submissions")
    .select(baseSelection)
    .eq("airing_date", airingDate)
    .ilike("producer_email", getProducerEmail(user))
    .eq("ftp_status", "success")
    .neq("audio_filename", "")
    .order("created_at", { ascending: false })
    .limit(20);

  if (fallbackResult?.error) {
    return NextResponse.json({ error: "Audio preview could not be loaded." }, { status: 500 });
  }
  const rows = exactRows?.length ? exactRows : fallbackResult?.data;
  const audio = rows?.find((row) => typeof row.audio_object_key === "string" && row.audio_object_key);
  if (!audio?.audio_object_key) return new NextResponse(null, { status: 404 });

  try {
    const head = await r2.send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: audio.audio_object_key,
    }));
    const totalBytes = head.ContentLength;
    if (!totalBytes) return new NextResponse(null, { status: 404 });

    const range = requestedRange(request, totalBytes);
    const object = await r2.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: audio.audio_object_key,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    }));
    if (!object.Body) return new NextResponse(null, { status: 404 });

    const contentLength = range ? range.end - range.start + 1 : totalBytes;
    return new NextResponse(object.Body.transformToWebStream(), {
      status: range ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": String(contentLength),
        "Content-Type": object.ContentType || "audio/mpeg",
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${totalBytes}` } : {}),
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
