import { NextResponse } from "next/server";
import { createUsersFromCalendar } from "@/lib/calendar-user-sync";
import { scanCalendarForProducers } from "@/lib/calendar-user-sync";
import { requireAdminUser } from "@/lib/admin-access";

export const runtime = "nodejs";
export const maxDuration = 60;

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
      // Create the users
      const result = await createUsersFromCalendar();

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
