import { NextResponse } from "next/server";
import { google } from "googleapis";
import { createClient } from "@/lib/supabase/server";
import { getGoogleDriveOAuthClientFromStoredToken } from "@/lib/google-drive-oauth";
import { getDriveWeekdayFolderIdForShowStart } from "@/lib/submission-routing";

export const runtime = "nodejs";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toAiringDateIso(showStart: string) {
  const directMatch = showStart.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) {
    return directMatch[1];
  }

  const parsed = new Date(showStart);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function escapeDriveQueryLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function getDriveAuth() {
  const serviceAccountEmail = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(
    /\\n/g,
    "\n",
  );

  const serviceAccountAuth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  const oauthClient = await getGoogleDriveOAuthClientFromStoredToken();
  if (oauthClient) {
    try {
      await oauthClient.getAccessToken();
      return oauthClient;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("invalid_grant")) {
        throw error;
      }

      return serviceAccountAuth;
    }
  }

  return serviceAccountAuth;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const showStart = url.searchParams.get("showStart")?.trim() || "";
    if (!showStart) {
      return new NextResponse(null, { status: 204 });
    }

    const airingDate = toAiringDateIso(showStart);
    if (!airingDate) {
      return new NextResponse(null, { status: 204 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: rows, error } = await supabase
      .from("submissions")
      .select("image_filename")
      .eq("airing_date", airingDate)
      .ilike("producer_email", user.email.toLowerCase())
      .eq("drive_status", "success")
      .neq("image_filename", "")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error || !rows || rows.length === 0) {
      return new NextResponse(null, { status: 204 });
    }

    const folderId = await getDriveWeekdayFolderIdForShowStart(showStart);
    const auth = await getDriveAuth();
    const drive = google.drive({ version: "v3", auth });
    let matchedFile: { id: string; mimeType?: string | null } | null = null;

    for (const row of rows) {
      const filename = typeof row.image_filename === "string" ? row.image_filename.trim() : "";
      if (!filename) {
        continue;
      }

      const escapedName = escapeDriveQueryLiteral(filename);
      const fileListResponse = await drive.files.list({
        q: `'${folderId}' in parents and name='${escapedName}' and trashed=false`,
        fields: "files(id,mimeType,createdTime)",
        pageSize: 1,
        orderBy: "createdTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const candidate = (fileListResponse.data.files || []).find((item) => Boolean(item.id));
      if (candidate?.id) {
        matchedFile = { id: candidate.id, mimeType: candidate.mimeType };
        break;
      }
    }

    if (!matchedFile?.id) {
      return new NextResponse(null, { status: 204 });
    }

    const mediaResponse = await drive.files.get(
      {
        fileId: matchedFile.id,
        alt: "media",
        supportsAllDrives: true,
      },
      {
        responseType: "arraybuffer",
      },
    );

    const contentType = matchedFile.mimeType || "image/jpeg";
    return new NextResponse(Buffer.from(mediaResponse.data as ArrayBuffer), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
