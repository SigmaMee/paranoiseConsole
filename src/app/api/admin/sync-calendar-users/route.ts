import { NextResponse } from "next/server";
import {
  createUsersFromCalendar,
  scanCalendarForProducers,
  type CalendarProducer,
} from "@/lib/calendar-user-sync";
import { isResidentSlug } from "@/lib/resident-slug";
import { requireAdminUser } from "@/lib/admin-access";

export const runtime = "nodejs";
export const maxDuration = 60;

function reviewedProducers(value: unknown): CalendarProducer[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    throw new Error("Create requires one or more reviewed calendar residents.");
  }

  const emails = new Set<string>();
  const slugs = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Invalid reviewed resident.");
    }
    const row = candidate as Record<string, unknown>;
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    const producerName = typeof row.producerName === "string" ? row.producerName.trim() : "";
    const radioShow = typeof row.radioShow === "string" ? row.radioShow.trim() : "";
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    const eventTitle = typeof row.eventTitle === "string" ? row.eventTitle.trim() : "";
    const nextShowStartAt = typeof row.nextShowStartAt === "string" ? row.nextShowStartAt : "";
    const fullName = typeof row.fullName === "string" ? row.fullName.trim() || null : null;

    if (
      !email || !email.includes("@") || !producerName || !radioShow || !eventTitle ||
      !isResidentSlug(slug) || Number.isNaN(new Date(nextShowStartAt).getTime()) ||
      row.slugConflict !== null
    ) {
      throw new Error(`Invalid reviewed resident: ${email || "unknown email"}.`);
    }
    if (emails.has(email) || slugs.has(slug)) {
      throw new Error(`Duplicate reviewed email or slug: ${email}.`);
    }
    emails.add(email);
    slugs.add(slug);
    return {
      email,
      producerName,
      radioShow,
      slug,
      fullName,
      eventTitle,
      nextShowStartAt: new Date(nextShowStartAt).toISOString(),
      slugConflict: null,
    };
  });
}

export async function POST(request: Request) {
  try {
    const authorization = await requireAdminUser();
    if (authorization.response) return authorization.response;

    const body = await request.json();
    const { action } = body;

    if (action === "scan") {
      // Just scan and return the producers
      const producers = await scanCalendarForProducers();
      
      return NextResponse.json({
        success: true,
        producers,
      });
    } else if (action === "create") {
      const result = await createUsersFromCalendar(reviewedProducers(body.producers));

      return NextResponse.json({
        success: true,
        ...result,
      });
    } else {
      return NextResponse.json(
        { error: "Invalid action. Use 'scan' or 'create'." },
        { status: 400 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to sync users from calendar",
      },
      { status: 500 }
    );
  }
}
