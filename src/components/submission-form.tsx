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

const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

const MUSICBRAINZ_GENRE_TAGS = [
  "acid house",
  "acid jazz",
  "afrobeat",
  "ambient",
  "bassline",
  "beat",
  "big beat",
  "boogie",
  "breakbeat",
  "broken beat",
  "chillout",
  "club",
  "dark ambient",
  "deep house",
  "detroit techno",
  "disco",
  "dnb",
  "drone",
  "drum and bass",
  "dub",
  "dubstep",
  "downtempo",
  "ebm",
  "electro",
  "electro house",
  "electronic",
  "experimental",
  "funk",
  "future garage",
  "garage",
  "glitch",
  "goa trance",
  "grime",
  "hard house",
  "hard techno",
  "hardcore",
  "hardstyle",
  "house",
  "idm",
  "industrial",
  "jazz",
  "jungle",
  "leftfield",
  "lo-fi",
  "minimal",
  "minimal techno",
  "neo soul",
  "nu disco",
  "progressive house",
  "psychedelic",
  "psytrance",
  "rave",
  "soul",
  "tech house",
  "techno",
  "trance",
  "tribal",
  "trip hop",
  "uk bass",
  "uk garage",
  "vaporwave",
].sort((first, second) => first.localeCompare(second));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PresignedFileDescriptor = {
  field: "audio" | "image";
  filename: string;
  contentType: string;
  size: number;
};

type PresignedFileResult = {
  field: "audio" | "image";
  objectKey: string;
  // Single-part
  presignedUrl?: string;
  // Multipart
  uploadId?: string;
  partUrls?: string[];
  partSize?: number;
};

type SubmissionFormProps = {
  selectedShowStart: string | null;
  selectedShowTitle: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Upload one chunk via a presigned PUT URL, returns the ETag from the response.
 */
function uploadPartToR2(
  chunk: Blob,
  presignedUrl: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presignedUrl, true);

    xhr.onerror = () => reject(new Error("Part upload failed."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag") || "";
        resolve(etag);
      } else {
        reject(new Error(`Part upload failed with status ${xhr.status}.`));
      }
    };

    xhr.send(chunk);
  });
}

/**
 * Upload a file to R2 — single-part for small files, multipart for large ones.
 * Reports progress as a value 0–100 via onProgress.
 */
