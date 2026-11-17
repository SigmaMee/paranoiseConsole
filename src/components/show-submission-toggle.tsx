"use client";

import { useEffect, useMemo, useState } from "react";
import { SubmissionForm } from "@/components/submission-form";

type ProducerShow = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
};

type ShowSubmissionToggleProps = {
  mostRecentPastShow: ProducerShow | null;
  mostRecentFutureShow: ProducerShow | null;
};

function formatShow(startsAt: string) {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) {
    return startsAt;
  }

  const formattedDate = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Athens",
  }).format(date);

  const formattedTime = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Athens",
  }).format(date);

  return `${formattedDate} - ${formattedTime}`;
}

export function ShowSubmissionToggle({
  mostRecentPastShow,
  mostRecentFutureShow,
}: ShowSubmissionToggleProps) {
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const cancellationEventId = currentUrl.searchParams.get("cancel_show");
    if (cancellationEventId && cancellationEventId === mostRecentFutureShow?.id) {
      setShowCancellation(true);
    }
    currentUrl.searchParams.delete("cancel_show");
    if (!currentUrl.searchParams.has("show_selection")) {
      const nextSearch = currentUrl.searchParams.toString();
      window.history.replaceState(window.history.state, "", `${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ""}${currentUrl.hash}`);
      return;
    }

    currentUrl.searchParams.delete("show_selection");
    const nextSearch = currentUrl.searchParams.toString();
    const nextUrl = `${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ""}${currentUrl.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [mostRecentFutureShow?.id]);

  const [selectedShowType, setSelectedShowType] = useState<"past" | "future">(
    mostRecentFutureShow ? "future" : "past",
  );

  const selectedShow = useMemo(
    () => (selectedShowType === "past" ? mostRecentPastShow : mostRecentFutureShow),
    [selectedShowType, mostRecentPastShow, mostRecentFutureShow],
  );

  const selectedShowStart = selectedShow?.startsAt || null;
  const selectedShowEnd = selectedShow?.endsAt || null;
  const selectedShowTitle = selectedShow?.title || null;
  const [showCancellation, setShowCancellation] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancellationMessage, setCancellationMessage] = useState("");

  async function cancelShowOccurrence() {
    if (!mostRecentFutureShow) return;
    setIsCancelling(true);
    setCancellationMessage("");
    try {
      const response = await fetch("/api/shows/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: mostRecentFutureShow.id }),
      });
      const result = await response.json() as { message?: string; error?: string };
      setCancellationMessage(result.message || result.error || "The cancellation could not be completed.");
      if (response.ok) setShowCancellation(false);
    } catch {
      setCancellationMessage("The cancellation could not be completed. Please try again.");
    } finally {
      setIsCancelling(false);
    }
  }

  return (
    <>
      <section className="dashboard-panel">
        <div className="dashboard-show-selector">
          <p className="dashboard-show-selector-title">RADIO SHOW SUBMISSION</p>
          <p>
            Select the date you want to submit the show for. For upcoming shows, Console will:
            <br />- Upload your show to Centova and schedule it for airing. No need to add it to
            your playlist manually.
            <br />- Add the cover to our Google Drive for sharing in social media
          </p>
          <div className="dashboard-show-toggle" role="group" aria-label="Select show">
            <button
              type="button"
              className={`dashboard-show-selector-option ${selectedShowType === "past" ? "dashboard-show-selector-option-active" : ""}`}
              onClick={() => setSelectedShowType("past")}
              aria-pressed={selectedShowType === "past"}
            >
              Last show
              <span>
                {mostRecentPastShow?.startsAt
                  ? formatShow(mostRecentPastShow.startsAt)
                  : "No past show"}
              </span>
            </button>
            <button
              type="button"
              className={`dashboard-show-selector-option ${selectedShowType === "future" ? "dashboard-show-selector-option-active" : ""}`}
              onClick={() => setSelectedShowType("future")}
              aria-pressed={selectedShowType === "future"}
            >
              Next show
              <span>
                {mostRecentFutureShow?.startsAt
                  ? formatShow(mostRecentFutureShow.startsAt)
                  : "No future show"}
              </span>
            </button>
          </div>
          <p className="dashboard-show-selector-current">
            Selected show: {selectedShowStart ? formatShow(selectedShowStart) : "TBD"}
          </p>
          {mostRecentFutureShow ? (
            <button className="show-cancel-trigger" type="button" onClick={() => setShowCancellation(true)}>
              Cancel show
            </button>
          ) : null}
          {cancellationMessage ? <p className="show-cancel-message" role="status">{cancellationMessage}</p> : null}
        </div>
      </section>

      {showCancellation && mostRecentFutureShow ? (
        <div className="show-cancel-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowCancellation(false);
        }}>
          <section className="show-cancel-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-show-title">
            <h2 id="cancel-show-title">Cancel this show?</h2>
            <p>{mostRecentFutureShow.title}</p>
            <p>{formatShow(mostRecentFutureShow.startsAt)} Greece time</p>
            <p>Only this occurrence will be removed. Future shows in the repeating series will stay scheduled.</p>
            <div className="show-cancel-actions">
              <button className="btn-neutral" type="button" onClick={() => setShowCancellation(false)} disabled={isCancelling}>Keep show</button>
              <button className="show-cancel-confirm" type="button" onClick={() => void cancelShowOccurrence()} disabled={isCancelling}>
                {isCancelling ? "Cancelling…" : "Yes, cancel this show"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <section className="dashboard-panel">
        <SubmissionForm
          selectedShowStart={selectedShowStart}
          selectedShowEnd={selectedShowEnd}
          selectedShowTitle={selectedShowTitle}
        />
      </section>
    </>
  );
}
