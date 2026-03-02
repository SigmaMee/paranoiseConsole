"use client";
import { useState } from "react";
import styles from "./status-chips.module.css";
import bulkStyles from "./bulk-action.module.css";

export type ActivityLogRow = {
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

  const handleSelect = (idx: number) => {
    setSelected((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  };

  const handleBulkPublish = () => {
    alert(`Publishing ${selected.length} submissions to Mixcloud...`);
  };

  return (
    <>
      <div className={bulkStyles["dashboard-bulk-action-bar"]}>
        <button
          className={bulkStyles["dashboard-bulk-action-btn"]}
          disabled={selected.length === 0}
          onClick={handleBulkPublish}
        >
          Publish to Mixcloud
        </button>
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
