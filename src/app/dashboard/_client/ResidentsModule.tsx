"use client";

import React from "react";
import styles from "../residents-module.module.css";
import ModalCloseButton from "./ModalCloseButton";

export type ResidentRow = {
  id: string;
  producerName: string;
  showName: string | null;
  showType: "Recorded";
  emails: string[];
  webflowProfilePictureUrl: string | null;
  webflowProfilePictureAlt: string | null;
  webflowRadioShow: string | null;
  webflowCity: string | null;
  webflowAbout: string | null;
  webflowFollowLink: string | null;
};

export default function ResidentsModule({ rows }: { rows: ResidentRow[] }) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<ResidentRow | null>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLElement>(null);
  const previouslyFocusedRef = React.useRef<HTMLElement | null>(null);

  const filteredRows = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return rows;
    return rows.filter((row) =>
      [row.producerName, row.showName || "", row.showType, ...row.emails]
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [query, rows]);

  React.useEffect(() => {
    if (!selected) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, [href], [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [selected]);

  const openResident = (row: ResidentRow) => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSelected(row);
  };

  return (
    <div className={styles.workspace}>
      <div className={styles.heading}>
        <div>
          <h1 className={styles.title}>Residents</h1>
          <p className={styles.summary}>{rows.length} resident{rows.length === 1 ? "" : "s"}</p>
        </div>
        <label className={styles.searchLabel}>
          <span className={styles.visuallyHidden}>Search residents</span>
          <input
            className={styles.search}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search residents"
          />
        </label>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Producer</th>
              <th scope="col">Radio show</th>
              <th scope="col">Type</th>
              <th scope="col">Email address(es)</th>
              <th scope="col">Roles</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} className={styles.clickableRow} onClick={() => openResident(row)}>
                <td>
                  <button className={styles.rowButton} type="button" onClick={() => openResident(row)}>
                    {row.producerName}
                  </button>
                </td>
                <td>{row.showName || "—"}</td>
                <td>{row.showType}</td>
                <td>{row.emails.join(", ")}</td>
                <td><span className={styles.placeholder}>—</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredRows.length === 0 ? (
          <p className={styles.empty} role="status">No residents match “{query}”.</p>
        ) : null}
      </div>

      {selected ? (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
          }}>
          <section ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="resident-panel-title">
            <header className={styles.profileHero}>
              {selected.webflowProfilePictureUrl ? (
                /* Webflow CMS images are external and their host may vary per item. */
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={selected.webflowProfilePictureUrl} alt="" />
              ) : null}
              <h2 id="resident-panel-title" className={styles.panelTitle}>{selected.producerName}</h2>
              <ModalCloseButton ref={closeButtonRef} className={styles.closeButton} onClick={() => setSelected(null)} aria-label="Close resident details" />
            </header>

            <form className={styles.form} onSubmit={(event) => event.preventDefault()}>
              <label>Radio show<input defaultValue={selected.showName || selected.webflowRadioShow || ""} /></label>
              <label>City<input defaultValue={selected.webflowCity || ""} /></label>
              <label>Type<select defaultValue={selected.showType}><option>Recorded</option><option>Live</option></select></label>
              <label>Email address(es)<textarea defaultValue={selected.emails.join("\n")} rows={Math.max(2, selected.emails.length)} /></label>
              <label>Roles<input defaultValue="" placeholder="To be defined" readOnly /></label>
              <label>About<textarea defaultValue={selected.webflowAbout || ""} rows={8} /></label>
              <label>Follow Link<input type="url" defaultValue={selected.webflowFollowLink || ""} /></label>
              <p className={styles.formNote}>Saving is intentionally unavailable until edit behavior and downstream impact are defined.</p>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
