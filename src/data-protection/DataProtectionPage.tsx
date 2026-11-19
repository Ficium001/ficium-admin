/**
 * Data protection (app site, under Customers): requests from people about their personal data,
 * each with a deadline one month from receipt and a timeline of what was done, and the
 * retention schedule (how long each kind of data is kept and how it is deleted).
 */
import { useEffect, useState } from "react";
import { load, logRequest, act, saveRetention, type Action, type Kind, type Channel, type NewRequest, type Request, type Retention, type View } from "./api";

const MIN = 10;
export const KIND: Record<Kind, string> = {
  access: "Copy of their data", correction: "Correct their data", erasure: "Delete their data", restriction: "Limit how it is used",
  objection: "Object to how it is used", automated_decision: "Question an automated decision", withdraw_consent: "Withdraw consent",
};
export const CHANNEL: Record<Channel, string> = { email: "Email", app: "In the app", letter: "Letter", phone: "Phone", in_person: "In person", other: "Other" };
export const STATUS: Record<Request["status"], { text: string; pill: "" | "ok" | "warn" | "danger" }> = {
  received: { text: "Received", pill: "" }, in_progress: { text: "In progress", pill: "" },
  completed: { text: "Completed", pill: "ok" }, refused: { text: "Refused", pill: "warn" }, withdrawn: { text: "Withdrawn", pill: "" },
};
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtDay = (iso: string | null) => (iso ? DAY.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—");
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function deadline(r: Request): { text: string; pill: "" | "ok" | "warn" | "danger" } {
  const d = r.days_left;
  if (d == null) return { text: `Closed ${fmtDay(r.closed_on)}`, pill: "" };
  if (d < 0) return { text: `Overdue by ${-d} day${d === -1 ? "" : "s"}`, pill: "danger" };
  if (d === 0) return { text: "Due today", pill: "danger" };
  if (d <= 7) return { text: `Due in ${d} day${d === 1 ? "" : "s"}`, pill: "warn" };
  return { text: `Due in ${d} days`, pill: "ok" };
}

export function summary(v: View): { text: string; tone: "ok" | "warn" | "danger" | "" } {
  const overdue = v.open.filter((r) => (r.days_left ?? 1) < 0).length;
  const soon = v.open.filter((r) => r.days_left != null && r.days_left >= 0 && r.days_left <= 7).length;
  const undecided = v.retention.filter((t) => !t.decided).length;
  const tail = undecided ? ` ${undecided} kind${undecided === 1 ? "" : "s"} of data still ${undecided === 1 ? "has" : "have"} no decided retention period.` : "";
  if (overdue) return { tone: "danger", text: `${overdue} request${overdue === 1 ? " is" : "s are"} past the one-month deadline.${tail}` };
  if (soon) return { tone: "warn", text: `${soon} request${soon === 1 ? " is" : "s are"} due within 7 days.${tail}` };
  if (v.open.length) return { tone: undecided ? "warn" : "ok", text: `${v.open.length} open, none due within 7 days.${tail}` };
  return { tone: undecided ? "warn" : "ok", text: `No open requests.${tail}` };
}

export default function DataProtectionPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then(setView).catch((e) => setError((e as Error).message)); }, []);
  if (error && !view) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell wide"><p className="muted">Loading data protection requests…</p></main>;
  return <DataProtectionView view={view} onChange={setView} />;
}

