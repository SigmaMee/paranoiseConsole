"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setMessage("");
    setIsError(false);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setIsError(true);
      setMessage(error.message || "Sign-in failed.");
      setIsLoading(false);
      return;
    }

    setMessage("Sign-in successful. Redirecting...");
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="container">
      <section className="login-wrap card">
        <div className="hero">
          <p className="eyebrow">Paranoise Radio</p>
          <h1 className="title">Console Access</h1>
          <p className="muted">Sign in with your pre-created producer account.</p>
        </div>

        <form className="form" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            placeholder="Producer email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <label className="field-label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button className="button button-primary" type="submit" disabled={isLoading}>
            {isLoading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        {message ? (
          <p className={`message ${isError ? "message-error" : "message-success"}`}>
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
