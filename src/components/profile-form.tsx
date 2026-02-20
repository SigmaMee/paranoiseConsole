"use client";

import { FormEvent, useEffect, useState } from "react";

type Profile = {
  full_name: string;
  bio: string | null;
  location: string | null;
  avatar_url: string | null;
  social_url: string | null;
  sync_status: string;
  draft_updated_at: string | null;
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
        bio: profile.bio || "",
        location: profile.location || "",
        avatar_url: profile.avatar_url || "",
        social_url: profile.social_url || "",
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
    setMessage("Draft saved. Sync job queued for Webflow handoff.");
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

      <label className="field-label" htmlFor="profile-location">
        Location
      </label>
      <input
        id="profile-location"
        className="input"
        type="text"
        placeholder="Location"
        value={profile.location || ""}
        onChange={(event) => setProfile({ ...profile, location: event.target.value })}
      />

      <label className="field-label" htmlFor="profile-avatar">
        Avatar URL
      </label>
      <input
        id="profile-avatar"
        className="input"
        type="url"
        placeholder="Avatar URL"
        value={profile.avatar_url || ""}
        onChange={(event) => setProfile({ ...profile, avatar_url: event.target.value })}
      />

      <label className="field-label" htmlFor="profile-social">
        Social URL
      </label>
      <input
        id="profile-social"
        className="input"
        type="url"
        placeholder="Social URL"
        value={profile.social_url || ""}
        onChange={(event) => setProfile({ ...profile, social_url: event.target.value })}
      />

      <label className="field-label" htmlFor="profile-bio">
        Bio
      </label>
      <textarea
        id="profile-bio"
        className="textarea"
        placeholder="Bio"
        value={profile.bio || ""}
        onChange={(event) => setProfile({ ...profile, bio: event.target.value })}
        rows={5}
      />

      <div className="row">
        <span className="pill">Sync status: {profile.sync_status}</span>
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