/** The page for a loaded state. Calls go through the api module; rendering needs none. */
export function DataProtectionView({ view, onChange, initiallyOpen = null }: { view: View; onChange: (v: View) => void; initiallyOpen?: string | null }) {
  const [logging, setLogging] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initiallyOpen);
  const [editing, setEditing] = useState<string | null>(null);
  const top = summary(view);
  return (
    <main className="shell wide">
      <header className="top">
        <h1>Data protection</h1>
        <p className="who">Signed in as {view.actor}</p>
      </header>
      <p className="lead">
        Requests from people about their personal data under the Data Protection Act 2017: a copy, a correction, deletion, or an
        objection. Each must be answered within one month of receipt. Check the person's identity before any of their data is sent
        or changed.
      </p>
      <section className={`status ${top.tone}`} role={top.tone === "danger" ? "alert" : "status"}>
        <p><strong>{top.text}</strong></p>
        {view.can_manage && !logging && <div className="actions left">
          <button type="button" className="ghost" onClick={() => setLogging(true)}>Log a request</button>
        </div>}
      </section>

      {logging && <LogForm today={view.today} onCancel={() => setLogging(false)}
        onSave={async (n) => { const v = await logRequest(n); onChange(v); setLogging(false); setOpenId(v.open.find((r) => r.requester === n.requester.trim())?.id ?? null); }} />}

      <h2 className="group">Open requests</h2>
      {view.open.length === 0
        ? <p className="muted">None. Requests arrive by email, letter, phone or in the app: log each one here the day it arrives, so the deadline starts from the right date.</p>
        : <ul className="cases">{view.open.map((r) => (
            <Case key={r.id} r={r} view={view} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} onChange={onChange} />
          ))}</ul>}

      {view.closed.length > 0 && <>
        <h2 className="group">Closed</h2>
        <table className="table">
          <caption className="sr-only">Closed requests, most recent first</caption>
          <thead><tr><th scope="col">Request</th><th scope="col">Outcome</th><th scope="col">Closed</th></tr></thead>
          <tbody>{view.closed.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.ref} · {KIND[r.kind]}<br /><span className="muted">{r.requester}, received {fmtDay(r.received_on)}</span></th>
              <td><span className={`pill ${STATUS[r.status].pill}`}>{STATUS[r.status].text}</span>{r.outcome && <><br /><span className="muted">{r.outcome}</span></>}</td>
              <td>{fmtDay(r.closed_on)}{r.closed_by && <><br /><span className="muted">{r.closed_by}</span></>}
                {r.closed_on && <><br /><span className="muted">{r.closed_on <= r.due_on ? "On time" : "Late"}</span></>}</td>
            </tr>
          ))}</tbody>
        </table>
      </>}

      <h2 className="group">Retention schedule</h2>
      <p className="hint">How long each kind of data is kept, why, and how it is deleted. "Not decided" is a gap to close before a bank's risk review.</p>
      <table className="table">
        <caption className="sr-only">Retention schedule</caption>
        <thead><tr><th scope="col">Data</th><th scope="col">Kept for</th><th scope="col">How it is deleted</th><th scope="col"><span className="sr-only">Edit</span></th></tr></thead>
        <tbody>{view.retention.map((t) => editing === t.key
          ? <tr key={t.key}><td colSpan={4}><RetentionForm t={t} onCancel={() => setEditing(null)}
              onSave={async (n, reason) => { onChange(await saveRetention(n, reason)); setEditing(null); }} /></td></tr>
          : <tr key={t.key}>
              <th scope="row">{t.data}<br /><span className="muted">{t.where_kept}</span></th>
              <td>
                <span className={`pill ${!t.decided ? "warn" : t.enforced ? "ok" : ""}`}>{!t.decided ? "Not decided" : t.enforced ? "Enforced" : "Decided, not automated"}</span>
                <br />{t.kept_for}<br /><span className="muted">{t.basis}</span>
              </td>
              <td>{t.how_deleted}</td>
              <td>{view.can_manage && <button type="button" className="ghost" disabled={editing !== null} aria-label={`Edit retention for ${t.data}`} onClick={() => setEditing(t.key)}>Edit</button>}</td>
            </tr>)}</tbody>
      </table>
    </main>
  );
}

