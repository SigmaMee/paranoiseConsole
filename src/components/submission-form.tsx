"use client";

import Image from "next/image";
import {
  CSSProperties,
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

type SubmissionApiResult = {
  status: number;
  data: unknown;
};

function createFakeWaveformBars(seedSource: string, totalBars = 72) {
  let seed = 0;
  for (let index = 0; index < seedSource.length; index += 1) {
    seed = (seed * 31 + seedSource.charCodeAt(index)) >>> 0;
  }

  const bars: number[] = [];
  for (let barIndex = 0; barIndex < totalBars; barIndex += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const pseudoRandom = seed / 4294967296;
    const curve = Math.sin(((barIndex + 1) / totalBars) * Math.PI) * 0.35 + 0.65;
    const height = Math.round((0.25 + pseudoRandom * 0.75) * curve * 100);
    bars.push(Math.max(10, Math.min(100, height)));
  }

  return bars;
}

function submitWithProgress(
  payload: FormData,
  onProgress: (percentage: number) => void,
): Promise<SubmissionApiResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/submissions", true);

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      const percentage = Math.min(
        100,
        Math.max(0, Math.round((event.loaded / event.total) * 100)),
      );
      onProgress(percentage);
    };

    request.onerror = () => {
      reject(new Error("Submission failed unexpectedly."));
    };

    request.onload = () => {
      onProgress(100);

      let data: unknown = null;
      try {
        data = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        data = null;
      }

      resolve({ status: request.status, data });
    };

    request.send(payload);
  });
}

