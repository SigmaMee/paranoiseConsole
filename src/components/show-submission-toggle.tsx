"use client";

import { useEffect, useMemo, useState } from "react";
import { SubmissionForm } from "@/components/submission-form";

type ProducerShow = {
  title: string;
  startsAt: string;
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
  }).format(date);

  const formattedTime = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  return `${formattedDate} - ${formattedTime}`;
}

export function ShowSubmissionToggle({
  mostRecentPastShow,
  mostRecentFutureShow,
}: ShowSubmissionToggleProps) {
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (!currentUrl.searchParams.has("show_selection")) {
      return;
    }

    currentUrl.searchParams.delete("show_selection");
    const nextSearch = currentUrl.searchParams.toString();
    const nextUrl = `${currentUrl.pathname}${nextSearch ? `?${nextSearch}` : ""}${currentUrl.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  const [selectedShowType, setSelectedShowType] = useState<"past" | "future">(
    mostRecentFutureShow ? "future" : "past",
  );

  const selectedShow = useMemo(
    () => (selectedShowType === "past" ? mostRecentPastShow : mostRecentFutureShow),
    [selectedShowType, mostRecentPastShow, mostRecentFutureShow],
  );

  const selectedShowStart = selectedShow?.startsAt || null;
  const selectedShowTitle = selectedShow?.title || null;

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
        </div>
      </section>

      <section className="dashboard-panel">
        <SubmissionForm
          selectedShowStart={selectedShowStart}
          selectedShowTitle={selectedShowTitle}
        />
      </section>
    </>
  );
}