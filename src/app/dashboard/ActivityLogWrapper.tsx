"use client";
import DashboardActivityLog, { ActivityLogRow } from "./_client/DashboardActivityLog";

export default function ActivityLogWrapper({ rows }: { rows: ActivityLogRow[] }) {
  return <DashboardActivityLog rows={rows} />;
}
