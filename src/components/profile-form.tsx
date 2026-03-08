"use client";

import { FormEvent, useEffect, useState } from "react";

type Profile = {
  full_name: string;
};

export function ProfileForm() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const response = await fetch("/api/profile", { method: "GET" });
      const data = await response.json();

      if (!mounted) {
        return;
      }

      if (!response.ok) {
        setIsError(true);
        setMessage(data?.error || "Failed to load profile draft.");
        setIsLoading(false);
        return;
      }

      setProfile(data.profile);
      setIsLoading(false);
    }

    load();

    return () => {
      mounted = false;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!profile) {
      return;
    }

    setIsSaving(true);
    setMessage("");
    setIsError(false);

    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        full_name: profile.full_name,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      setIsError(true);
      setMessage(data?.error || "Failed to save profile draft.");
      setIsSaving(false);
      return;
    }

    setProfile(data.profile);
    setMessage("Profile saved.");
    setIsSaving(false);
  }

  if (isLoading) {
    return <p className="muted">Loading profile draft...</p>;
  }

  if (!profile) {
    return <p className="message message-error">No profile data available.</p>;
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <label className="field-label" htmlFor="profile-name">
        Full name
      </label>
      <input
        id="profile-name"
        className="input"
        type="text"
        placeholder="Full name"
        value={profile.full_name}
        onChange={(event) => setProfile({ ...profile, full_name: event.target.value })}
        required
      />

      <div className="row">
        <button className="button button-primary button-inline" type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Draft"}
        </button>
      </div>

      {message ? (
        <p className={`message ${isError ? "message-error" : "message-success"}`}>
          {message}
        </p>
      ) : null}
    </form>
  );
}
