"use client";
import { useState } from "react";
import styles from "./status-chips.module.css";
import bulkStyles from "./bulk-action.module.css";

export type ActivityLogRow = {
  id: string;
  producer: string;
  airingDate: string | null;
  hasAudio: boolean;
  hasCoverImage: boolean;
  hasDescription: boolean;
  hasTags: boolean;
  mixcloud: string;
};

function formatAiringDate(airingDateIso: string | null) {
  if (!airingDateIso) return "-";
  const match = airingDateIso.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!match) return airingDateIso;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export default function DashboardActivityLog({ rows }: { rows: ActivityLogRow[] }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSelect = (idx: number) => {
    setSelected((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  };

  const handleBulkPublish = async () => {
    if (selected.length === 0) return;

    setLoading(true);
    setMessage(null);

    try {
      const submissionIds = selected.map((idx) => rows[idx].id);
      const response = await fetch("/api/submissions/mixcloud-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionIds }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to publish submissions." });
        return;
      }

      // Count successes
      const successCount = (data.results || []).filter((r: any) => r.status === "published").length;
      const failureCount = (data.results || []).filter((r: any) => r.status === "error").length;

      let feedbackText = `Published ${successCount} submission${successCount !== 1 ? "s" : ""}`;
      if (failureCount > 0) {
        feedbackText += ` (${failureCount} failed).`;
      } else {
        feedbackText += ".";
      }

      setMessage({ type: "success", text: feedbackText });
      setSelected([]);

      // Optional: Reload page after 2 seconds to show updated status
      setTimeout(() => window.location.reload(), 2000);
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Network error. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className={bulkStyles["dashboard-bulk-action-bar"]}>
        <button
          className={bulkStyles["dashboard-bulk-action-btn"]}
          disabled={selected.length === 0 || loading}
          onClick={handleBulkPublish}
        >
          {loading ? "Publishing..." : "Publish to Mixcloud"}
        </button>
        {message && (
          <div
            style={{
              marginLeft: "1rem",
              padding: "0.5rem 1rem",
              borderRadius: "0.25rem",
              fontSize: "0.875rem",
              backgroundColor: message.type === "success" ? "#d1fae5" : "#fee2e2",
              color: message.type === "success" ? "#065f46" : "#7f1d1d",
            }}
          >
            {message.text}
          </div>
        )}
      </div>
      <div className="dashboard-activity-table-wrap">
        <table className="dashboard-activity-table">
          <thead>
            <tr>
              <th></th>
              <th>Producer</th>
              <th>Airing date</th>
              <th>Audio</th>
              <th>Cover image</th>
              <th>Description</th>
              <th>Tags</th>
              <th>Mixcloud</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={`${row.producer}-${row.airingDate || "none"}-${idx}`}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.includes(idx)}
                    disabled={row.mixcloud !== "ready"}
                    onChange={() => handleSelect(idx)}
                  />
                </td>
                <td>{row.producer}</td>
                <td>{formatAiringDate(row.airingDate)}</td>
                <td>
                  <span className={row.hasAudio ? "status-check" : "status-missing"}>
                    {row.hasAudio ? "✓" : "-"}
                  </span>
                </td>
                <td>
                  <span className={row.hasCoverImage ? "status-check" : "status-missing"}>
                    {row.hasCoverImage ? "✓" : "-"}
                  </span>
                </td>
                <td>
                  <span className={row.hasDescription ? "status-check" : "status-missing"}>
                    {row.hasDescription ? "✓" : "-"}
                  </span>
                </td>
                <td>
                  <span className={row.hasTags ? "status-check" : "status-missing"}>
                    {row.hasTags ? "✓" : "-"}
                  </span>
                </td>
                <td>
                  <span
                    className={
                      `${styles["mixcloud-chip"]} ` +
                      (row.mixcloud === "ready"
                        ? styles["mixcloud-chip-ready"]
                        : row.mixcloud === "published"
                        ? styles["mixcloud-chip-published"]
                        : styles["mixcloud-chip-not-ready"])
                    }
                  >
                    {row.mixcloud}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
