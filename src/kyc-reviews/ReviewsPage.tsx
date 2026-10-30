import { useCallback, useEffect, useState } from "react";
import { listCases, openCase, decide, type CaseRow, type Case, type Decision } from "./api";

const MIN_REASON = 10;
const fmt = (s: string) => new Date(s).toLocaleString("en-MU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DOCS: [keyof Case["documents"], string][] = [["id", "Identity document"], ["selfie", "Selfie"], ["proof_of_address", "Proof of address"], ["permit", "Residence or work permit"]];

export default function ReviewsPage() {
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { setErr(""); listCases().then((d) => setRows(d.cases)).catch((e) => setErr(e.message)); }, []);
  useEffect(load, [load]);

  if (open) return <CaseView id={open} onBack={() => { setOpen(null); load(); }} />;
  const waiting = (rows ?? []).filter((r) => r.waiting && !r.decision);
  const done = (rows ?? []).filter((r) => !r.waiting || r.decision);
  return (
    <main>
      <h1>KYC reviews</h1>
      <p className="lead muted">Identity checks the automated system couldn't settle. Opening a case is recorded in the audit log.</p>
      {err && <p className="err" role="alert">{err}</p>}
      {!rows && !err && <p className="muted">Loading…</p>}
      {rows && (
        <section>
          <h2>Waiting ({waiting.length})</h2>
          {waiting.length === 0 ? <p className="muted">Nothing waiting for review.</p> : (
            <ol className="cases">{waiting.map((r) => <Row key={r.submission_id} r={r} onOpen={setOpen} />)}</ol>
          )}
        </section>
      )}
      {done.length > 0 && (
        <section className="history">
          <h2>Decided (last 30 days)</h2>
          <ol className="cases">{done.map((r) => <Row key={r.submission_id} r={r} onOpen={setOpen} />)}</ol>
        </section>
      )}
    </main>
  );
}

function Row({ r, onOpen }: { r: CaseRow; onOpen: (id: string) => void }) {
  const d = r.decision;
  return (
    <li>
      <button type="button" className="case-row" onClick={() => onOpen(r.submission_id)}>
        <strong>{r.full_name ?? "Unnamed borrower"}</strong>
        <span className="muted"> · {r.document_type ?? "document"} ••••{r.document_last4} · submitted {fmt(r.submitted_at)}</span>
        <span className="tag">risk {r.risk_score ?? "?"}</span>
        {d ? <span className="tag">{d.decision} by {d.reviewer}{r.waiting ? " (sending)" : ""}</span>
          : !r.waiting ? <span className="tag">{r.status}</span> : null}
        {r.flags.length > 0 && <span className="hint"> {r.flags.slice(0, 2).join(" · ")}{r.flags.length > 2 ? ` +${r.flags.length - 2}` : ""}</span>}
      </button>
    </li>
  );
}

function CaseView({ id, onBack }: { id: string; onBack: () => void }) {
  const [c, setC] = useState<Case | null>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [err, setErr] = useState("");
  useEffect(() => { openCase(id).then((d) => { setC(d.case); setDecision(d.decision); }).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <main><button type="button" className="ghost" onClick={onBack}>← Back</button><p className="err" role="alert">{err}</p></main>;
  if (!c) return <main><p className="muted">Opening case…</p></main>;
  const waiting = (c.status === "pending_review" || c.status === "under_review") && !decision;
  return (
    <main>
      <button type="button" className="ghost" onClick={onBack}>← Back to the queue</button>
      <h1>{c.client.full_name ?? "Unnamed borrower"}</h1>
      <p className="muted">Born {c.client.date_of_birth ?? "?"} · {[c.client.city, c.client.country].filter(Boolean).join(", ") || "no address"} · customer since {fmt(c.client.since)}</p>
      {!c.is_latest && <p className="status warn">The borrower has submitted again since this. Deciding records the review but won't change their status.</p>}

      <section className="history">
        <h2>What the checks found</h2>
        <p><span className="tag">risk {c.risk_score ?? "?"}</span> {c.document_type} {c.document_number}{c.nationality ? ` · ${c.nationality}` : ""}{c.residence_status ? ` · ${c.residence_status}` : ""}</p>
        <ul>
          <li>Face match: {c.face_match_score == null ? "not run" : `${Number(c.face_match_score).toFixed(0)}%`}</li>
          <li>Name on ID matches: {c.name_match_score == null ? "not run" : `${c.name_match_score}%`}</li>
          <li>Machine-readable zone: {c.mrz_valid == null ? "not found" : c.mrz_valid ? "valid" : "INVALID"}{c.document_expired ? " · DOCUMENT EXPIRED" : ""}</li>
        </ul>
        {c.flags.length > 0 && <><h3>Flags</h3><ul>{c.flags.map((f) => <li key={f}>{f}</li>)}</ul></>}
        {c.ai?.summary && <p className="hint">AI note: {c.ai.summary}</p>}
        {c.previous.length > 0 && <p className="hint">Earlier attempts: {c.previous.map((p) => `${p.status} (${fmt(p.submitted_at)})`).join(", ")}</p>}
      </section>

      <section className="history">
        <h2>Documents</h2>
        <p className="hint">Links expire after {Math.round(c.links_expire_in_s / 60)} minutes. Reopen the case for fresh ones.</p>
        <div className="docs">
          {DOCS.filter(([k]) => k !== "permit" || c.documents.permit).map(([k, label]) => (
            <figure key={k}>
              {c.documents[k] ? <a href={c.documents[k]!} target="_blank" rel="noreferrer noopener"><img src={c.documents[k]!} alt={label} /></a>
                : <div className="muted">Not available</div>}
              <figcaption>{label}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      {decision ? (
        <p className="status ok"><strong>{decision.decision === "verified" ? "Verified" : "Rejected"}</strong> by {decision.reviewer} on {fmt(decision.decided_at)}: “{decision.reason}”</p>
      ) : !waiting ? (
        <p className="status ok">This case is {c.status}{c.review_note ? `: ${c.review_note}` : ""}.</p>
      ) : <DecisionForm id={c.submission_id} onDone={setDecision} />}
    </main>
  );
}

function DecisionForm({ id, onDone }: { id: string; onDone: (d: Decision) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"" | "verified" | "rejected">("");
  const [err, setErr] = useState("");
  const go = async (d: "verified" | "rejected") => {
    setBusy(d); setErr("");
    try { onDone((await decide(id, d, reason.trim())).decision); } catch (e) { setErr((e as Error).message); setBusy(""); }
  };
  const short = reason.trim().length < MIN_REASON;
  return (
    <div className="confirm" role="group" aria-label="Decision">
      <label htmlFor="kyc-reason">Your reason (recorded and sent with the decision)</label>
      <textarea id="kyc-reason" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="What you checked and why you decided this" />
      <p className="hint">One decision per case; it can't be changed afterwards. The borrower is notified.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="primary destructive" disabled={!!busy || short} onClick={() => go("rejected")}>
          {busy === "rejected" ? "Saving…" : "Reject"}
        </button>
        <button type="button" className="primary" disabled={!!busy || short} onClick={() => go("verified")}>
          {busy === "verified" ? "Saving…" : "Verify identity"}
        </button>
      </div>
    </div>
  );
}
