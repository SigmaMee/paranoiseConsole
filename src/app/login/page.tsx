"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeRequested, setCodeRequested] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  async function sendCode() {
    setIsLoading(true);
    setMessage("");
    setIsError(false);

    await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        shouldCreateUser: false,
      },
    });

    setCodeRequested(true);
    setMessage("If this email belongs to a resident account, a sign-in code is on its way.");
    setIsLoading(false);
  }

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendCode();
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
    setMessage("");
    setIsError(false);

    const { error } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.replace(/\s/g, ""),
      type: "email",
    });

    if (error) {
      setIsError(true);
      setMessage("That code is invalid or has expired. Check the code and try again.");
      setIsLoading(false);
      return;
    }

    setMessage("Signed in. Redirecting...");
    router.push("/dashboard");
    router.refresh();
  }

  function changeEmail() {
    setCodeRequested(false);
    setCode("");
    setMessage("");
    setIsError(false);
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

        <form className="login-form" onSubmit={codeRequested ? verifyCode : requestCode}>
          <div className="login-residents-banner">RESIDENTS ONLY</div>
          {!codeRequested ? (
            <>
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
                inputMode="email"
                autoComplete="email"
                placeholder="Producer email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={isLoading}
                required
              />
            </>
          ) : (
            <>
              <div className="login-label-row">
                <label className="login-label" htmlFor="code">
                  Sign-in code
                </label>
                <button className="login-text-button" type="button" onClick={changeEmail}>
                  Change email
                </button>
              </div>
              <p className="login-code-recipient">Sent to {email.trim().toLowerCase()}</p>
              <input
                id="code"
                className="input login-code-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{8}"
                maxLength={8}
                placeholder="00000000"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                autoFocus
                disabled={isLoading}
                required
              />
            </>
          )}
          <button className="login-submit" type="submit" disabled={isLoading}>
            {isLoading
              ? codeRequested
                ? "Verifying..."
                : "Sending code..."
              : codeRequested
                ? "Verify & sign in"
                : "Email me a sign-in code"}
          </button>
          {codeRequested ? (
            <button
              className="login-text-button login-resend"
              type="button"
              onClick={() => void sendCode()}
              disabled={isLoading}
            >
              Send a new code
            </button>
          ) : null}
          <p className="login-label-helper login-footer-helper">Issues signing in? Contact us</p>
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
