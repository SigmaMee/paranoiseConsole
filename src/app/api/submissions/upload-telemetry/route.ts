import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type UploadTelemetryPayload = {
  objectKey?: string;
  uploadId?: string;
  partNumber?: number;
  attempt?: number;
  field?: "audio" | "image";
  fileName?: string;
  fileSize?: number;
  chunkSize?: number;
  statusCode?: number;
  message?: string;
  responseBody?: string;
};

function getAdminSupabase() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user?.id || !user.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = (await request.json()) as UploadTelemetryPayload;

    const normalized = {
      user_id: user.id,
      user_email: user.email,
      object_key: typeof payload.objectKey === "string" ? payload.objectKey : null,
      upload_id: typeof payload.uploadId === "string" ? payload.uploadId : null,
      part_number: typeof payload.partNumber === "number" ? payload.partNumber : null,
      attempt: typeof payload.attempt === "number" ? payload.attempt : null,
      field: payload.field === "audio" || payload.field === "image" ? payload.field : null,
      file_name: typeof payload.fileName === "string" ? payload.fileName : null,
      file_size: typeof payload.fileSize === "number" ? payload.fileSize : null,
      chunk_size: typeof payload.chunkSize === "number" ? payload.chunkSize : null,
      status_code: typeof payload.statusCode === "number" ? payload.statusCode : null,
      message: typeof payload.message === "string" ? payload.message : "Unknown multipart upload error",
      response_body:
        typeof payload.responseBody === "string" ? payload.responseBody.slice(0, 2000) : null,
    };

    console.error("[UPLOAD_PART_FAILURE]", normalized);

    const adminSupabase = getAdminSupabase();
    if (!adminSupabase) {
      return NextResponse.json({ success: true, persisted: false });
    }

    const { error } = await adminSupabase.from("upload_part_failures").insert(normalized);
    if (error) {
      console.error("[UPLOAD_PART_FAILURE_PERSIST_ERROR]", error.message);
      return NextResponse.json({ success: true, persisted: false, reason: error.message });
    }

    return NextResponse.json({ success: true, persisted: true });
  } catch (error) {
    console.error("[UPLOAD_PART_FAILURE_ENDPOINT_ERROR]", error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
