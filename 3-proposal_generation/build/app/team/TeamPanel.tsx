"use client";

import { useState } from "react";
import type { Invite, Member } from "../../lib/team";
import type { Role } from "../../lib/auth";
import { Badge } from "../../components/ui";

/**
 * Team administration.
 *
 * Two lists, and the split between them is the point. MEMBERS are people who
 * have an account; the AUTHORISED ADDRESSES list is people who may create
 * one. Keeping them separate is what makes "who can approve a proposal?" a
 * question with a visible answer, rather than something inferred from
 * whoever happens to be able to sign in.
 */

const ROLE_HELP: Record<Role, string> = {
  salesperson: "Writes proposals. They cannot approve their own, or anybody else's.",
  approver: "Reads a proposal and signs it off. They cannot change a word of it.",
  admin: "Everything an approver can do, and they manage this list as well.",
};

type Notice = { tone: "good" | "bad"; message: string } | null;

export function TeamPanel({
  members: initialMembers,
  invites: initialInvites,
  currentUserId,
}: {
  members: Member[];
  invites: Invite[];
  currentUserId: string;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState(initialInvites);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("salesperson");
  const [note, setNote] = useState("");

  const live = invites.filter((i) => i.accepted_at === null && i.revoked_at === null);
  const historical = invites.filter((i) => i.accepted_at !== null || i.revoked_at !== null);
  const approvers = members.filter(
    (m) => m.is_active && (m.role === "approver" || m.role === "admin"),
  );

  async function send(
    key: string,
    url: string,
    init: RequestInit,
    onOk: (payload: Record<string, unknown>) => void,
  ) {
    if (pending) return;
    setPending(key);
    setNotice(null);
    try {
      const res = await fetch(url, init);
      const payload = (await res.json()) as Record<string, unknown> & {
        ok?: boolean;
        error?: { message: string };
      };
      if (!res.ok || !payload.ok) {
        setNotice({ tone: "bad", message: payload.error?.message ?? "That could not be saved." });
        return;
      }
      onOk(payload);
    } catch {
      setNotice({ tone: "bad", message: "Could not reach the server. Nothing was changed." });
    } finally {
      setPending(null);
    }
  }

  async function addInvite() {
    await send(
      "invite",
      "/api/team/invites",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role, note: note.trim() || undefined }),
      },
      (payload) => {
        setInvites([payload.invite as Invite, ...invites]);
        setEmail("");
        setNote("");
        setNotice({
          tone: "good",
          message: `${(payload.invite as Invite).email} can now register as ${role}. Send them the sign-up link; no password travels between you.`,
        });
      },
    );
  }

  async function revoke(id: string, address: string) {
    await send(`revoke:${id}`, `/api/team/invites/${id}`, { method: "DELETE" }, () => {
      setInvites(
        invites.map((i) => (i.id === id ? { ...i, revoked_at: new Date() as unknown as Date } : i)),
      );
      setNotice({ tone: "good", message: `${address} can no longer register.` });
    });
  }

  async function updateMember(id: string, patch: { role?: Role; active?: boolean }) {
    await send(
      `member:${id}`,
      `/api/team/members/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
      (payload) => {
        const updated = payload.member as Member | null;
        if (!updated) return;
        setMembers(
          members.map((m) =>
            m.id === id ? { ...m, role: updated.role, is_active: updated.is_active } : m,
          ),
        );
        setNotice({
          tone: "good",
          message:
            patch.active === false
              ? "Deactivated. Their sessions have ended and their name stays on everything they wrote."
              : patch.active === true
                ? "Reactivated."
                : `Role changed to ${updated.role}. They will be signed out and back in at the new role.`,
        });
      },
    );
  }

  return (
    <div className="flex flex-col gap-7">
      {notice ? (
        <div
          role="status"
          className={`rounded-[var(--radius-sm)] border px-3 py-2 t-base ${
            notice.tone === "bad"
              ? "border-[var(--bad-line)] bg-[var(--bad-soft)] text-[var(--bad)]"
              : "border-[var(--good-line)] bg-[var(--good-soft)] text-[var(--good)]"
          }`}
        >
          {notice.message}
        </div>
      ) : null}

      {/* ------------------------------------------------- who can approve */}
      <section className="card p-4">
        <h2 className="panel-title mb-1.5">Who can approve a proposal</h2>
        {approvers.length === 0 ? (
          <p className="hint m-0">
            Nobody. Every proposal will reach “pending approval” and stop there. Give at least one
            colleague the approver role below.
          </p>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {approvers.map((m) => (
                <li key={m.id} className="badge">
                  <span aria-hidden="true">●</span>
                  {m.name}
                </li>
              ))}
            </ul>
            <p className="hint mt-2 mb-0">
              An author can never approve their own proposal, whatever role they hold, so a team of
              one approver still needs a second person to send anything.
            </p>
          </>
        )}
      </section>

      {/* --------------------------------------------------------- members */}
      <section>
        <h2 className="panel-title mb-2">Members</h2>
        <div className="scroll-x">
          <table className="w-full min-w-[640px] border-collapse t-base">
            <thead>
              <tr className="text-left t-xs uppercase tracking-wide text-[var(--muted)]">
                <th className="border-b border-[var(--border)] py-2 pr-3 font-semibold">Name</th>
                <th className="border-b border-[var(--border)] py-2 pr-3 font-semibold">Role</th>
                <th className="border-b border-[var(--border)] py-2 pr-3 font-semibold">Work</th>
                <th className="border-b border-[var(--border)] py-2 font-semibold">Account</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.id === currentUserId;
                const busy = pending === `member:${m.id}`;
                return (
                  <tr key={m.id} className={m.is_active ? "" : "opacity-55"}>
                    <td className="border-b border-[var(--border)] py-2.5 pr-3 align-top">
                      <div className="font-medium">{m.name}</div>
                      <div className="t-xs text-[var(--muted)]">{m.email}</div>
                    </td>
                    <td className="border-b border-[var(--border)] py-2.5 pr-3 align-top">
                      {self ? (
                        <div>
                          <Badge tone="neutral" glyph="●">
                            {m.role}
                          </Badge>
                          <div className="mt-1 t-xs text-[var(--muted)]">
                            You. Another admin has to change this.
                          </div>
                        </div>
                      ) : (
                        <select
                          className="input h-[30px] py-0 t-sm"
                          value={m.role}
                          disabled={busy || !m.is_active}
                          onChange={(e) => updateMember(m.id, { role: e.target.value as Role })}
                          aria-label={`Role for ${m.name}`}
                        >
                          {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="border-b border-[var(--border)] py-2.5 pr-3 align-top t-sm text-[var(--ink-2)]">
                      {m.authored} written · {m.approvals} approved
                    </td>
                    <td className="border-b border-[var(--border)] py-2.5 align-top">
                      {self ? (
                        <span className="t-sm text-[var(--muted)]">active</span>
                      ) : (
                        <button
                          type="button"
                          className={`btn btn-sm ${m.is_active ? "btn-danger" : ""}`}
                          disabled={busy}
                          onClick={() => updateMember(m.id, { active: !m.is_active })}
                          title={
                            m.is_active
                              ? "Ends their sessions and blocks sign-in. Their name stays on everything they wrote."
                              : "Restores sign-in at their existing role."
                          }
                        >
                          {busy ? "…" : m.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------ authorised email */}
      <section>
        <h2 className="panel-title mb-1.5">Authorised addresses</h2>
        <p className="hint mt-0 mb-3 max-w-[70ch]">
          An address on this list may create its own account, at the role you choose here. Nobody
          else can register. You never set or send a password: the person chooses their own, so no
          credential travels between you.
        </p>

        <div className="card mb-3 flex flex-col gap-2.5 p-3.5">
          <div className="flex flex-wrap items-end gap-2.5">
            <div className="min-w-[220px] flex-1">
              <label className="field-label" htmlFor="invite-email">
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                className="input w-full"
                placeholder="priya@northgateclinics.co.uk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="invite-role">
                Role
              </label>
              <select
                id="invite-role"
                className="input"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending === "invite" || email.trim().length < 3}
              onClick={addInvite}
            >
              {pending === "invite" ? "Adding…" : "Authorise"}
            </button>
          </div>
          <p className="hint m-0">{ROLE_HELP[role]}</p>
          <input
            type="text"
            className="input w-full t-sm"
            placeholder="Optional note: who they are, why they need this"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note about this authorisation"
          />
        </div>

        {live.length === 0 ? (
          <p className="hint">No addresses are waiting to register.</p>
        ) : (
          <ul className="flex list-none flex-col gap-1.5 p-0">
            {live.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 t-base"
              >
                <span className="font-medium">{i.email}</span>
                <Badge tone={i.role === "salesperson" ? "neutral" : "good"} glyph="●">
                  {i.role}
                </Badge>
                {i.note ? (
                  <span className="t-sm italic text-[var(--muted)]">{i.note}</span>
                ) : null}
                <span className="ml-auto t-xs text-[var(--muted)]">
                  added by {i.invited_by_name ?? "a former administrator"}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending === `revoke:${i.id}`}
                  onClick={() => revoke(i.id, i.email)}
                >
                  {pending === `revoke:${i.id}` ? "…" : "Withdraw"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {historical.length > 0 ? (
          <details className="mt-3">
            <summary className="btn btn-ghost btn-sm">{historical.length} closed</summary>
            <ul className="mt-1.5 flex list-none flex-col gap-1 p-0 t-sm text-[var(--muted)]">
              {historical.map((i) => (
                <li key={i.id}>
                  {i.email} · {i.role} · {i.accepted_at ? "registered" : "withdrawn"}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}
