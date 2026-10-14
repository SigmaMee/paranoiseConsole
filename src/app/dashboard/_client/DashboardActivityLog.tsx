"use client";

import React from "react";
import { useRouter } from "next/navigation";
import boardStyles from "../publish-board.module.css";
import IconActionButton from "./IconActionButton";

export type ActivityLogRow = {
  id: string;
  producer: string;
  calendarTitle: string;
  showStartAt: string | null;
  airingDate: string | null;
  hasAudio: boolean;
  hasCoverImage: boolean;
  hasDescription: boolean;
  hasTags: boolean;
  mixcloud: string;
  mixcloudUrl: string | null;
  mixcloudError: string | null;
  webflow: string;
  webflowItemId: string | null;
  webflowError: string | null;
};

type PublishResult = {
  submissionId?: string;
  status?: string;
  error?: string;
  mixcloudUrl?: string;
};

type PublishResponse = { error?: string; results?: PublishResult[] };
type LogEntry = { id: string; type: "success" | "error" | "info"; text: string };
type Column = "aired" | "mixcloud" | "website";

function formatShowDate(row: ActivityLogRow) {
  const value = row.showStartAt || (row.airingDate ? `${row.airingDate}T12:00:00Z` : "");
  if (!value) return "Date unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: row.showStartAt ? "2-digit" : undefined,
    minute: row.showStartAt ? "2-digit" : undefined,
    timeZone: "Europe/Brussels",
  }).format(new Date(value));
}

function rowColumn(row: ActivityLogRow): Column {
  if (row.webflow === "published") return "website";
  if (row.mixcloud === "published") return "mixcloud";
  return "aired";
}

