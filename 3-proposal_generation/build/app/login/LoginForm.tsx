"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "./actions";
import { ErrorNote } from "../../components/ui";

const INITIAL: LoginState = { error: null, correlationId: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-lg w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm({
  next,
  demo,
}: {
  next: string;
  demo: { label: string; email: string; password: string }[];
}) {
  const [state, formAction] = useActionState(loginAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      {state.error ? (
        <ErrorNote message={state.error} correlationId={state.correlationId} />
      ) : null}

      <div>
        <label className="field-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          required
          autoFocus
        />
      </div>

      <div>
        <label className="field-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          required
        />
      </div>

      <SubmitButton />

      {/* {demo.length > 0 ? (
        <div className="mt-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <div className="rail-title">Demo accounts</div>
          <p className="hint mt-1 mb-2">
            Both roles are real and enforced on the server. Approval needs the approver
            account: a salesperson cannot approve at all, and nobody can approve a proposal
            they wrote themselves.
          </p>
          <div className="flex flex-col gap-1.5">
            {demo.map((account) => (
              <button
                key={account.email}
                type="button"
                className="btn btn-sm justify-between text-left"
                onClick={() => {
                  // Fills the form rather than signing in directly, so the
                  // reviewer sees which account they are using.
                  const form = document.querySelector("form");
                  const email = form?.querySelector<HTMLInputElement>("#email");
                  const password = form?.querySelector<HTMLInputElement>("#password");
                  if (email) email.value = account.email;
                  if (password) password.value = account.password;
                  password?.focus();
                }}
              >
                <span className="font-semibold">{account.label}</span>
                <span className="mono text-[var(--muted)]">{account.email}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null} */}
    </form>
  );
}
