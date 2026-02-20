"use client";

import { FormEvent, useState } from "react";

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

export function SubmissionForm() {
  const [title, setTitle] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<string[]>([]);
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  function validate() {
    if (!title.trim()) {
      return "Show title is required.";
    }

    if (!audioFile) {
      return "Audio file is required.";
    }

    const isMp3 =
      audioFile.type === "audio/mpeg" || audioFile.name.toLowerCase().endsWith(".mp3");

    if (!isMp3) {
      return "Audio must be an MP3 file.";
    }

    if (audioFile.size > MAX_AUDIO_BYTES) {
      return "Audio exceeds 200 MB maximum size.";
    }

    if (imageFile && !imageFile.type.startsWith("image/")) {
      return "Cover must be a standard image file type.";
    }

    return null;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setDetails([]);
    setIsError(false);

    const validationError = validate();
    if (validationError) {
      setIsError(true);
      setMessage(validationError);
      return;
    }

    if (!audioFile) {
      return;
    }

    setIsLoading(true);

    try {
      const payload = new FormData();
      payload.append("title", title.trim());
      payload.append("audio", audioFile);
      if (imageFile) {
        payload.append("image", imageFile);
      }

      const response = await fetch("/api/submissions", {
        method: "POST",
        body: payload,
      });

      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      const typed = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
      const ftpObj =
        typeof typed.ftp === "object" && typed.ftp !== null
          ? (typed.ftp as Record<string, unknown>)
          : null;
      const driveObj =
        typeof typed.drive === "object" && typed.drive !== null
          ? (typed.drive as Record<string, unknown>)
          : null;

      const ftpMessage = typeof ftpObj?.message === "string" ? `FTP: ${ftpObj.message}` : null;
      const driveMessage =
        typeof driveObj?.message === "string" ? `Drive: ${driveObj.message}` : null;

      setDetails(
        [ftpMessage, driveMessage].filter((detail): detail is string => Boolean(detail)),
      );

      if (!response.ok && response.status !== 207) {
        const errorMessage =
          typeof typed.error === "string" ? typed.error : "Submission failed.";
        setIsError(true);
        setMessage(errorMessage);
        return;
      }

      if (response.status === 207 || typed.success === false) {
        setIsError(true);
        setMessage("Submission completed with partial failure.");
        return;
      }

      setMessage("Submission succeeded and status was stored.");
    } catch (error) {
      setIsError(true);
      if (error instanceof Error) {
        setMessage(error.message || "Submission failed unexpectedly.");
      } else {
        setMessage("Submission failed unexpectedly.");
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <label className="field-label" htmlFor="show-title">
        Show title
      </label>
      <input
        id="show-title"
        className="input"
        type="text"
        placeholder="Show title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
      />

      <label className="field-label" htmlFor="show-audio">
        Audio MP3 (max 200MB)
      </label>
      <input
        id="show-audio"
        className="input"
        type="file"
        accept=".mp3,audio/mpeg"
        onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)}
        required
      />

      <label className="field-label" htmlFor="show-cover">
        Cover image (optional)
      </label>
      <input
        id="show-cover"
        className="input"
        type="file"
        accept="image/*"
        onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
      />

      <button className="button button-primary" type="submit" disabled={isLoading}>
        {isLoading ? "Submitting..." : "Submit Show"}
      </button>

      {message ? (
        <p className={`message ${isError ? "message-error" : "message-success"}`}>
          {message}
        </p>
      ) : null}
      {details.length > 0 ? (
        <div className="stack">
          {details.map((detail) => (
            <p className="message" key={detail}>
              {detail}
            </p>
          ))}
        </div>
      ) : null}
    </form>
  );
}