function Case({ r, view, open, onToggle, onChange }: { r: Request; view: View; open: boolean; onToggle: () => void; onChange: (v: View) => void }) {
  const due = deadline(r);
  const panel = `dp-${r.id}`;
  return (
    <li className="case">
      <button type="button" className="case-head" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <span><strong>{r.ref}</strong> · {KIND[r.kind]}<br /><span className="muted">{r.requester} · {CHANNEL[r.channel]} · received {fmtDay(r.received_on)}</span></span>
        <span className="case-pills">
          <span className={`pill ${due.pill}`}>{due.text}</span>
          <span className={`pill ${r.identity_verified_on ? "ok" : "warn"}`}>{r.identity_verified_on ? "Identity checked" : "Identity not checked"}</span>
          <span className={`pill ${STATUS[r.status].pill}`}>{STATUS[r.status].text}</span>
        </span>
      </button>
      <div id={panel} hidden={!open} className="case-body">
        <p>{r.summary}</p>
        <p className="hint">Contact: {r.contact}{r.client_id ? ` · Borrower ${r.client_id}` : ""} · Owner: {r.owner ?? "nobody"} · Due {fmtDay(r.due_on)}</p>
        <ol className="timeline" aria-label="What was done">
          {r.events.map((e, i) => <li key={i}><time>{fmtWhen(e.at)}</time> <span className="muted">{e.by}</span><br />{e.text}</li>)}
        </ol>
        {view.can_manage && open && <Actions r={r} canClose={view.can_close} today={view.today} onChange={onChange} />}
      </div>
    </li>
  );
}

const NEEDS_TEXT: Partial<Record<Action, string>> = {
  note: "Note", verify_identity: "How the identity was checked", complete: "What was sent, changed or deleted",
  refuse: "Why it is refused, and how the person was told", withdraw: "How the person withdrew it",
};

