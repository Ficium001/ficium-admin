import { useEffect, useState } from "react";
import { claims } from "../auth/client";
import {
  loadOverview, loadDocuments, downloadLink, reviewDocument, askWaiver, approveWaiver, rejectWaiver, withdrawWaiver,
  type Bank, type Doc, type WaiverRequest, type Overview,
} from "./api";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" });
const MAX_DAYS = 180;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default function CompliancePage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const me = claims()?.email?.toLowerCase() ?? "";

  const refresh = () => loadOverview().then((d) => { setData(d); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !data) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!data) return <main className="shell"><p className="muted">Loading compliance…</p></main>;

  const blocked = data.overview.filter((b) => !b.can_bid);
  const pending = data.requests.filter((r) => r.status === "pending");
  const decided = data.requests.filter((r) => r.status !== "pending").slice(0, 30);

  return (
    <main className="shell">
      <header className="top">
        <h1>Compliance</h1>
        <p className="who">Signed in as {me}</p>
      </header>

      <section className={`status ${blocked.length ? "warn" : "ok"}`} aria-live="polite">
        {blocked.length
          ? <p><strong>{blocked.length} bank{blocked.length > 1 ? "s cannot" : " cannot"} bid.</strong> A bank can bid once every required document is approved and in date, or while a waiver is active.</p>
          : <p><strong>Every bank can bid.</strong></p>}
      </section>

      {pending.length > 0 && (
        <section className="history">
          <h2>Waiting for a second approver</h2>
          <ul className="board">
            {pending.map((r) => <PendingRequest key={r.id} r={r} mine={r.maker_email.toLowerCase() === me} onDone={refresh} />)}
          </ul>
        </section>
      )}

      <section className="history">
        <h2>Banks</h2>
        {data.overview.length === 0 ? <p className="muted empty">No banks yet.</p> : (
          <ul className="board">
            {data.overview.map((b) => (
              <li key={b.institution_id} className={`breaker ${b.can_bid ? "on" : "off"}`}>
                <button className="row-btn" aria-expanded={open === b.institution_id}
                  onClick={() => setOpen(open === b.institution_id ? null : b.institution_id)}>
                  <span className="text">
                    <strong>{b.name}</strong>
                    <span className="muted"> · {b.can_bid ? "Can bid" : "Cannot bid"}
                      {b.waived_until && !b.waiver_revoked_at && ` · waiver until ${day(b.waived_until)}`}
                      {b.docs_pending > 0 && ` · ${b.docs_pending} document${b.docs_pending > 1 ? "s" : ""} to review`}
                    </span>
                  </span>
                  <span aria-hidden>{open === b.institution_id ? "−" : "+"}</span>
                </button>
                {open === b.institution_id && (
                  <BankDetail bank={b} hasPending={pending.some((r) => r.institution_id === b.institution_id)} onChange={refresh} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="history">
        <h2>Waiver decisions</h2>
        {decided.length === 0 ? <p className="muted">None yet. Every request, approval and rejection is logged with who did it and why.</p> : (
          <ol>{decided.map((r) => (
            <li key={r.id}>
              <p><strong>{r.institution_name}</strong>: {r.action === "grant" ? `waiver until ${day(r.waived_until!)}` : "revoke waiver"} {r.status}
                {r.checker_email ? ` by ${r.checker_email}` : ""} (asked by {r.maker_email})</p>
              <p className="reason">“{r.decision_note ?? r.reason}”</p>
              {r.decided_at && <time dateTime={r.decided_at}>{fmt(r.decided_at)}</time>}
            </li>))}
          </ol>
        )}
      </section>
    </main>
  );
}

function PendingRequest({ r, mine, onDone }: { r: WaiverRequest; mine: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <li className="breaker on">
      <div className="text">
        <h2>{r.institution_name}: {r.action === "grant" ? `waive the document gate until ${day(r.waived_until!)}` : "revoke the waiver"}</h2>
        <p>Asked by {r.maker_email} · {fmt(r.created_at)}</p>
        <p className="reason">“{r.reason}”</p>
      </div>
      {mine ? (
        <div className="confirm">
          <p className="hint">You asked for this, so someone else must approve it.</p>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="actions"><button className="ghost" disabled={busy} onClick={() => run(() => withdrawWaiver(r))}>Withdraw</button></div>
        </div>
      ) : (
        <form className="confirm" onSubmit={(e) => e.preventDefault()}>
          <label htmlFor={`n-${r.id}`}>Note (required to reject)</label>
          <textarea id={`n-${r.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          {err && <p className="err" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="ghost" disabled={busy || note.trim().length < 10} onClick={() => run(() => rejectWaiver(r, note.trim()))}>Reject</button>
            <button type="button" className="primary" disabled={busy} onClick={() => run(() => approveWaiver(r, note.trim()))}>
              {busy ? "Working…" : "Approve and apply"}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function BankDetail({ bank, hasPending, onChange }: { bank: Bank; hasPending: boolean; onChange: () => void }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [err, setErr] = useState("");
  const reload = () => loadDocuments(bank.institution_id).then(setDocs).catch((e) => setErr(e.message));
  useEffect(() => { reload(); }, [bank.institution_id]);

  const waiverActive = !!bank.waived_until && !bank.waiver_revoked_at && new Date(bank.waived_until) > new Date();
  return (
    <div className="confirm">
      {bank.missing_docs.length > 0 && <p className="consequence">Missing or not approved: {bank.missing_docs.join(", ")}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      {!docs ? <p className="muted">Loading documents…</p> : docs.length === 0 ? <p className="muted">No documents uploaded.</p> : (
        <ul className="board">{docs.map((d) => <DocRow key={d.id} d={d} onDone={() => { reload(); onChange(); }} />)}</ul>
      )}
      {hasPending
        ? <p className="hint">A waiver request for this bank is waiting for approval.</p>
        : <WaiverAsk bank={bank} revoke={waiverActive} onDone={onChange} />}
    </div>
  );
}

function DocRow({ d, onDone }: { d: Doc; onDone: () => void }) {
  const [mode, setMode] = useState<"none" | "approve" | "reject">("none");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState(d.expiry_date ?? "");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const open = async () => {
    setErr("");
    try { setLink((await downloadLink(d.id)).url); } catch (e) { setErr((e as Error).message); }
  };
  const save = async () => {
    setBusy(true); setErr("");
    try { await reviewDocument(d, mode as "approve" | "reject", reason.trim(), expiry); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <li className="breaker on">
      <div className="row">
        <div className="text">
          <h2>{d.doc_type_label}{d.is_mandatory && <span className="tag">Required</span>}</h2>
          <p>{d.file_name} · {d.status}{d.expiry_date ? ` · expires ${day(d.expiry_date)}` : ""} · uploaded {fmt(d.uploaded_at)}</p>
          {d.rejection_reason && <p className="reason">Rejected: “{d.rejection_reason}”</p>}
        </div>
        <div className="actions">
          {link ? <a href={link} target="_blank" rel="noopener noreferrer">Open (5 min)</a>
                : <button className="ghost" onClick={open}>View</button>}
          {d.status === "pending" && mode === "none" && <>
            <button className="ghost" onClick={() => setMode("reject")}>Reject</button>
            <button className="primary" onClick={() => setMode("approve")}>Approve</button>
          </>}
        </div>
      </div>
      {mode !== "none" && (
        <form className="confirm" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {mode === "approve" ? <>
            <label htmlFor={`e-${d.id}`}>Valid until (optional)</label>
            <input id={`e-${d.id}`} type="date" value={expiry} min={isoDate(new Date())} onChange={(e) => setExpiry(e.target.value)} />
          </> : <>
            <label htmlFor={`r-${d.id}`}>What is wrong with it? The bank sees this.</label>
            <textarea id={`r-${d.id}`} rows={2} maxLength={500} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} />
          </>}
          {err && <p className="err" role="alert">{err}</p>}
          <div className="actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setMode("none")}>Cancel</button>
            <button type="submit" className={mode === "approve" ? "primary" : "primary destructive"}
              disabled={busy || (mode === "reject" && reason.trim().length < 5)}>
              {busy ? "Saving…" : mode === "approve" ? "Approve document" : "Reject document"}
            </button>
          </div>
        </form>
      )}
      {mode === "none" && err && <p className="err" role="alert">{err}</p>}
    </li>
  );
}

function WaiverAsk({ bank, revoke, onDone }: { bank: Bank; revoke: boolean; onDone: () => void }) {
  const [openForm, setOpenForm] = useState(false);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const max = new Date(Date.now() + MAX_DAYS * 86_400_000);
  const ok = reason.trim().length >= 10 && (revoke || !!until);

  if (!openForm) return (
    <div className="actions left">
      <button className="ghost" onClick={() => setOpenForm(true)}>{revoke ? "Ask to revoke the waiver" : "Ask for a waiver"}</button>
    </div>
  );
  return (
    <form className="confirm" onSubmit={async (e) => {
      e.preventDefault(); if (!ok) return; setBusy(true); setErr("");
      try {
        await askWaiver(bank, revoke ? "revoke" : "grant", reason.trim(), revoke ? undefined : new Date(`${until}T23:59:59Z`).toISOString());
        onDone();
      } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      {!revoke && <p className="consequence">While a waiver is active, {bank.name} can bid without its required documents approved.</p>}
      {!revoke && <>
        <label htmlFor={`u-${bank.institution_id}`}>Waive until (at most {MAX_DAYS} days)</label>
        <input id={`u-${bank.institution_id}`} type="date" required value={until}
          min={isoDate(new Date(Date.now() + 86_400_000))} max={isoDate(max)} onChange={(e) => setUntil(e.target.value)} />
      </>}
      <label htmlFor={`w-${bank.institution_id}`}>Why?</label>
      <textarea id={`w-${bank.institution_id}`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="hint">A second admin must approve this before it takes effect.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => setOpenForm(false)}>Cancel</button>
        <button type="submit" className="primary" disabled={!ok || busy}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </form>
  );
}
