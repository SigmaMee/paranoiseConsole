"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
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
    <main className="login-screen">
      <section className="login-panel">
        <div className="login-brand">
          <div className="login-header-row">
            <Image
              src="/branding/navbar-logo.png"
              alt="Paranoise Radio"
              width={256}
              height={55}
              className="login-logo"
              priority
            />
            <p className="login-overline">Console</p>
          </div>
        </div>

        <form className="login-form" onSubmit={onSubmit}>
          <div className="login-residents-banner">RESIDENTS ONLY</div>
          <div className="login-label-row">
            <label className="login-label" htmlFor="email">
              Email
            </label>
            <p className="login-label-helper">The one used with Paranoise.</p>
          </div>
          <input
            id="email"
            className="input"
            type="email"
            placeholder="Producer email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <div className="login-label-row">
            <label className="login-label" htmlFor="password">
              Producer name
            </label>
            <p className="login-label-helper">The one in our schedule</p>
          </div>
          <input
            id="password"
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button className="login-submit" type="submit" disabled={isLoading}>
            {isLoading ? "Signing in..." : "Sign in"}
          </button>
          <p className="login-label-helper login-footer-helper">Issues logging in? Contact us</p>
        </form>

        {message ? (
          <p className={`login-message ${isError ? "login-message-error" : "login-message-success"}`}>
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
