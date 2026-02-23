"use client";

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
  const [description, setDescription] = useState("");
  const [isAudioDragging, setIsAudioDragging] = useState(false);
  const [isImageDragging, setIsImageDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [audioSuccess, setAudioSuccess] = useState(false);
  const [coverSuccess, setCoverSuccess] = useState(false);
  const [descriptionSuccess, setDescriptionSuccess] = useState(false);
  const [submitAllSuccess, setSubmitAllSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeUploadType, setActiveUploadType] = useState<
    "audio" | "cover" | "description" | "all" | null
  >(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const audioSuccessTimeoutRef = useRef<number | null>(null);
  const coverSuccessTimeoutRef = useRef<number | null>(null);
  const descriptionSuccessTimeoutRef = useRef<number | null>(null);
  const submitAllSuccessTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (audioSuccessTimeoutRef.current !== null) {
        window.clearTimeout(audioSuccessTimeoutRef.current);
      }
      if (coverSuccessTimeoutRef.current !== null) {
        window.clearTimeout(coverSuccessTimeoutRef.current);
      }
      if (descriptionSuccessTimeoutRef.current !== null) {
        window.clearTimeout(descriptionSuccessTimeoutRef.current);
      }
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
    setAudioFile(null);
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

  function validate(uploadType: "audio" | "cover" | "description" | "all") {
    if (uploadType === "audio" || uploadType === "all") {
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

      if (!description.trim()) {
        return "Show description is required.";
      }
    }

    if (uploadType === "description" && !description.trim()) {
      return "Show description is required.";
    }

    if ((uploadType === "cover" || uploadType === "all") && !imageFile) {
      return "Cover image is required.";
    }

    if (imageFile && !imageFile.type.startsWith("image/")) {
      return "Cover must be a standard image file type.";
    }

    return null;
  }

  async function onSubmit(uploadType: "audio" | "cover" | "description" | "all") {
    setErrorMessage("");

    const validationError = validate(uploadType);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsLoading(true);
    setActiveUploadType(uploadType);
    setUploadProgress(0);

    try {
      const payload = new FormData();
      payload.append("uploadType", uploadType);
      if (uploadType === "audio" && audioFile) {
        payload.append("audio", audioFile);
      }
      if (uploadType === "cover" && imageFile) {
        payload.append("image", imageFile);
      }
      if (uploadType === "description") {
        payload.append("description", description.trim());
      }
      if (uploadType === "all") {
        if (audioFile) {
          payload.append("audio", audioFile);
        }
        if (imageFile) {
          payload.append("image", imageFile);
        }
      }
      if ((uploadType === "audio" || uploadType === "all") && description.trim()) {
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

      if (uploadType === "audio") {
        setAudioSuccess(true);
        if (audioSuccessTimeoutRef.current !== null) {
          window.clearTimeout(audioSuccessTimeoutRef.current);
        }
        audioSuccessTimeoutRef.current = window.setTimeout(() => {
          setAudioSuccess(false);
          audioSuccessTimeoutRef.current = null;
        }, 5000);
      } else if (uploadType === "cover") {
        setCoverSuccess(true);
        if (coverSuccessTimeoutRef.current !== null) {
          window.clearTimeout(coverSuccessTimeoutRef.current);
        }
        coverSuccessTimeoutRef.current = window.setTimeout(() => {
          setCoverSuccess(false);
          coverSuccessTimeoutRef.current = null;
        }, 5000);
      } else if (uploadType === "description") {
        setDescriptionSuccess(true);
        if (descriptionSuccessTimeoutRef.current !== null) {
          window.clearTimeout(descriptionSuccessTimeoutRef.current);
        }
        descriptionSuccessTimeoutRef.current = window.setTimeout(() => {
          setDescriptionSuccess(false);
          descriptionSuccessTimeoutRef.current = null;
        }, 5000);
      } else {
        setSubmitAllSuccess(true);
        if (submitAllSuccessTimeoutRef.current !== null) {
          window.clearTimeout(submitAllSuccessTimeoutRef.current);
        }
        submitAllSuccessTimeoutRef.current = window.setTimeout(() => {
          setSubmitAllSuccess(false);
          submitAllSuccessTimeoutRef.current = null;
        }, 5000);
      }
    } catch (error) {
      if (error instanceof Error) {
        setErrorMessage(error.message || "Submission failed unexpectedly.");
      } else {
        setErrorMessage("Submission failed unexpectedly.");
      }
    } finally {
      setIsLoading(false);
      setActiveUploadType(null);
      if (uploadType === "audio") {
        setAudioFile(null);
        if (audioInputRef.current) {
          audioInputRef.current.value = "";
        }
      }
      if (uploadType === "cover") {
        setImageFile(null);
        if (imageInputRef.current) {
          imageInputRef.current.value = "";
        }
      }
      if (uploadType === "description") {
        setDescription("");
      }
      if (uploadType === "all") {
        setAudioFile(null);
        setImageFile(null);
        setDescription("");
        if (audioInputRef.current) {
          audioInputRef.current.value = "";
        }
        if (imageInputRef.current) {
          imageInputRef.current.value = "";
        }
      }
      setIsAudioDragging(false);
      setIsImageDragging(false);
      setUploadProgress(0);
    }
  }

  const monogramProgressStyle = {
    "--upload-fill": String(uploadProgress / 100),
  } as CSSProperties;

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
            <label className="field-label" htmlFor="show-audio">
              Audio
            </label>
            <span className="field-label-helper">MP3 320KBPS 120’ MAX</span>
          </div>
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
            <p className="upload-zone-primary">
              {audioFile ? audioFile.name : "Drag and drop your MP3 here"}
            </p>
            <p className="upload-zone-secondary">or click to upload</p>
          </div>
          {audioFile ? (
            <button className="upload-clear" type="button" onClick={clearAudioFile}>
              Remove audio file
            </button>
          ) : null}
          <input
            ref={audioInputRef}
            id="show-audio"
            className="upload-input-hidden"
            type="file"
            accept=".mp3,audio/mpeg"
            onChange={onAudioInputChange}
          />
          <button
            className={audioSuccess ? "button-success-static" : "btn-neutral"}
            type="button"
            onClick={() => onSubmit("audio")}
            disabled={isLoading}
          >
            {isLoading && activeUploadType === "audio"
              ? "Uploading audio..."
              : audioSuccess
                ? "Audio upload successful."
                : "Upload Audio"}
          </button>

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
            className={descriptionSuccess ? "button-success-static" : "btn-neutral"}
            type="button"
            onClick={() => onSubmit("description")}
            disabled={isLoading}
          >
            {isLoading && activeUploadType === "description"
              ? "Uploading description..."
              : descriptionSuccess
                ? "Description upload successful."
                : "Upload Description"}
          </button>

          <div className="field-label-row">
            <label className="field-label" htmlFor="show-cover">
              Cover image
            </label>
            <span className="field-label-helper">JPEG 800X800 MIN</span>
          </div>
          <div
            className={`upload-zone ${isImageDragging ? "upload-zone-dragging" : ""}`}
            role="button"
            tabIndex={0}
            onClick={openImagePicker}
            onKeyDown={(event) => onDropzoneKeyDown(event, openImagePicker)}
            onDragOver={onImageDragOver}
            onDragLeave={onImageDragLeave}
            onDrop={onImageDrop}
            aria-label="Upload cover image"
          >
            <p className="upload-zone-primary">
              {imageFile ? imageFile.name : "Drag and drop your cover image here"}
            </p>
            <p className="upload-zone-secondary">or click to upload</p>
          </div>
          {imageFile ? (
            <button className="upload-clear" type="button" onClick={clearImageFile}>
              Remove cover image
            </button>
          ) : null}
          <input
            ref={imageInputRef}
            id="show-cover"
            className="upload-input-hidden"
            type="file"
            accept="image/*"
            onChange={onImageInputChange}
          />
          <button
            className={coverSuccess ? "button-success-static" : "btn-neutral"}
            type="button"
            onClick={() => onSubmit("cover")}
            disabled={isLoading}
          >
            {isLoading && activeUploadType === "cover"
              ? "Uploading cover..."
              : coverSuccess
                ? "Cover upload successful."
                : "Upload Cover"}
          </button>
          <button
            className={submitAllSuccess ? "button-success-static" : "button button-primary"}
            type="button"
            onClick={() => onSubmit("all")}
            disabled={isLoading}
          >
            {isLoading && activeUploadType === "all"
              ? "Submitting all..."
              : submitAllSuccess
                ? "Submit all successful."
                : "Submit all"}
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