async function uploadFileToR2(
  file: File,
  result: PresignedFileResult,
  onProgress: (percentage: number) => void,
): Promise<void> {
  // --- Single-part ---
  if (result.presignedUrl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", result.presignedUrl!, true);
      xhr.setRequestHeader("Content-Type", file.type);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress(Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100))));
      };

      xhr.onerror = () => reject(new Error("File upload to storage failed."));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error(`Storage upload failed with status ${xhr.status}.`));
        }
      };

      xhr.send(file.slice());
    });
  }

  // --- Multipart ---
  if (!result.uploadId || !result.partUrls || !result.partSize) {
    throw new Error("Invalid presign result: missing multipart fields.");
  }

  const { uploadId, partUrls, partSize, objectKey } = result;
  const completedParts: Array<{ PartNumber: number; ETag: string }> = new Array(partUrls.length);
  const bytesUploadedPerPart: number[] = new Array(partUrls.length).fill(0);

  const CONCURRENCY = 4;

  for (let batchStart = 0; batchStart < partUrls.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, partUrls.length);
    const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);

    await Promise.all(
      batchIndices.map(async (i) => {
        const start = i * partSize;
        const end = Math.min(start + partSize, file.size);
        const chunk = file.slice(start, end);

        const etag = await uploadPartToR2(chunk, partUrls[i]);
        completedParts[i] = { PartNumber: i + 1, ETag: etag };

        bytesUploadedPerPart[i] = chunk.size;
        const totalUploaded = bytesUploadedPerPart.reduce((sum, b) => sum + b, 0);
        onProgress(Math.min(99, Math.round((totalUploaded / file.size) * 100)));
      }),
    );
  }

  // Tell R2 to assemble the parts
  const completeResponse = await fetch("/api/submissions/presign/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objectKey, uploadId, parts: completedParts }),
  });

  if (!completeResponse.ok) {
    const err = (await completeResponse.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(
      typeof err.error === "string" ? err.error : "Failed to complete multipart upload.",
    );
  }

  onProgress(100);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SubmissionForm({ selectedShowStart, selectedShowTitle }: SubmissionFormProps) {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [waveformBars, setWaveformBars] = useState<number[]>([]);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [isAudioPreviewPlaying, setIsAudioPreviewPlaying] = useState(false);
  const [description, setDescription] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagInputValue, setTagInputValue] = useState("");
  const [isTagMenuOpen, setIsTagMenuOpen] = useState(false);
  const [highlightedTagIndex, setHighlightedTagIndex] = useState(0);
  const [isAudioDragging, setIsAudioDragging] = useState(false);
  const [isImageDragging, setIsImageDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitAllSuccess, setSubmitAllSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Two-phase progress: [0–70] uploading files to R2, [70–100] server processing
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<"uploading" | "processing" | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const submitAllSuccessTimeoutRef = useRef<number | null>(null);

  function resetDraftState() {
    setAudioFile(null);
    setImageFile(null);
    setDescription("");
    setSelectedTags([]);
    setTagInputValue("");
    setIsTagMenuOpen(false);
    setHighlightedTagIndex(0);
    if (audioInputRef.current) audioInputRef.current.value = "";
    if (imageInputRef.current) imageInputRef.current.value = "";
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
    setProgressPhase(null);
  }

  useEffect(() => {
    return () => {
      if (submitAllSuccessTimeoutRef.current !== null) {
        window.clearTimeout(submitAllSuccessTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!errorMessage) return;
    const id = window.setTimeout(() => setErrorMessage(""), 60000);
    return () => window.clearTimeout(id);
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
    return () => URL.revokeObjectURL(url);
  }, [audioFile]);

  useEffect(() => { setHighlightedTagIndex(0); }, [tagInputValue]);

  useEffect(() => {
    resetDraftState();
    setErrorMessage("");
    setSubmitAllSuccess(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShowStart]);

  const normalizedTagInput = tagInputValue.trim().toLowerCase();
  const filteredTagSuggestions = MUSICBRAINZ_GENRE_TAGS.filter(
    (tag) =>
      !selectedTags.includes(tag) &&
      (normalizedTagInput.length === 0 || tag.includes(normalizedTagInput)),
  ).slice(0, 8);

  function addTag(rawValue: string) {
    const normalized = rawValue.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized) return;
    if (selectedTags.includes(normalized)) { setTagInputValue(""); return; }
    if (selectedTags.length >= 5) { setErrorMessage("You can add up to 5 tags."); return; }
    setSelectedTags((prev) => [...prev, normalized]);
    setTagInputValue("");
    setIsTagMenuOpen(false);
  }

  function removeTag(tagToRemove: string) {
    setSelectedTags((prev) => prev.filter((t) => t !== tagToRemove));
  }

  function onTagInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!filteredTagSuggestions.length) return;
      setIsTagMenuOpen(true);
      setHighlightedTagIndex((prev) => Math.min(filteredTagSuggestions.length - 1, prev + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!filteredTagSuggestions.length) return;
      setHighlightedTagIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      const suggestion = filteredTagSuggestions[highlightedTagIndex];
      if (isTagMenuOpen && suggestion) addTag(suggestion);
      else addTag(tagInputValue);
      return;
    }
    if (event.key === "Backspace" && !tagInputValue && selectedTags.length > 0) {
      event.preventDefault();
      removeTag(selectedTags[selectedTags.length - 1]);
      return;
    }
    if (event.key === "Escape") setIsTagMenuOpen(false);
  }

  useEffect(() => {
    if (!imageFile) { setImagePreviewUrl(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  useEffect(() => {
    if (!audioFile) { setWaveformBars([]); return; }
    const seed = `${audioFile.name}-${audioFile.size}-${audioFile.lastModified}`;
    setWaveformBars(createFakeWaveformBars(seed));
  }, [audioFile]);

  function onAudioInputChange(event: ChangeEvent<HTMLInputElement>) {
    setAudioFile(event.target.files?.[0] ?? null);
  }

  function onImageInputChange(event: ChangeEvent<HTMLInputElement>) {
    setImageFile(event.target.files?.[0] ?? null);
  }

  function onAudioDragOver(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsAudioDragging(true); }
  function onAudioDragLeave(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsAudioDragging(false); }
  function onImageDragOver(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsImageDragging(true); }
  function onImageDragLeave(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setIsImageDragging(false); }

  function onAudioDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setIsAudioDragging(false);
    setAudioFile(event.dataTransfer.files?.[0] ?? null);
  }

  function onImageDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setIsImageDragging(false);
    setImageFile(event.dataTransfer.files?.[0] ?? null);
  }

  function openAudioPicker() { audioInputRef.current?.click(); }
  function openImagePicker() { imageInputRef.current?.click(); }

  function onDropzoneKeyDown(event: KeyboardEvent<HTMLDivElement>, openPicker: () => void) {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPicker(); }
  }

  function clearAudioFile(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation();
    if (audioPreviewRef.current) { audioPreviewRef.current.pause(); audioPreviewRef.current.currentTime = 0; }
    setAudioFile(null); setAudioCurrentTime(0); setAudioDuration(0); setIsAudioPreviewPlaying(false);
    if (audioInputRef.current) audioInputRef.current.value = "";
  }

  function clearImageFile(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation();
    setImageFile(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  function toggleAudioPreviewPlayback() {
    if (!audioPreviewRef.current) return;
    if (audioPreviewRef.current.paused) { void audioPreviewRef.current.play(); setIsAudioPreviewPlaying(true); }
    else { audioPreviewRef.current.pause(); setIsAudioPreviewPlaying(false); }
  }

  function onAudioPreviewMetadataLoaded() {
    if (!audioPreviewRef.current) return;
    setAudioDuration(Number.isFinite(audioPreviewRef.current.duration) ? audioPreviewRef.current.duration : 0);
  }

  function onAudioPreviewTimeUpdate() {
    if (!audioPreviewRef.current) return;
    setAudioCurrentTime(audioPreviewRef.current.currentTime);
  }

  function onAudioSeekChange(event: ChangeEvent<HTMLInputElement>) {
    if (!audioPreviewRef.current) return;
    const nextTime = Number(event.target.value);
    audioPreviewRef.current.currentTime = nextTime;
    setAudioCurrentTime(nextTime);
  }

  function onWaveformClick(event: MouseEvent<HTMLDivElement>) {
    if (!audioPreviewRef.current || audioDuration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const nextTime = ratio * audioDuration;
    audioPreviewRef.current.currentTime = nextTime;
    setAudioCurrentTime(nextTime);
  }

  function formatSeconds(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remaining = totalSeconds % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function validate() {
    const hasAudio = Boolean(audioFile);
    const hasImage = Boolean(imageFile);
    const hasDescription = Boolean(description.trim());
    const hasTags = selectedTags.length > 0;

    if (!hasAudio && !hasImage && !hasDescription && !hasTags) {
      return "Add at least one of audio, cover image, show description, or tags.";
    }

    if (audioFile) {
      const isMp3 = audioFile.type === "audio/mpeg" || audioFile.name.toLowerCase().endsWith(".mp3");
      if (!isMp3) return "Audio must be an MP3 file.";
      if (audioFile.size > MAX_AUDIO_BYTES) return "Audio exceeds 500 MB maximum size.";
    }

    if (imageFile && !imageFile.type.startsWith("image/")) {
      return "Cover must be a standard image file type.";
    }

    return null;
  }

  async function onSubmit() {
    setErrorMessage("");

    const validationError = validate();
    if (validationError) { setErrorMessage(validationError); return; }

    setIsLoading(true);
    setUploadProgress(0);
    setProgressPhase("uploading");

    try {
      // -----------------------------------------------------------------------
      // Step 1 — Request presigned URLs for any files that need uploading
      // -----------------------------------------------------------------------
      const filesToPresign: PresignedFileDescriptor[] = [];
      if (audioFile) {
        filesToPresign.push({
          field: "audio",
          filename: audioFile.name,
          contentType: audioFile.type || "audio/mpeg",
          size: audioFile.size,
        });
      }
      if (imageFile) {
        filesToPresign.push({
          field: "image",
          filename: imageFile.name,
          contentType: imageFile.type || "image/jpeg",
          size: imageFile.size,
        });
      }

      let presignedFiles: PresignedFileResult[] = [];

      if (filesToPresign.length > 0) {
        const presignResponse = await fetch("/api/submissions/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: filesToPresign }),
        });

        if (!presignResponse.ok) {
          const errorData = (await presignResponse.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error(
            typeof errorData.error === "string" ? errorData.error : "Failed to prepare upload.",
          );
        }

        const presignData = (await presignResponse.json()) as { files: PresignedFileResult[] };
        presignedFiles = presignData.files;
      }

      // -----------------------------------------------------------------------
      // Step 2 — Upload files directly to R2 via presigned PUT URLs
      //           Progress covers 0–70% of the visible progress bar.
      // -----------------------------------------------------------------------
      const audioResult = presignedFiles.find((f) => f.field === "audio");
      const imageResult = presignedFiles.find((f) => f.field === "image");

      // Track per-file progress and blend into a single [0–70] range
      let audioProgress = audioFile ? 0 : 100;
      let imageProgress = imageFile ? 0 : 100;

      function blendedProgress() {
        const fileCount = (audioFile ? 1 : 0) + (imageFile ? 1 : 0);
        if (fileCount === 0) return 70;
        const avg = (audioProgress + imageProgress) / (fileCount === 2 ? 2 : 1);
        // If only one file, the other slot is already 100 so the average is just that file
        const combined = fileCount === 2
          ? (audioProgress + imageProgress) / 2
          : audioFile ? audioProgress : imageProgress;
        void avg; // unused when using combined
        return Math.round(combined * 0.7);
      }

      const uploads: Promise<void>[] = [];

      if (audioFile && audioResult) {
        uploads.push(
          uploadFileToR2(audioFile, audioResult, (pct) => {
            audioProgress = pct;
            setUploadProgress(blendedProgress());
          }),
        );
      }

      if (imageFile && imageResult) {
        uploads.push(
          uploadFileToR2(imageFile, imageResult, (pct) => {
            imageProgress = pct;
            setUploadProgress(blendedProgress());
          }),
        );
      }

      await Promise.all(uploads);

      // -----------------------------------------------------------------------
      // Step 3 — POST metadata + R2 object keys to the submissions API
      //           (small JSON payload, no files — never hits Vercel's limit)
      // -----------------------------------------------------------------------
      setProgressPhase("processing");
      setUploadProgress(70);

      const submissionBody: Record<string, unknown> = {
        uploadType: "all",
        description: description.trim(),
        tags: selectedTags,
        selectedShowStart: selectedShowStart ?? undefined,
        selectedShowTitle: selectedShowTitle ?? undefined,
        audioObjectKey: audioResult?.objectKey,
        audioFilename: audioFile?.name,
        audioContentType: audioFile?.type,
        imageObjectKey: imageResult?.objectKey,
        imageFilename: imageFile?.name,
        imageContentType: imageFile?.type,
      };

      // Animate progress from 70 → 95 while the server processes
      const processingInterval = window.setInterval(() => {
        setUploadProgress((prev) => Math.min(95, prev + 1));
      }, 400);

      let submissionStatus: number;
      let submissionData: unknown;

      try {
        const submissionResponse = await fetch("/api/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submissionBody),
        });
        submissionStatus = submissionResponse.status;
        submissionData = await submissionResponse.json().catch(() => null);
      } finally {
        window.clearInterval(processingInterval);
      }

      setUploadProgress(100);

      const typed =
        typeof submissionData === "object" && submissionData !== null
          ? (submissionData as Record<string, unknown>)
          : {};
      const ftpObj =
        typeof typed.ftp === "object" && typed.ftp !== null
          ? (typed.ftp as Record<string, unknown>)
          : null;
      const driveObj =
        typeof typed.drive === "object" && typed.drive !== null
          ? (typed.drive as Record<string, unknown>)
          : null;

      const ftpMessage = typeof ftpObj?.message === "string" ? `FTP: ${ftpObj.message}` : null;
      const driveMessage = typeof driveObj?.message === "string" ? `Drive: ${driveObj.message}` : null;

      const isSuccessStatus = submissionStatus >= 200 && submissionStatus < 300;
      if (!isSuccessStatus && submissionStatus !== 207) {
        const msg = typeof typed.error === "string" ? typed.error : "Submission failed.";
        setErrorMessage(msg);
        return;
      }

      if (submissionStatus === 207 || typed.success === false) {
        setErrorMessage(
          ["Submission completed with partial failure.", ftpMessage, driveMessage]
            .filter((v): v is string => Boolean(v))
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
      }, 60000);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message || "Submission failed unexpectedly." : "Submission failed unexpectedly.",
      );
    } finally {
      setIsLoading(false);
      resetDraftState();
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
    <form className="form submission-form" onSubmit={(event) => event.preventDefault()}>
      {isLoading ? (
        <div className="upload-progress-panel" aria-live="polite">
          <div className="upload-progress-monogram" style={monogramProgressStyle}>
            <div className="upload-progress-fill" />
          </div>
          <p className="upload-progress-value">{uploadProgress}%</p>
          {progressPhase === "processing" || uploadProgress >= 100 ? (
            <p className="upload-progress-phase">almost done...</p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="submission-grid">
            <div className="submission-column submission-column-cover">
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
                  <Image
                    src="/branding/monogram-white.png"
                    alt=""
                    width={790}
                    height={722}
                    className="cover-dropzone-monogram"
                    aria-hidden
                  />
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
            </div>

            <div className="submission-column submission-column-meta">
              <div className="submission-block submission-audio-block">
                <div className="field-label-row">
                  <label className="field-label" htmlFor="show-audio">
                    Audio
                  </label>
                  <span className="field-label-helper">MP3 320KBPS 120' MAX</span>
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
              </div>

              <div className="submission-block submission-description-block">
                <div className="field-label-row">
                  <label className="field-label" htmlFor="show-description">
                    Description
                  </label>
                  <span className="field-label-helper">briefly describe your show</span>
                </div>
                <textarea
                  id="show-description"
                  className="textarea"
                  value={description}
                  placeholder="Briefly describe your radio show"
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                />
              </div>
            </div>
          </div>

          <div className="submission-tags-row">
            <div className="field-label-row submission-tags-label-row">
              <label className="field-label" htmlFor="show-tags">
                Tags
              </label>
              <span className="field-label-helper">MAX 5 TAGS</span>
            </div>
            <div className="tags-input-shell submission-tags-shell">
              <div className="tags-chip-row">
                {selectedTags.map((tag) => (
                  <span className="tag-chip" key={tag}>
                    {tag}
                    <button
                      type="button"
                      className="tag-chip-remove"
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove ${tag}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id="show-tags"
                  ref={tagInputRef}
                  className="input tag-input"
                  type="text"
                  value={tagInputValue}
                  placeholder="Type a genre tag"
                  onFocus={() => setIsTagMenuOpen(true)}
                  onBlur={() => { window.setTimeout(() => setIsTagMenuOpen(false), 100); }}
                  onChange={(event) => { setTagInputValue(event.target.value); setIsTagMenuOpen(true); }}
                  onKeyDown={onTagInputKeyDown}
                />
              </div>
              {isTagMenuOpen && (filteredTagSuggestions.length > 0 || normalizedTagInput) ? (
                <div className="tags-suggestions" role="listbox" aria-label="Genre suggestions">
                  {filteredTagSuggestions.map((tag, index) => (
                    <button
                      key={tag}
                      type="button"
                      className={`tag-suggestion-item ${index === highlightedTagIndex ? "tag-suggestion-item-active" : ""}`}
                      onMouseDown={(event) => { event.preventDefault(); addTag(tag); }}
                    >
                      {tag}
                    </button>
                  ))}
                  {normalizedTagInput && !MUSICBRAINZ_GENRE_TAGS.includes(normalizedTagInput) ? (
                    <button
                      type="button"
                      className="tag-suggestion-item tag-suggestion-create"
                      onMouseDown={(event) => { event.preventDefault(); addTag(normalizedTagInput); }}
                    >
                      Create "{normalizedTagInput}"
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="submission-submit-wrap">
            <button
              className={submitAllSuccess ? "button-success-static submission-submit" : "button button-primary submission-submit"}
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
          </div>
        </>
      )}

      {errorMessage ? (
        <p className="message message-error">{errorMessage}</p>
      ) : null}
    </form>
  );
}