export function SubmissionForm() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [waveformBars, setWaveformBars] = useState<number[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isAudioPreviewPlaying, setIsAudioPreviewPlaying] = useState(false);
  const [description, setDescription] = useState("");
  const [isAudioDragging, setIsAudioDragging] = useState(false);
  const [isImageDragging, setIsImageDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitAllSuccess, setSubmitAllSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const submitAllSuccessTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (submitAllSuccessTimeoutRef.current !== null) {
        window.clearTimeout(submitAllSuccessTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setErrorMessage("");
    }, 5000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [errorMessage]);

  useEffect(() => {
    if (!audioFile) {
      setAudioPreviewUrl(null);
      setAudioDuration(0);
      setAudioCurrentTime(0);
      setIsAudioPreviewPlaying(false);
      return;
    }

    const url = URL.createObjectURL(audioFile);
    setAudioPreviewUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [audioFile]);

  useEffect(() => {
    if (!imageFile) {
      setImagePreviewUrl(null);
      return;
    }

    const url = URL.createObjectURL(imageFile);
    setImagePreviewUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [imageFile]);

  useEffect(() => {
    if (!audioFile) {
      setWaveformBars([]);
      return;
    }

    const seed = `${audioFile.name}-${audioFile.size}-${audioFile.lastModified}`;
    setWaveformBars(createFakeWaveformBars(seed));
  }, [audioFile]);

  function onAudioInputChange(event: ChangeEvent<HTMLInputElement>) {
    setAudioFile(event.target.files?.[0] ?? null);
  }

  function onImageInputChange(event: ChangeEvent<HTMLInputElement>) {
    setImageFile(event.target.files?.[0] ?? null);
  }

  function onAudioDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsAudioDragging(true);
  }

  function onAudioDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsAudioDragging(false);
  }

  function onImageDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsImageDragging(true);
  }

  function onImageDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsImageDragging(false);
  }

  function onAudioDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsAudioDragging(false);
    const droppedFile = event.dataTransfer.files?.[0] ?? null;
    setAudioFile(droppedFile);
  }

  function onImageDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsImageDragging(false);
    const droppedFile = event.dataTransfer.files?.[0] ?? null;
    setImageFile(droppedFile);
  }

  function openAudioPicker() {
    audioInputRef.current?.click();
  }

  function openImagePicker() {
    imageInputRef.current?.click();
  }

  function onDropzoneKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    openPicker: () => void,
  ) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  }

  function clearAudioFile(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current.currentTime = 0;
    }
    setAudioFile(null);
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setIsAudioPreviewPlaying(false);
    if (audioInputRef.current) {
      audioInputRef.current.value = "";
    }
  }

  function clearImageFile(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setImageFile(null);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  function toggleAudioPreviewPlayback() {
    if (!audioPreviewRef.current) {
      return;
    }

    if (audioPreviewRef.current.paused) {
      void audioPreviewRef.current.play();
      setIsAudioPreviewPlaying(true);
      return;
    }

    audioPreviewRef.current.pause();
    setIsAudioPreviewPlaying(false);
  }

  function onAudioPreviewMetadataLoaded() {
    if (!audioPreviewRef.current) {
      return;
    }
    setAudioDuration(Number.isFinite(audioPreviewRef.current.duration) ? audioPreviewRef.current.duration : 0);
  }

  function onAudioPreviewTimeUpdate() {
    if (!audioPreviewRef.current) {
      return;
    }
    setAudioCurrentTime(audioPreviewRef.current.currentTime);
  }

  function onAudioSeekChange(event: ChangeEvent<HTMLInputElement>) {
    if (!audioPreviewRef.current) {
      return;
    }

    const nextTime = Number(event.target.value);
    audioPreviewRef.current.currentTime = nextTime;
    setAudioCurrentTime(nextTime);
  }

  function onWaveformClick(event: MouseEvent<HTMLDivElement>) {
    if (!audioPreviewRef.current || audioDuration <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    const clickPosition = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickPosition / rect.width));
    const nextTime = ratio * audioDuration;
    audioPreviewRef.current.currentTime = nextTime;
    setAudioCurrentTime(nextTime);
  }

  function formatSeconds(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "0:00";
    }

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function validate() {
    const hasAudio = Boolean(audioFile);
    const hasImage = Boolean(imageFile);
    const hasDescription = Boolean(description.trim());

    if (!hasAudio && !hasImage && !hasDescription) {
      return "Add at least one of audio, cover image, or show description.";
    }

    if (audioFile) {
      const isMp3 =
        audioFile.type === "audio/mpeg" || audioFile.name.toLowerCase().endsWith(".mp3");

      if (!isMp3) {
        return "Audio must be an MP3 file.";
      }

      if (audioFile.size > MAX_AUDIO_BYTES) {
        return "Audio exceeds 200 MB maximum size.";
      }
    }

    if (imageFile && !imageFile.type.startsWith("image/")) {
      return "Cover must be a standard image file type.";
    }

    return null;
  }

  async function onSubmit() {
    setErrorMessage("");

    const validationError = validate();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsLoading(true);
    setUploadProgress(0);

    try {
      const payload = new FormData();
      payload.append("uploadType", "all");
      if (audioFile) {
        payload.append("audio", audioFile);
      }
      if (imageFile) {
        payload.append("image", imageFile);
      }
      if (description.trim()) {
        payload.append("description", description.trim());
      }

      const { status, data } = await submitWithProgress(payload, setUploadProgress);

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

      const isSuccessStatus = status >= 200 && status < 300;
      if (!isSuccessStatus && status !== 207) {
        const errorMessage =
          typeof typed.error === "string" ? typed.error : "Submission failed.";
        setErrorMessage(errorMessage);
        return;
      }

      if (status === 207 || typed.success === false) {
        setErrorMessage(
          ["Submission completed with partial failure.", ftpMessage, driveMessage]
            .filter((value): value is string => Boolean(value))
            .join(" "),
        );
        return;
      }

      setSubmitAllSuccess(true);
      if (submitAllSuccessTimeoutRef.current !== null) {
        window.clearTimeout(submitAllSuccessTimeoutRef.current);
      }
      submitAllSuccessTimeoutRef.current = window.setTimeout(() => {
        setSubmitAllSuccess(false);
        submitAllSuccessTimeoutRef.current = null;
      }, 5000);
    } catch (error) {
      if (error instanceof Error) {
        setErrorMessage(error.message || "Submission failed unexpectedly.");
      } else {
        setErrorMessage("Submission failed unexpectedly.");
      }
    } finally {
      setIsLoading(false);
      setAudioFile(null);
      setImageFile(null);
      setDescription("");
      if (audioInputRef.current) {
        audioInputRef.current.value = "";
      }
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
      if (audioPreviewRef.current) {
        audioPreviewRef.current.pause();
        audioPreviewRef.current.currentTime = 0;
      }
      setAudioCurrentTime(0);
      setAudioDuration(0);
      setIsAudioPreviewPlaying(false);
      setIsAudioDragging(false);
      setIsImageDragging(false);
      setUploadProgress(0);
    }
  }

  const monogramProgressStyle = {
    "--upload-fill": String(uploadProgress / 100),
  } as CSSProperties;

  const playedWaveformBars =
    waveformBars.length > 0 && audioDuration > 0
      ? Math.min(waveformBars.length, Math.max(0, Math.round((audioCurrentTime / audioDuration) * waveformBars.length)))
      : 0;

  return (
    <form className="form" onSubmit={(event) => event.preventDefault()}>
      {isLoading ? (
        <div className="upload-progress-panel" aria-live="polite">
          <div className="upload-progress-monogram" style={monogramProgressStyle}>
            <div className="upload-progress-fill" />
          </div>
          <p className="upload-progress-value">{uploadProgress}%</p>
          {uploadProgress >= 100 ? (
            <p className="upload-progress-phase">almost done...</p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="field-label-row">
            <label className="field-label" htmlFor="show-cover">
              Cover image
            </label>
            <span className="field-label-helper">JPEG 800X800 MIN</span>
          </div>
          {!imageFile ? (
            <div
              className={`upload-zone upload-zone-square ${isImageDragging ? "upload-zone-dragging" : ""}`}
              role="button"
              tabIndex={0}
              onClick={openImagePicker}
              onKeyDown={(event) => onDropzoneKeyDown(event, openImagePicker)}
              onDragOver={onImageDragOver}
              onDragLeave={onImageDragLeave}
              onDrop={onImageDrop}
              aria-label="Upload cover image"
            >
              <p className="upload-zone-primary">Drag and drop your cover image here</p>
              <p className="upload-zone-secondary">or click to upload</p>
            </div>
          ) : null}
          <input
            ref={imageInputRef}
            id="show-cover"
            className="upload-input-hidden"
            type="file"
            accept="image/*"
            onChange={onImageInputChange}
          />
          {imagePreviewUrl ? (
            <div className="cover-preview-card">
              <Image
                className="cover-preview-image"
                src={imagePreviewUrl}
                alt="Selected cover preview"
                width={800}
                height={800}
                unoptimized
              />
              <button className="btn-tertiary" type="button" onClick={clearImageFile}>
                Remove cover image
              </button>
            </div>
          ) : null}
          <div className="field-label-row">
            <label className="field-label" htmlFor="show-audio">
              Audio
            </label>
            <span className="field-label-helper">MP3 320KBPS 120’ MAX</span>
          </div>
          {!audioFile ? (
            <div
              className={`upload-zone ${isAudioDragging ? "upload-zone-dragging" : ""}`}
              role="button"
              tabIndex={0}
              onClick={openAudioPicker}
              onKeyDown={(event) => onDropzoneKeyDown(event, openAudioPicker)}
              onDragOver={onAudioDragOver}
              onDragLeave={onAudioDragLeave}
              onDrop={onAudioDrop}
              aria-label="Upload audio file"
            >
              <p className="upload-zone-primary">Drag and drop your MP3 here</p>
              <p className="upload-zone-secondary">or click to upload</p>
            </div>
          ) : null}
          <input
            ref={audioInputRef}
            id="show-audio"
            className="upload-input-hidden"
            type="file"
            accept=".mp3,audio/mpeg"
            onChange={onAudioInputChange}
          />
          {audioPreviewUrl ? (
            <div className="audio-preview-card">
              <audio
                ref={audioPreviewRef}
                src={audioPreviewUrl}
                preload="metadata"
                onLoadedMetadata={onAudioPreviewMetadataLoaded}
                onTimeUpdate={onAudioPreviewTimeUpdate}
                onPlay={() => setIsAudioPreviewPlaying(true)}
                onPause={() => setIsAudioPreviewPlaying(false)}
                onEnded={() => setIsAudioPreviewPlaying(false)}
              />
              <div className="audio-preview-main">
                <button
                  type="button"
                  className="audio-preview-icon"
                  onClick={toggleAudioPreviewPlayback}
                  aria-label={isAudioPreviewPlaying ? "Pause preview" : "Play preview"}
                >
                  {isAudioPreviewPlaying ? "❚❚" : "▶"}
                </button>
                <div className="audio-preview-track">
                  <div className="audio-waveform" onClick={onWaveformClick} role="presentation">
                    {(waveformBars.length > 0 ? waveformBars : Array.from({ length: 72 }, () => 12)).map(
                      (barHeight, index) => (
                        <span
                          key={`${barHeight}-${index}`}
                          className={`audio-waveform-bar ${index < playedWaveformBars ? "audio-waveform-bar-played" : ""}`}
                          style={{ height: `${barHeight}%` }}
                        />
                      ),
                    )}
                  </div>
                  <input
                    type="range"
                    className="audio-seek"
                    min={0}
                    max={audioDuration > 0 ? audioDuration : 0}
                    step={0.1}
                    value={audioCurrentTime}
                    onChange={onAudioSeekChange}
                    disabled={audioDuration <= 0}
                    aria-label="Seek audio preview"
                  />
                  <span className="audio-preview-time">
                    {formatSeconds(audioCurrentTime)} / {formatSeconds(audioDuration)}
                  </span>
                </div>
              </div>
              <button className="btn-tertiary" type="button" onClick={clearAudioFile}>
                Remove audio file
              </button>
            </div>
          ) : null}
          <div className="field-label-row">
            <label className="field-label" htmlFor="show-description">
              Show description
            </label>
            <span className="field-label-helper">
              briefly describe your show and provide genre tags
            </span>
          </div>
          <textarea
            id="show-description"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
          />
          <button
            className={submitAllSuccess ? "button-success-static" : "button button-primary"}
            type="button"
            onClick={() => onSubmit()}
            disabled={isLoading}
          >
            {isLoading
              ? "Submitting show..."
              : submitAllSuccess
                ? "Show submitted successfully."
                : "Submit show"}
          </button>
        </>
      )}

      {errorMessage ? (
        <p className="message message-error">
          {errorMessage}
        </p>
      ) : null}
    </form>
  );
}