function Actions({ r, canClose, today, onChange }: { r: Request; canClose: boolean; today: string; onChange: (v: View) => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState("");
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const needsIdentity = !r.identity_verified_on && r.kind !== "withdraw_consent";
  const run = async (a: Action) => {
    setBusy(true); setErr("");
    try { onChange(await act(r, a, text, a === "verify_identity" ? date : "")); setAction(null); setText(""); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const choose = (a: Action) => { setErr(""); setText(""); if (NEEDS_TEXT[a]) setAction(a); else void run(a); };
  const minText = action === "note" ? 1 : action === "verify_identity" ? 3 : MIN;
  return (
    <div className="case-actions">
      {!action && <div className="actions left">
        {needsIdentity && <button type="button" className="primary" disabled={busy} onClick={() => choose("verify_identity")}>Record identity check</button>}
        {r.status === "received" && !needsIdentity && <button type="button" className="primary" disabled={busy} onClick={() => choose("start")}>Start work</button>}
        <button type="button" className="ghost" disabled={busy} onClick={() => choose("note")}>Add a note</button>
        {!r.mine && <button type="button" className="ghost" disabled={busy} onClick={() => choose("take")}>Take it over</button>}
        {canClose && !needsIdentity && <button type="button" className="ghost" disabled={busy} onClick={() => choose("complete")}>Complete…</button>}
        {canClose && <button type="button" className="ghost" disabled={busy} onClick={() => choose("refuse")}>Refuse…</button>}
        <button type="button" className="ghost" disabled={busy} onClick={() => choose("withdraw")}>Withdrawn…</button>
      </div>}
      {!canClose && !action && <p className="hint">Only compliance can complete or refuse a request.</p>}
      {action && (
        <div className={`confirm ${action === "refuse" ? "grave" : ""}`}>
          <label htmlFor={`dp-text-${r.id}`}>{NEEDS_TEXT[action]}</label>
          <textarea id={`dp-text-${r.id}`} rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          {action === "verify_identity" && <div className="fld"><label htmlFor={`dp-date-${r.id}`}>Checked on</label>
            <input id={`dp-date-${r.id}`} type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></div>}
          {(action === "complete" || action === "refuse") && <p className="consequence">This closes the request. It cannot be reopened; log a new one if the person comes back.</p>}
          <div className="actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
            <button type="button" className={action === "refuse" ? "primary destructive" : "primary"} disabled={busy || text.trim().length < minText}
              onClick={() => run(action)}>{busy ? "Saving…" : action === "complete" ? "Complete" : action === "refuse" ? "Refuse" : action === "withdraw" ? "Mark withdrawn" : "Save"}</button>
          </div>
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </div>
  );
}

const blank: NewRequest = { kind: "", requester: "", contact: "", client_id: "", channel: "", summary: "", received_on: "" };

function LogForm({ today, onCancel, onSave }: { today: string; onCancel: () => void; onSave: (n: NewRequest) => Promise<void> }) {
  const [n, setN] = useState<NewRequest>({ ...blank, received_on: today });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof NewRequest) => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  const ready = n.kind && n.channel && n.requester.trim() && n.contact.trim() && n.summary.trim().length >= MIN && n.received_on;
  return (
    <section className="panel form" aria-labelledby="dp-log">
      <h2 id="dp-log">Log a request</h2>
      <div className="two">
        <div className="fld"><label htmlFor="dp-kind">They are asking to</label>
          <select id="dp-kind" value={n.kind} onChange={set("kind")}><option value="">Choose…</option>
            {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></div>
        <div className="fld"><label htmlFor="dp-channel">Arrived by</label>
          <select id="dp-channel" value={n.channel} onChange={set("channel")}><option value="">Choose…</option>
            {(Object.keys(CHANNEL) as Channel[]).map((k) => <option key={k} value={k}>{CHANNEL[k]}</option>)}</select></div>
        <div className="fld"><label htmlFor="dp-received">Received on</label>
          <input id="dp-received" type="date" max={today} value={n.received_on} onChange={set("received_on")} aria-describedby="dp-received-h" />
          <p className="hint" id="dp-received-h">The deadline is one month from this date.</p></div>
      </div>
      <div className="two">
        <div className="fld"><label htmlFor="dp-requester">Name</label><input id="dp-requester" maxLength={120} value={n.requester} onChange={set("requester")} /></div>
        <div className="fld"><label htmlFor="dp-contact">Email or phone</label><input id="dp-contact" maxLength={200} value={n.contact} onChange={set("contact")} /></div>
        <div className="fld"><label htmlFor="dp-client">Borrower id, if a borrower</label>
          <input id="dp-client" maxLength={36} value={n.client_id} onChange={set("client_id")} aria-describedby="dp-client-h" />
          <p className="hint" id="dp-client-h">Copy it from Borrowers. Leave empty if they are not one.</p></div>
      </div>
      <div className="fld"><label htmlFor="dp-summary">What they asked for</label>
        <textarea id="dp-summary" rows={3} maxLength={2000} value={n.summary} onChange={set("summary")} /></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !ready} onClick={async () => {
          setBusy(true); setErr("");
          try { await onSave(n); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Logging…" : "Log request"}</button>
      </div>
    </section>
  );
}

function RetentionForm({ t, onCancel, onSave }: { t: Retention; onCancel: () => void; onSave: (t: Retention, reason: string) => Promise<void> }) {
  const [d, setD] = useState<Retention>(t);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: "data" | "where_kept" | "kept_for" | "basis" | "how_deleted") => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const id = (k: string) => `ret-${t.key}-${k}`;
  return (
    <div className="form">
      <div className="two">
        <div className="fld"><label htmlFor={id("data")}>Data</label><input id={id("data")} maxLength={200} value={d.data} onChange={set("data")} /></div>
        <div className="fld"><label htmlFor={id("where")}>Where it is kept</label><input id={id("where")} maxLength={200} value={d.where_kept} onChange={set("where_kept")} /></div>
        <div className="fld"><label htmlFor={id("kept")}>Kept for</label><input id={id("kept")} maxLength={200} value={d.kept_for} onChange={set("kept_for")} /></div>
      </div>
      <div className="two">
        <div className="fld"><label htmlFor={id("basis")}>Why</label><textarea id={id("basis")} rows={2} maxLength={400} value={d.basis} onChange={set("basis")} /></div>
        <div className="fld"><label htmlFor={id("how")}>How it is deleted</label><textarea id={id("how")} rows={2} maxLength={400} value={d.how_deleted} onChange={set("how_deleted")} /></div>
      </div>
      <div className="actions left">
        <label><input type="checkbox" checked={d.decided} onChange={(e) => setD({ ...d, decided: e.target.checked })} /> The period is decided</label>
        <label><input type="checkbox" checked={d.enforced} onChange={(e) => setD({ ...d, enforced: e.target.checked })} /> The system deletes it by itself</label>
      </div>
      <div className="fld"><label htmlFor={id("reason")}>Reason for this change</label>
        <textarea id={id("reason")} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || reason.trim().length < MIN} onClick={async () => {
          setBusy(true); setErr("");
          try { await onSave(d, reason.trim()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}
