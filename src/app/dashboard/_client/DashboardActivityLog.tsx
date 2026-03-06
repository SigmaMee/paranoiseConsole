"use client";
import React from "react";
import styles from "../status-chips.module.css";
import bulkStyles from "../bulk-action.module.css";
import logStyles from "../activity-log.module.css";

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
  const match = airingDateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return airingDateIso;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export default function DashboardActivityLog({ rows }: { rows: ActivityLogRow[] }) {
  const [selected, setSelected] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState<{ type: "success" | "error"; text: string } | null>(null);
  const [progress, setProgress] = React.useState(0);

  const handleSelect = (idx: number) => {
    setSelected((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  };
  const handleRowClick = (idx: number, row: ActivityLogRow) => {
    if (row.mixcloud === "ready") handleSelect(idx);
  };

  const handleBulkPublish = async () => {
    if (selected.length === 0) return;

    setLoading(true);
    setMessage(null);
    setProgress(0);

    let progressInterval: NodeJS.Timeout | null = null;

    try {
      const submissionIds = selected.map((idx) => rows[idx].id);
      console.log("Selected indices:", selected);
      console.log("Submission IDs to publish:", submissionIds);
      console.log("Full rows:", selected.map((idx) => rows[idx]));
      
      // Simulate progress during upload with logarithmic slowdown
      progressInterval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 90) return 90; // Cap at 90% until complete
          // Slow down as we get closer to 90% (logarithmic approach)
          const remaining = 90 - prev;
          const increment = Math.max(0.5, remaining * 0.08);
          return Math.min(prev + increment, 90);
        });
      }, 800);
      
      const response = await fetch("/api/submissions/mixcloud-publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionIds }),
      });

      if (progressInterval) clearInterval(progressInterval);

      const data = await response.json();
      console.log("API response:", data);

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to publish submissions." });
        setProgress(0);
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
      setProgress(100);
      setSelected([]);

      // Reload page after 2 seconds to show updated status
      setTimeout(() => window.location.reload(), 2000);
    } catch (err: any) {
      if (progressInterval) clearInterval(progressInterval);
      setMessage({ type: "error", text: err.message || "Network error. Please try again." });
      setProgress(0);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className={bulkStyles["dashboard-bulk-action-bar"]}>
        <button
          className="btn-neutral"
          disabled={selected.length === 0 || loading}
          onClick={handleBulkPublish}
        >
          {loading ? "Publishing..." : "Publish to Mixcloud"}
        </button>
        {message && (
          <p className={message.type === "success" ? "success" : "error"} style={{ marginLeft: "1rem" }}>
            {message.text}
          </p>
        )}
      </div>
      {loading && (
        <div className={bulkStyles["progress-bar-container"]}>
          <div 
            className={bulkStyles["progress-bar"]} 
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
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
              <tr
                key={`${row.producer}-${row.airingDate || "none"}-${idx}`}
                className={
                  logStyles["activity-log-row"] +
                  (selected.includes(idx) ? " " + logStyles["selected"] : "")
                }
                onClick={() => handleRowClick(idx, row)}
              >
                <td>
                  <input
                    type="checkbox"
                    className={logStyles["activity-log-checkbox"]}
                    checked={selected.includes(idx)}
                    disabled={row.mixcloud !== "ready"}
                    onChange={(e) => {
                      e.stopPropagation();
                      handleSelect(idx);
                    }}
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
