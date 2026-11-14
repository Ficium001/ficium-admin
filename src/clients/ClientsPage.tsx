import { useCallback, useEffect, useState } from "react";
import { search, openClient, requestAccess, decideAccess, type ClientRow, type Client, type AccessRequest } from "./api";

const MIN_REASON = 10;
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("en-MU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "never");
const mur = (n: number) => `MUR ${Number(n).toLocaleString("en-MU")}`;

export default function ClientsPage() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [pending, setPending] = useState<AccessRequest[]>([]);
  const [canApprove, setCanApprove] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const run = useCallback(async (term: string) => {
    setErr(""); setBusy(true);
    try {
      const d = await search(term);
      setRows(term ? d.clients : null); setPending(d.pending); setCanApprove(d.can_approve);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void run(""); }, [run]);

  if (open) return <ClientView id={open} onBack={() => { setOpen(null); void run(q.trim()); }} />;
  const term = q.trim();
  return (
    <main>
      <h1>Borrowers</h1>
      <p className="lead muted">Look a borrower up by email, name or id. Every search and every borrower you open is recorded in the audit log.</p>

      <form className="row" onSubmit={(e) => { e.preventDefault(); if (term.length >= 3) void run(term); }}>
        <label htmlFor="client-q" className="sr-only">Search borrowers</label>
        <input id="client-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100}
          placeholder="Email, name or borrower id (at least 3 characters)" autoComplete="off" />
        <button type="submit" className="primary" disabled={busy || term.length < 3}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {err && <p className="err" role="alert">{err}</p>}

      {rows && (
        <section>
          <h2>Results ({rows.length})</h2>
          {rows.length === 0 ? <p className="muted">No borrower matches.</p> : (
            <ol className="cases">{rows.map((r) => (
              <li key={r.client_id}>
                <button type="button" className="case-row" onClick={() => setOpen(r.client_id)}>
                  <strong>{r.full_name ?? "Unnamed borrower"}</strong>
                  <span className="muted"> · {r.email ?? "no email"} · joined {fmt(r.created_at)}</span>
                  <span className="tag">KYC {r.kyc_status}</span>
                  {r.suspended && <span className="tag">suspended</span>}
                  {r.closed && <span className="tag">closed</span>}
                </button>
              </li>
            ))}</ol>
          )}
        </section>
      )}

      <section className="history">
        <h2>Waiting for a second admin ({pending.length})</h2>
        {pending.length === 0 ? <p className="muted">No suspension or reinstatement is waiting.</p> : (
          <ol className="cases">{pending.map((p) => (
            <li key={p.id}>
              <button type="button" className="case-row" onClick={() => setOpen(p.client_id)}>
                <strong>{p.action === "suspend" ? "Suspend" : "Reinstate"}</strong>
                <span className="muted"> · asked by {p.maker} on {fmt(p.created_at)} · expires {fmt(p.expires_at)}</span>
                {p.mine ? <span className="tag">yours</span> : canApprove ? <span className="tag">needs you</span> : null}
              </button>
            </li>
          ))}</ol>
        )}
      </section>
    </main>
  );
}

function ClientView({ id, onBack }: { id: string; onBack: () => void }) {
  const [c, setC] = useState<Client | null>(null);
  const [reqs, setReqs] = useState<AccessRequest[]>([]);
  const [perm, setPerm] = useState({ can_request: false, can_approve: false });
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    setErr("");
    openClient(id).then((d) => { setC(d.client); setReqs(d.requests); setPerm({ can_request: d.can_request, can_approve: d.can_approve }); })
      .catch((e) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (err) return <main><button type="button" className="ghost" onClick={onBack}>← Back</button><p className="err" role="alert">{err}</p></main>;
  if (!c) return <main><p className="muted">Opening borrower…</p></main>;
  const pending = reqs.find((r) => r.status === "pending");
  const counts = Object.entries(c.requests);
  return (
    <main>
      <button type="button" className="ghost" onClick={onBack}>← Back to search</button>
      <h1>{c.full_name ?? "Unnamed borrower"}</h1>
      <p className="muted">
        {c.email ?? "no email"}{c.email_confirmed ? "" : " (not confirmed)"}{c.phone_last4 ? ` · phone ••••${c.phone_last4}` : ""}
        {c.country ? ` · ${c.country}` : ""} · joined {fmt(c.created_at)} · last sign-in {fmt(c.last_sign_in_at)}
      </p>
      <p>
        <span className="tag">KYC {c.kyc_status}</span>
        {c.suspended && <span className="tag">suspended</span>}
        {c.closed_at && <span className="tag">closed {fmt(c.closed_at)} · records kept until {c.retain_until}</span>}
      </p>
      <p className="hint">Borrower id {c.client_id}</p>

      <section className="history">
        <h2>Requests</h2>
        {counts.length === 0 ? <p className="muted">No requests.</p> : (
          <p>{counts.map(([s, n]) => <span key={s} className="tag">{s} {n}</span>)}</p>
        )}
        {c.recent_requests.length > 0 && (
          <ul>{c.recent_requests.map((r) => (
            <li key={r.id}>{r.product_type.replace(/_/g, " ")} · {mur(r.amount)} · {r.status} · {fmt(r.created_at)}</li>
          ))}</ul>
        )}
      </section>

      <section className="history">
        <h2>Access</h2>
        {pending ? <PendingDecision r={pending} canApprove={perm.can_approve} onDone={load} />
          : c.closed_at ? <p className="muted">The account is closed. Nothing to change.</p>
          : perm.can_request ? <AskForm client={c} onDone={load} />
          : <p className="muted">You can look borrowers up but not suspend or reinstate them.</p>}
        {reqs.filter((r) => r.status !== "pending").length > 0 && (
          <>
            <h3>History</h3>
            <ul>{reqs.filter((r) => r.status !== "pending").map((r) => (
              <li key={r.id}>
                <strong>{r.action}</strong> {r.status} · asked by {r.maker} {fmt(r.created_at)}
                {r.checker ? ` · ${r.status} by ${r.checker} ${fmt(r.decided_at)}` : ""}: “{r.reason}”
                {r.decision_note ? <span className="hint"> Note: {r.decision_note}</span> : null}
              </li>
            ))}</ul>
          </>
        )}
      </section>
    </main>
  );
}

function AskForm({ client, onDone }: { client: Client; onDone: () => void }) {
  const action = client.suspended ? "reinstate" : "suspend";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const short = reason.trim().length < MIN_REASON;
  const go = async () => {
    setBusy(true); setErr("");
    try { await requestAccess(client.client_id, action, reason.trim()); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="confirm" role="group" aria-label={action === "suspend" ? "Suspend borrower" : "Reinstate borrower"}>
      <p>
        {action === "suspend"
          ? "Suspending blocks sign-in, ends every session and closes requests still out for offers. A second admin must approve before anything happens."
          : "Reinstating lets the borrower sign in again. Closed requests stay closed. A second admin must approve before anything happens."}
      </p>
      <label htmlFor="access-reason">Your reason (recorded, and shown to the approver)</label>
      <textarea id="access-reason" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder={action === "suspend" ? "What you found and why the account must be blocked" : "Why the borrower should have access again"} />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className={action === "suspend" ? "primary destructive" : "primary"} disabled={busy || short} onClick={go}>
          {busy ? "Sending…" : action === "suspend" ? "Ask to suspend" : "Ask to reinstate"}
        </button>
      </div>
    </div>
  );
}

function PendingDecision({ r, canApprove, onDone }: { r: AccessRequest; canApprove: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "approve" | "reject" | "withdraw">("");
  const [err, setErr] = useState("");
  const go = async (op: "approve" | "reject" | "withdraw") => {
    setBusy(op); setErr("");
    try { await decideAccess(op, r, note.trim() || undefined); onDone(); } catch (e) { setErr((e as Error).message); setBusy(""); }
  };
  return (
    <div className="confirm" role="group" aria-label="Pending request">
      <p className="status warn">
        <strong>{r.action === "suspend" ? "Suspension" : "Reinstatement"} requested</strong> by {r.maker} on {fmt(r.created_at)}: “{r.reason}”.
        Expires {fmt(r.expires_at)}.
      </p>
      {r.mine ? (
        <>
          <p className="hint">You asked for this, so another admin must approve it.</p>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="ghost" disabled={!!busy} onClick={() => go("withdraw")}>{busy === "withdraw" ? "Withdrawing…" : "Withdraw my request"}</button>
          </div>
        </>
      ) : canApprove ? (
        <>
          <label htmlFor="access-note">Note (required to reject)</label>
          <textarea id="access-note" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          {err && <p className="err" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="ghost" disabled={!!busy || note.trim().length < MIN_REASON} onClick={() => go("reject")}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" className={r.action === "suspend" ? "primary destructive" : "primary"} disabled={!!busy} onClick={() => go("approve")}>
              {busy === "approve" ? "Approving…" : r.action === "suspend" ? "Approve suspension" : "Approve reinstatement"}
            </button>
          </div>
        </>
      ) : <p className="muted">Waiting for an admin who can approve.</p>}
    </div>
  );
}