export default function DashboardActivityLog({ rows: initialRows }: { rows: ActivityLogRow[] }) {
  const router = useRouter();
  const [rows, setRows] = React.useState(initialRows);
  const [selected, setSelected] = React.useState<Record<Column, string[]>>({ aired: [], mixcloud: [], website: [] });
  const [processing, setProcessing] = React.useState<string[]>([]);
  const [progress, setProgress] = React.useState<Record<string, number>>({});
  const [dragging, setDragging] = React.useState<{ source: Column; ids: string[] } | null>(null);
  const [dragTarget, setDragTarget] = React.useState<Column | null>(null);
  const [log, setLog] = React.useState<LogEntry[]>([]);
  const selectionAnchor = React.useRef<{ column: Column; id: string } | null>(null);
  const processingIds = React.useRef(new Set<string>());

  React.useEffect(() => {
    let active = true;
    void fetch("/api/submissions/reconcile-mixcloud", { method: "POST" })
      .then(async (response) => {
        const data = await response.json() as { error?: string; reconciled?: number; results?: Array<{ producer?: string; status?: string }> };
        if (!active) return;
        if (!response.ok) throw new Error(data.error || "Manual Mixcloud upload check failed.");
        if ((data.reconciled || 0) > 0) {
          setLog((current) => [
            ...(data.results || []).map((result, index) => ({
              id: `reconcile-${index}`,
              type: "info" as const,
              text: `${result.producer || "Show"} — ${result.status === "website-reconciled" ? "detected existing website publication" : "detected existing manual Mixcloud upload"}.`,
            })),
            ...current,
          ]);
          router.refresh();
        }
      })
      .catch((error: unknown) => {
        if (active) setLog((current) => [{ id: "reconcile-error", type: "error", text: error instanceof Error ? error.message : "Manual Mixcloud upload check failed." }, ...current]);
      });
    return () => { active = false; };
  }, [router]);

  React.useEffect(() => {
    setRows((current) => {
      const currentById = new Map(current.map((row) => [row.id, row]));
      return initialRows.map((incoming) => processingIds.current.has(incoming.id)
        ? currentById.get(incoming.id) || incoming
        : incoming);
    });
  }, [initialRows]);

  const columns: Array<{ id: Column; title: string }> = [
    { id: "aired", title: "Aired" },
    { id: "mixcloud", title: "Published to Mixcloud" },
    { id: "website", title: "Published to website" },
  ];

  const byColumn = (column: Column) => rows.filter((row) => rowColumn(row) === column);
  const eligible = (row: ActivityLogRow, column: Column) => column !== "mixcloud" || (row.hasCoverImage && ["ready", "failed", "not ready"].includes(row.webflow));
  const nextColumn = (column: Column): Column | null => column === "aired" ? "mixcloud" : column === "mixcloud" ? "website" : null;

  const selectCard = (event: React.MouseEvent | React.KeyboardEvent, column: Column, row: ActivityLogRow) => {
    if (processing.includes(row.id) || !eligible(row, column)) return;
    const visibleIds = byColumn(column).filter((item) => eligible(item, column) && !processing.includes(item.id)).map((item) => item.id);
    const additive = event.metaKey || event.ctrlKey;
    const anchor = selectionAnchor.current;
    setSelected((current) => {
      let ids: string[];
      if (event.shiftKey && anchor?.column === column) {
        const start = visibleIds.indexOf(anchor.id);
        const end = visibleIds.indexOf(row.id);
        const range = start >= 0 && end >= 0 ? visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1) : [row.id];
        ids = additive ? Array.from(new Set([...current[column], ...range])) : range;
      } else if (additive) {
        ids = current[column].includes(row.id) ? current[column].filter((id) => id !== row.id) : [...current[column], row.id];
      } else {
        ids = [row.id];
      }
      return { aired: [], mixcloud: [], website: [], [column]: ids };
    });
    if (!event.shiftKey) selectionAnchor.current = { column, id: row.id };
  };

  const selectAll = (column: Column) => {
    const ids = byColumn(column).filter((row) => eligible(row, column) && !processing.includes(row.id)).map((row) => row.id);
    setSelected({ aired: [], mixcloud: [], website: [], [column]: ids });
  };

  const advanceCards = async (column: Column, requestedIds: string[]) => {
    const destination = nextColumn(column);
    const ids = requestedIds.filter((id) => {
      const row = rows.find((item) => item.id === id);
      return row && rowColumn(row) === column && eligible(row, column) && !processing.includes(id);
    });
    if (!destination || ids.length === 0) return;
    const endpoint = column === "aired" ? "/api/submissions/mixcloud-publish" : "/api/submissions/webflow-publish";
    const originals = new Map(rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, row]));
    ids.forEach((id) => processingIds.current.add(id));
    setProcessing((current) => [...current, ...ids]);
    setProgress((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, 8])) }));
    setRows((current) => current.map((row) => ids.includes(row.id)
      ? column === "aired"
        ? { ...row, mixcloud: "published", webflow: row.hasCoverImage ? "ready" : "not ready" }
        : { ...row, webflow: "published" }
      : row));
    setSelected({ aired: [], mixcloud: [], website: [] });
    const progressTimer = window.setInterval(() => {
      setProgress((current) => Object.fromEntries(Object.entries(current).map(([id, value]) => [id, ids.includes(id) ? Math.min(92, value + Math.max(1, (92 - value) * 0.1)) : value])));
    }, 500);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionIds: ids }),
      });
      const data = await response.json() as PublishResponse;
      if (!response.ok) throw new Error(data.error || "Publishing failed.");

      const results = data.results || [];
      setRows((current) => current.map((row) => {
        const result = results.find((item) => item.submissionId === row.id);
        if (!ids.includes(row.id)) return row;
        if (result?.status !== "published") return originals.get(row.id) || row;
        return column === "aired" ? { ...row, mixcloudUrl: result.mixcloudUrl || row.mixcloudUrl, mixcloudError: null } : { ...row, webflowError: null };
      }));
      const successfulIds = results.filter((result) => result.status === "published" && result.submissionId).map((result) => result.submissionId as string);
      setProgress((current) => ({ ...current, ...Object.fromEntries(successfulIds.map((id) => [id, 100])) }));
      setLog((current) => [
        ...results.map((result, index) => {
          const row = rows.find((item) => item.id === result.submissionId);
          const success = result.status === "published";
          return {
            id: `${Date.now()}-${index}`,
            type: success ? "success" as const : "error" as const,
            text: `${row?.producer || "Show"} — ${success ? `${column === "aired" ? "published to Mixcloud" : "published to website"}.` : `failed: ${(result.error || "unknown error").replace(/[.!?]+$/, "")}.`}`,
          };
        }),
        ...current,
      ]);
    } catch (error) {
      setRows((current) => current.map((row) => originals.get(row.id) || row));
      setLog((current) => [{ id: `${Date.now()}-request`, type: "error", text: error instanceof Error ? error.message : "Publishing failed." }, ...current]);
    } finally {
      window.clearInterval(progressTimer);
      window.setTimeout(() => {
        ids.forEach((id) => processingIds.current.delete(id));
        setProcessing((current) => current.filter((id) => !ids.includes(id)));
        setProgress((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !ids.includes(id))));
      }, 500);
    }
  };

  const downloadSelected = async () => {
    const ids = selected.aired;
    if (ids.length === 0) return;
    ids.forEach((id) => processingIds.current.add(id));
    setProcessing((current) => [...current, ...ids]);
    try {
      const response = await fetch("/api/submissions/download-shows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ submissionIds: ids }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || "Download failed.");
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("The downloaded archive is empty.");
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `paranoise-shows-${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setLog((current) => [{ id: `${Date.now()}-download`, type: "success", text: `Downloaded ${ids.length} show package${ids.length === 1 ? "" : "s"}.` }, ...current]);
    } catch (error) {
      setLog((current) => [{ id: `${Date.now()}-download-error`, type: "error", text: error instanceof Error ? error.message : "Download failed." }, ...current]);
    } finally {
      ids.forEach((id) => processingIds.current.delete(id));
      setProcessing((current) => current.filter((id) => !ids.includes(id)));
    }
  };

  return (
    <div className={boardStyles["publish-workspace"]}>
      <div className={boardStyles["publish-board"]} aria-label="Publishing workflow">
        {columns.map((column) => {
          const columnRows = byColumn(column.id);
          const selectableRows = columnRows.filter((row) => eligible(row, column.id));
          const selectedIds = selected[column.id];
          const acceptsDrag = Boolean(dragging && nextColumn(dragging.source) === column.id);
          return (
            <section
              className={`${boardStyles["publish-column"]} ${dragTarget === column.id ? boardStyles["publish-column-drag-target"] : ""}`}
              key={column.id}
              aria-labelledby={`${column.id}-heading`}
              onDragOver={(event) => {
                if (!acceptsDrag) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragTarget(column.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (acceptsDrag && dragging) void advanceCards(dragging.source, dragging.ids);
                setDragTarget(null);
                setDragging(null);
              }}
            >
              <header className={boardStyles["column-header"]}>
                <div>
                  <h3 id={`${column.id}-heading`}>{column.title}</h3>
                  <span className={boardStyles["column-count"]}>{columnRows.length}</span>
                </div>
                {column.id === "aired" ? (
                  <div className={boardStyles["column-actions"]}>
                    <IconActionButton
                      className={boardStyles["archive-action"]}
                      label="Download selected shows"
                      disabled={selected.aired.length === 0}
                      onClick={() => void downloadSelected()}
                      icon={<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg>}
                    />
                  </div>
                ) : null}
              </header>
              <div className={boardStyles["selection-row"]}>
                <button
                  type="button"
                  className={`btn-tertiary ${selectedIds.length === 0 ? boardStyles["selection-action-hidden"] : ""}`}
                  disabled={selectedIds.length === 0 || selectedIds.length === selectableRows.length}
                  onClick={() => selectAll(column.id)}
                  tabIndex={selectedIds.length === 0 ? -1 : 0}
                  aria-hidden={selectedIds.length === 0}
                >
                  Select all
                </button>
              </div>
              <div className={boardStyles["card-list"]} role="listbox" aria-multiselectable="true" aria-label={`${column.title} shows`}>
                {columnRows.length === 0 ? <p className={boardStyles["empty-column"]}>No shows in this stage.</p> : null}
                {columnRows.map((row) => {
                  const isEligible = eligible(row, column.id);
                  const isProcessing = processing.includes(row.id);
                  const isSelected = selectedIds.includes(row.id);
                  const canAdvance = Boolean(nextColumn(column.id) && isEligible && !isProcessing);
                  return (
                    <article
                      className={`${boardStyles["show-card"]} ${isSelected ? boardStyles["show-card-selected"] : ""} ${isProcessing && progress[row.id] !== undefined ? boardStyles["show-card-processing"] : ""}`}
                      key={row.id}
                      role="option"
                      aria-selected={isSelected}
                      aria-label={`${row.calendarTitle}, aired ${formatShowDate(row)}${canAdvance ? ". Drag to the next column or press the right arrow to publish." : ""}`}
                      tabIndex={isEligible && !isProcessing ? 0 : -1}
                      draggable={canAdvance}
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest("a, button")) return;
                        selectCard(event, column.id, row);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === " " || event.key === "Enter") {
                          event.preventDefault();
                          selectCard(event, column.id, row);
                        }
                        if (event.key === "ArrowRight" && canAdvance) {
                          event.preventDefault();
                          void advanceCards(column.id, isSelected ? selectedIds : [row.id]);
                        }
                      }}
                      onDragStart={(event) => {
                        if (!canAdvance) return event.preventDefault();
                        const ids = isSelected ? selectedIds : [row.id];
                        if (!isSelected) setSelected({ aired: [], mixcloud: [], website: [], [column.id]: ids });
                        setDragging({ source: column.id, ids });
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", ids.join(","));
                      }}
                      onDragEnd={() => { setDragging(null); setDragTarget(null); }}
                    >
                      <div className={boardStyles["card-copy"]}>
                        <h4>{row.calendarTitle}</h4>
                        <p>{formatShowDate(row)}</p>
                        <div className={boardStyles["flags"]} aria-label="Missing submission details">
                          {!row.hasCoverImage ? <span>Image missing</span> : null}
                          {!row.hasTags ? <span>Tags missing</span> : null}
                          {!row.hasDescription ? <span>Description missing</span> : null}
                        </div>
                        {column.id !== "aired" && row.mixcloudUrl ? <a href={row.mixcloudUrl} target="_blank" rel="noreferrer">Open on Mixcloud</a> : null}
                        {column.id === "mixcloud" && !row.hasCoverImage ? <p className={boardStyles["blocking-note"]}>Add an image before website publishing.</p> : null}
                        {column.id === "aired" && row.mixcloudError ? <p className={boardStyles["blocking-note"]}>{row.mixcloudError}</p> : null}
                        {row.webflowError && column.id === "mixcloud" ? <p className={boardStyles["blocking-note"]}>{row.webflowError}</p> : null}
                        {isProcessing && progress[row.id] !== undefined ? <p className={boardStyles["processing-label"]} role="status">Publishing…</p> : null}
                      </div>
                      {progress[row.id] !== undefined ? <progress className={boardStyles["card-progress"]} max={100} value={progress[row.id]} aria-label={`Publishing ${row.calendarTitle}`} /> : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <section className={boardStyles["publish-log"]} aria-labelledby="publish-log-heading" aria-live="polite">
        <h3 id="publish-log-heading">Publishing log</h3>
        {log.length === 0 ? <p>No actions in this session.</p> : (
          <ol>{log.map((entry) => <li className={boardStyles[`log-${entry.type}`]} key={entry.id}>{entry.text}</li>)}</ol>
        )}
      </section>
    </div>
  );
}
