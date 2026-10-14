"use client";

import React from "react";
import styles from "../calendar-module.module.css";

export type CalendarPicture = {
  id: string;
  dateIso: string;
  filename: string;
  title: string;
  producer: string;
  imageUrl: string | null;
  showStartAt: string | null;
  createdAt: string | null;
  description: string;
  tags: string[];
};

export type CalendarDay = {
  dateIso: string;
  dayNumber: number;
  dayLabel: string;
  scheduledCount: number;
  uploadCount: number;
  status: "future" | "none" | "zero" | "full" | "partial";
  missingShows: Array<{ title: string; producer: string }>;
};

type Props = {
  days: CalendarDay[];
  pictures: CalendarPicture[];
  programmeCopyByDate: Record<string, string>;
  instagramConnected: boolean;
};

const BROADCAST_TIME_ZONE = "Europe/Athens";
const INSTAGRAM_CAPTION_HEADING_LENGTH = "Today on air\n\n".length;
const INSTAGRAM_COPY_MAX_LENGTH = 2_200 - INSTAGRAM_CAPTION_HEADING_LENGTH;

function getTodayIso() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BROADCAST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const valueByPart = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${valueByPart.year}-${valueByPart.month}-${valueByPart.day}`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

export default function CalendarModule({ days, pictures, programmeCopyByDate, instagramConnected }: Props) {
  const calendarRef = React.useRef<HTMLDivElement>(null);
  const calendarTopRef = React.useRef<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [preview, setPreview] = React.useState<CalendarPicture | null>(null);
  const [editableCopyByDate, setEditableCopyByDate] = React.useState<Record<string, string>>(
    () => ({ ...programmeCopyByDate }),
  );
  const [selectedPictureIdsByDate, setSelectedPictureIdsByDate] = React.useState<Record<string, string[]>>(
    () => pictures.reduce<Record<string, string[]>>((selected, picture) => {
      (selected[picture.dateIso] ||= []).push(picture.id);
      return selected;
    }, {}),
  );
  const todayIso = getTodayIso();
  const [expandedDate, setExpandedDate] = React.useState(
    () => days.find((day) => day.dateIso === todayIso)?.dateIso || days[0]?.dateIso || "",
  );

  React.useEffect(() => {
    if (!days.some((day) => day.dateIso === expandedDate)) {
      setExpandedDate(days.find((day) => day.dateIso === todayIso)?.dateIso || days[0]?.dateIso || "");
    }
  }, [days, expandedDate, todayIso]);

  React.useEffect(() => {
    setEditableCopyByDate((current) => ({ ...programmeCopyByDate, ...current }));
  }, [programmeCopyByDate]);

  React.useLayoutEffect(() => {
    if (calendarTopRef.current === null || !calendarRef.current) return;

    const topDifference = calendarRef.current.getBoundingClientRect().top - calendarTopRef.current;
    calendarTopRef.current = null;
    if (topDifference !== 0) window.scrollBy({ top: topDifference, behavior: "instant" });
  }, [expandedDate]);

  const selectDay = React.useCallback((dateIso: string) => {
    if (dateIso === expandedDate) return;
    calendarTopRef.current = calendarRef.current?.getBoundingClientRect().top ?? null;
    setSelectedPictureIdsByDate((current) => ({
      ...current,
      [dateIso]: pictures.filter((picture) => picture.dateIso === dateIso).map((picture) => picture.id),
    }));
    setExpandedDate(dateIso);
  }, [expandedDate, pictures]);

  const togglePictureSelection = (dateIso: string, pictureId: string) => {
    setSelectedPictureIdsByDate((current) => {
      const selectedIds = current[dateIso] || [];
      return {
        ...current,
        [dateIso]: selectedIds.includes(pictureId)
          ? selectedIds.filter((id) => id !== pictureId)
          : [...selectedIds, pictureId],
      };
    });
  };

  const showAdjacentPicture = React.useCallback((offset: number) => {
    setPreview((current) => {
      if (!current || pictures.length < 2) return current;
      const currentIndex = pictures.findIndex((picture) => picture.id === current.id);
      const nextIndex = (currentIndex + offset + pictures.length) % pictures.length;
      return pictures[nextIndex];
    });
  }, [pictures]);

  React.useEffect(() => {
    if (!preview) return;
    const handleLightboxKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
      if (event.key === "ArrowLeft") showAdjacentPicture(-1);
      if (event.key === "ArrowRight") showAdjacentPicture(1);
    };
    document.addEventListener("keydown", handleLightboxKey);
    return () => document.removeEventListener("keydown", handleLightboxKey);
  }, [preview, showAdjacentPicture]);

  const picturesByDate = React.useMemo(() => {
    return pictures.reduce<Record<string, CalendarPicture[]>>((grouped, picture) => {
      (grouped[picture.dateIso] ||= []).push(picture);
      return grouped;
    }, {});
  }, [pictures]);

  const imageSource = (picture: CalendarPicture) =>
    picture.imageUrl || `/api/admin/calendar-images?id=${encodeURIComponent(picture.id)}`;

  const handleImageError = (
    event: React.SyntheticEvent<HTMLImageElement>,
    picture: CalendarPicture,
  ) => {
    if (event.currentTarget.dataset.fallbackApplied === "true") return;
    event.currentTarget.dataset.fallbackApplied = "true";
    event.currentTarget.src = `/api/admin/calendar-images?id=${encodeURIComponent(picture.id)}`;
  };

  const downloadPictures = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/calendar-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionIds: ids }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "The pictures could not be downloaded.");
      }
      const singlePicture = ids.length === 1 ? pictures.find((picture) => picture.id === ids[0]) : null;
      triggerDownload(await response.blob(), singlePicture?.filename || "paranoise-pictures.zip");
      setMessage(`${ids.length} picture${ids.length === 1 ? "" : "s"} downloaded.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The pictures could not be downloaded.");
    } finally {
      setBusy(false);
    }
  };

  const copyProgramme = async (dateIso: string) => {
    const copy = editableCopyByDate[dateIso];
    if (!copy) return;
    try {
      await navigator.clipboard.writeText(copy);
      setMessage("Programme copy copied.");
    } catch {
      setMessage("The programme copy could not be copied.");
    }
  };

  const publishToInstagram = async (dateIso: string, dayPictures: CalendarPicture[]) => {
    const caption = (editableCopyByDate[dateIso] || "").trim();
    if (!caption) {
      setMessage("Add a Today on air caption before publishing.");
      return;
    }
    setBusy(true);
    setMessage("Publishing the Instagram carousel…");
    try {
      const response = await fetch("/api/instagram/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateIso,
          caption,
          submissionIds: dayPictures.map((picture) => picture.id),
        }),
      });
      const result = (await response.json()) as { error?: string; permalink?: string | null; facebookPostId?: string | null; alreadyPublished?: boolean };
      if (!response.ok) throw new Error(result.error || "The Instagram carousel could not be published.");
      const publicationLabel = dayPictures.length === 1 ? "post" : "carousel";
      const prefix = result.alreadyPublished
        ? `This Instagram ${publicationLabel} was already published.`
        : `Instagram ${publicationLabel} published.`;
      const facebookSuffix = result.facebookPostId ? " Facebook Page post published." : "";
      setMessage(result.permalink ? `${prefix}${facebookSuffix} ${result.permalink}` : `${prefix}${facebookSuffix}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The Instagram carousel could not be published.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {message ? <p className={`${styles.feedback} dashboard-calendar-feedback`}>{message}</p> : null}

      <div ref={calendarRef} className={`${styles.grid} dashboard-calendar-grid`} aria-label="Upload calendar">
        {days.map((day) => {
          const dayPictures = picturesByDate[day.dateIso] || [];
          const selectedPictureIds = selectedPictureIdsByDate[day.dateIso] || [];
          const selectedPictureIdSet = new Set(selectedPictureIds);
          const selectedPictures = dayPictures.filter((picture) => selectedPictureIdSet.has(picture.id));
          const showDetails = Array.from(new Map(
            dayPictures
              .filter((picture) => picture.description.trim())
              .map((picture) => [`${picture.producer}|${picture.title}|${picture.description}`, picture]),
          ).values());
          const isExpanded = day.dateIso === expandedDate;
          return (
            <section
              key={day.dateIso}
              className={`${styles.day} ${styles[day.status]} ${isExpanded ? styles.dayExpanded : ""}`}
              aria-label={day.dateIso}
              onClick={() => selectDay(day.dateIso)}
            >
              <header className={styles.dayHeader}>
                <button
                  type="button"
                  className={styles.daySelect}
                  aria-pressed={isExpanded}
                  aria-label={`Show programme for ${day.dayLabel}`}
                  onClick={() => selectDay(day.dateIso)}
                >
                  <span className={styles.dayNumber}>{day.dayLabel}</span>
                </button>
                <div className={styles.dayHeaderActions}>
                  {isExpanded && editableCopyByDate[day.dateIso] ? (
                    <button
                      type="button"
                      className={styles.dayAction}
                      data-tooltip="Copy text"
                      onClick={() => copyProgramme(day.dateIso)}
                      aria-label={`Copy programme text for ${day.dateIso}`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 8h10v10H8zM6 16H4V4h12v2" />
                      </svg>
                    </button>
                  ) : null}
                  {isExpanded && dayPictures.length > 0 ? (
                    <button
                      type="button"
                      className={styles.dayAction}
                      data-tooltip="Download pictures"
                      disabled={busy || selectedPictures.length === 0}
                      onClick={() => downloadPictures(selectedPictures.map((picture) => picture.id))}
                      aria-label={`Download ${selectedPictures.length} selected picture${selectedPictures.length === 1 ? "" : "s"} from ${day.dateIso}`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" />
                      </svg>
                    </button>
                  ) : null}
                  {isExpanded && dayPictures.length > 0 ? (
                    <button
                      type="button"
                      className={styles.dayAction}
                      data-tooltip={selectedPictures.length === 1 ? "Publish to Instagram" : "Publish carousel to Instagram"}
                      disabled={busy || !instagramConnected || selectedPictures.length < 1 || selectedPictures.length > 10 || !(editableCopyByDate[day.dateIso] || "").trim()}
                      onClick={() => publishToInstagram(day.dateIso, selectedPictures)}
                      aria-label={selectedPictures.length === 1
                        ? `Publish picture from ${day.dateIso} to Instagram`
                        : `Publish ${selectedPictures.length} selected pictures from ${day.dateIso} as an Instagram carousel`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="5" />
                        <circle cx="12" cy="12" r="4" />
                        <circle cx="17.5" cy="6.5" r="1" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              </header>
              <div className={isExpanded ? styles.dayContent : undefined}>
                {dayPictures.length > 0 || day.missingShows.length > 0 ? (
                  <div className={styles.pictureGrid}>
                    {dayPictures.map((picture) => (
                      <article key={picture.id} className={`${styles.pictureCard} ${isExpanded && selectedPictureIdSet.has(picture.id) ? styles.pictureCardSelected : ""}`}>
                          <div className={styles.pictureFrame}>
                            {isExpanded ? (
                              <button type="button" className={styles.pictureOpen} onClick={() => setPreview(picture)} aria-label={`View ${picture.filename} enlarged`}>
                                {/* The authenticated endpoint supplies images that cannot be exposed publicly. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img className={styles.pictureImage} src={imageSource(picture)} onError={(event) => handleImageError(event, picture)} alt={`Cover uploaded by ${picture.producer}`} />
                              </button>
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img className={styles.pictureImage} src={imageSource(picture)} onError={(event) => handleImageError(event, picture)} alt={`Cover uploaded by ${picture.producer}`} />
                            )}
                            {isExpanded ? (
                              <div className={styles.pictureActions}>
                                <button type="button" disabled={busy} onClick={() => downloadPictures([picture.id])} aria-label={`Download ${picture.filename}`}>
                                  <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" />
                                  </svg>
                                </button>
                                <input
                                  className={styles.pictureSelection}
                                  type="checkbox"
                                  checked={selectedPictureIdSet.has(picture.id)}
                                  onChange={() => togglePictureSelection(day.dateIso, picture.id)}
                                  onClick={(event) => event.stopPropagation()}
                                  aria-label={`${selectedPictureIdSet.has(picture.id) ? "Exclude" : "Include"} ${picture.filename} ${selectedPictureIdSet.has(picture.id) ? "from" : "in"} bulk download and Instagram publishing`}
                                />
                              </div>
                            ) : null}
                          </div>
                        </article>
                    ))}
                    {day.missingShows.map((show, index) => (
                      <article key={`${day.dateIso}-${show.title}-${index}`} className={styles.picturePlaceholder}>
                        <p>{show.title}</p>
                        {show.producer ? <span>{show.producer}</span> : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className={styles.noPictures}>{day.dateIso > todayIso ? "Upcoming" : "No shows"}</p>
                )}
                {isExpanded ? (
                  <aside className={styles.programmeCopy} aria-live="polite">
                    <h3>Today on air</h3>
                    <textarea
                      className={styles.programmeCopyField}
                      aria-label={`Editable programme copy for ${day.dateIso}`}
                      maxLength={INSTAGRAM_COPY_MAX_LENGTH}
                      value={editableCopyByDate[day.dateIso] || ""}
                      placeholder="Programme copy is not available for this day yet."
                      onChange={(event) => setEditableCopyByDate((current) => ({
                        ...current,
                        [day.dateIso]: event.target.value,
                      }))}
                    />
                    {!instagramConnected || selectedPictures.length < 1 || selectedPictures.length > 10 ? (
                      <div className={styles.publishControls}>
                        <p>
                          {!instagramConnected
                            ? "Connect Instagram first."
                            : "Select 1–10 pictures to publish."}
                        </p>
                      </div>
                    ) : null}
                    {showDetails.length > 0 ? (
                      <section className={styles.showDetails} aria-labelledby={`show-details-${day.dateIso}`}>
                        <h4 id={`show-details-${day.dateIso}`}>Show details</h4>
                        {showDetails.map((picture) => (
                          <article key={`${picture.producer}-${picture.title}-${picture.id}`}>
                            <h5>{picture.title}</h5>
                            <p>{picture.description}</p>
                          </article>
                        ))}
                      </section>
                    ) : null}
                  </aside>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {preview ? (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview of ${preview.filename}`}
          onClick={(event) => { if (event.target === event.currentTarget) setPreview(null); }}
        >
          <div className={styles.lightboxContent}>
            <div className={styles.lightboxLayout}>
              <div className={styles.lightboxImage}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageSource(preview)} onError={(event) => handleImageError(event, preview)} alt={`Enlarged cover for ${preview.title} by ${preview.producer}`} />
              </div>
              <aside className={styles.lightboxMetadata}>
                <div className={styles.lightboxControls}>
                  <button type="button" onClick={() => showAdjacentPicture(-1)} aria-label="View previous picture">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                  </button>
                  <button type="button" onClick={() => showAdjacentPicture(1)} aria-label="View next picture">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                  </button>
                  <button type="button" disabled={busy} onClick={() => downloadPictures([preview.id])} aria-label={`Download ${preview.filename}`}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg>
                  </button>
                  <button type="button" onClick={() => setPreview(null)} aria-label="Close picture preview">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </div>
                <p className={styles.metadataDate}>{preview.dateIso}</p>
                <h3>{preview.title}</h3>
                <p className={styles.metadataProducer}>{preview.producer}</p>
                {preview.tags.length ? <ul className={styles.metadataTags}>{preview.tags.map((tag) => <li className="tag-chip" key={tag}>{tag}</li>)}</ul> : null}
                {preview.description.trim() ? (
                  <div className={styles.metadataDescription}>
                    <p>{preview.description}</p>
                  </div>
                ) : null}
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
