"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Registration against the authorised-address list.
 *
 * No role field, deliberately: the role is on the invite an administrator
 * created, and a form that let the applicant choose one would hand out
 * approval authority to anybody with a link.
 */
export function RegisterForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 12;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: { message: string } };
      if (!res.ok || !payload.ok) {
        setError(payload.error?.message ?? "That account could not be created.");
        return;
      }
      setDone(true);
    } catch {
      setError("Could not reach the server. Nothing was created.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="card p-5">
        <p className="m-0 t-base">
          Your account is ready. Your role was set by whoever authorised your address.
        </p>
        <Link href="/login" className="btn btn-primary mt-3 no-underline hover:no-underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form className="card flex flex-col gap-3 p-5" onSubmit={submit}>
      {error ? (
        <div
          role="alert"
          className="rounded-[var(--radius-sm)] border border-[var(--bad-line)] bg-[var(--bad-soft)] px-3 py-2 t-base text-[var(--bad)]"
        >
          {error}
        </div>
      ) : null}

      <div>
        <label className="field-label" htmlFor="reg-email">
          Work email
        </label>
        <input
          id="reg-email"
          type="email"
          className="input w-full"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
        <p className="hint m-0 mt-1">
          It has to be an address an administrator has already added to the team.
        </p>
      </div>

      <div>
        <label className="field-label" htmlFor="reg-name">
          Your name
        </label>
        <input
          id="reg-name"
          type="text"
          className="input w-full"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
        <p className="hint m-0 mt-1">This appears on the proposals you write.</p>
      </div>

      <div>
        <label className="field-label" htmlFor="reg-password">
          Password
        </label>
        <input
          id="reg-password"
          type="password"
          className="input w-full"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
        <p className={`hint m-0 mt-1 ${tooShort ? "text-[var(--attention)]" : ""}`}>
          At least 12 characters. Nobody else ever sees it, including the administrator who
          authorised your address.
        </p>
      </div>

      <button
        type="submit"
        className="btn btn-primary btn-lg"
        disabled={pending || password.length < 12 || name.trim().length < 2}
      >
        {pending ? "Creating…" : "Create account"}
      </button>

      <p className="hint m-0">
        Already have an account? <Link href="/login">Sign in</Link>.
      </p>
    </form>
  );
}
