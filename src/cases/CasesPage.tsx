/**
 * Complaints and cases (app site, under Customers): every complaint, problem, question or piece of
 * feedback from a borrower, with deadlines from Ficium's own targets, an owner and a timeline.
 * Complaints are decided by compliance (upheld or not, with redress) and feed the complaints
 * register a bank's risk review will ask for.
 */
import { useEffect, useState } from "react";
import { load, openCase, act, saveTarget, type Action, type Case, type Category, type Channel, type Kind, type NewCase, type Target, type Upheld, type View } from "./api";

export const KIND: Record<Kind, string> = { complaint: "Complaint", problem: "Problem", question: "Question", feedback: "Feedback" };
export const CATEGORY: Record<Category, string> = {
  kyc: "Identity checks", request: "Their request", bids: "Bids", deal: "Deal after acceptance", account: "Account and sign-in",
  app: "The app", fees: "Fees", privacy: "Privacy", conduct: "A bank's or staff conduct", other: "Other",
};
export const CHANNEL: Record<Channel, string> = { email: "Email", app: "In the app", phone: "Phone", letter: "Letter", in_person: "In person", social: "Social media", other: "Other" };
export const UPHELD: Record<Upheld, string> = { upheld: "Upheld", partly: "Partly upheld", not_upheld: "Not upheld" };

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Indian/Mauritius" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const when = (iso: string | null) => (iso ? WHEN.format(new Date(iso)) : "—");
export const day = (iso: string | null) => (iso ? DAY.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—");
const localNow = (now: string) => new Date(Date.parse(now) + 4 * 3_600_000).toISOString().slice(0, 16);
const fromLocal = (v: string) => (v ? new Date(`${v}:00+04:00`).toISOString() : "");
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export function deadline(c: Case): { text: string; pill: "" | "ok" | "warn" | "danger" } {
  if (c.ack_overdue) return { text: "Not acknowledged in time", pill: "danger" };
  const d = c.days_left;
  if (d == null) return { text: c.on_time ? "Answered on time" : "Answered late", pill: c.on_time ? "ok" : "warn" };
  if (d < 0) return { text: `Answer overdue by ${-d} day${d === -1 ? "" : "s"}`, pill: "danger" };
  if (d === 0) return { text: "Answer due today", pill: "danger" };
  if (d <= 3) return { text: `Answer due in ${d} day${d === 1 ? "" : "s"}`, pill: "warn" };
  return { text: `Answer due in ${d} days`, pill: "ok" };
}

export function summary(v: View): { text: string; tone: "ok" | "warn" | "danger" } {
  const late = v.open.filter((c) => c.ack_overdue || (c.days_left ?? 1) < 0).length;
  const soon = v.open.filter((c) => !c.ack_overdue && c.days_left != null && c.days_left >= 0 && c.days_left <= 3).length;
  const complaints = v.open.filter((c) => c.kind === "complaint").length;
  const of = complaints ? ` ${complaints} of the open cases ${complaints === 1 ? "is a complaint" : "are complaints"}.` : "";
  if (late) return { tone: "danger", text: `${late} case${late === 1 ? " has" : "s have"} missed a deadline.${of}` };
  if (soon) return { tone: "warn", text: `${soon} case${soon === 1 ? " is" : "s are"} due within 3 days.${of}` };
  if (v.open.length) return { tone: "ok", text: `${v.open.length} open, none close to a deadline.${of}` };
  return { tone: "ok", text: "No open cases." };
}

export default function CasesPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then(setView).catch((e) => setError((e as Error).message)); }, []);
  if (error && !view) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell wide"><p className="muted">Loading cases…</p></main>;
  return <CasesView view={view} onChange={setView} />;
}

export function CasesView({ view, onChange, initiallyOpen = null }: { view: View; onChange: (v: View) => void; initiallyOpen?: string | null }) {
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initiallyOpen);
  const [editing, setEditing] = useState<Kind | null>(null);
  const top = summary(view);
  const reg = view.complaints_12m;
  return (
    <main className="shell wide">
      <header className="top">
        <h1>Complaints and cases</h1>
        <p className="who">Signed in as {view.actor}</p>
      </header>
      <p className="lead">
        Every complaint, problem, question or piece of feedback from a borrower, with an owner, a deadline and a record of what
        was done. Log each one the day it arrives. Complaints are decided by compliance: upheld or not, and what was put right.
      </p>
      <section className={`status ${top.tone}`} role={top.tone === "danger" ? "alert" : "status"}>
        <p><strong>{top.text}</strong></p>
        {view.can_manage && !adding && <div className="actions left">
          <button type="button" className="ghost" onClick={() => setAdding(true)}>Open a case</button>
        </div>}
      </section>

      {adding && <OpenForm now={view.now} onCancel={() => setAdding(false)}
        onSave={async (n) => { const v = await openCase(n); onChange(v); setAdding(false); setOpenId(v.open.find((c) => c.subject === n.subject.trim())?.id ?? null); }} />}

      <h2 className="group">Open</h2>
      {view.open.length === 0 ? <p className="muted">None.</p>
        : <ul className="cases">{view.open.map((c) => (
            <CaseItem key={c.id} c={c} view={view} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} onChange={onChange} />
          ))}</ul>}

      <h2 className="group">Complaints in the last 12 months</h2>
      {reg.received === 0 ? <p className="muted">None received.</p> : <>
        <dl className="stat-row">
          <div><dt>Received</dt><dd><strong>{reg.received}</strong><span className="muted">{reg.received - reg.resolved} still open</span></dd></div>
          <div><dt>Answered on time</dt><dd><strong>{pct(reg.on_time, reg.resolved)}</strong><span className="muted">{reg.on_time} of {reg.resolved} answered</span></dd></div>
          <div><dt>Upheld</dt><dd><strong>{pct(reg.upheld + reg.partly, reg.resolved)}</strong><span className="muted">{reg.upheld} fully, {reg.partly} partly, {reg.not_upheld} not</span></dd></div>
          <div><dt>Taken further</dt><dd><strong>{reg.referred}</strong><span className="muted">referred to a regulator or ombudsman</span></dd></div>
        </dl>
        <table className="table">
          <caption className="sr-only">Complaints by what they were about</caption>
          <thead><tr><th scope="col">About</th><th scope="col" className="num">Complaints</th></tr></thead>
          <tbody>{(Object.entries(reg.by_category) as [Category, number][]).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
            <tr key={k}><th scope="row">{CATEGORY[k] ?? k}</th><td className="num">{n}</td></tr>
          ))}</tbody>
        </table>
      </>}

      {view.closed.length > 0 && <>
        <h2 className="group">Answered</h2>
        <ul className="cases">{view.closed.map((c) => (
          <CaseItem key={c.id} c={c} view={view} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} onChange={onChange} />
        ))}</ul>
      </>}

      <h2 className="group">Targets</h2>
      <p className="hint">Ficium's own targets, copied onto each case when it is opened: changing one never moves an existing deadline. If Ficium is licensed, set them to the regulator's complaint rules.</p>
      <table className="table">
        <caption className="sr-only">Response targets by kind of case</caption>
        <thead><tr><th scope="col">Kind</th><th scope="col">Acknowledge within</th><th scope="col">Answer within</th><th scope="col"><span className="sr-only">Edit</span></th></tr></thead>
        <tbody>{view.targets.map((t) => editing === t.kind
          ? <tr key={t.kind}><td colSpan={4}><TargetForm t={t} onCancel={() => setEditing(null)}
              onSave={async (a, d, r) => { onChange(await saveTarget(t, a, d, r)); setEditing(null); }} /></td></tr>
          : <tr key={t.kind}>
              <th scope="row">{KIND[t.kind]}</th><td>{t.ack_hours} hours</td><td>{t.resolve_days} days</td>
              <td>{view.can_manage && <button type="button" className="ghost" disabled={editing !== null} aria-label={`Edit targets for ${KIND[t.kind]}`} onClick={() => setEditing(t.kind)}>Edit</button>}</td>
            </tr>)}</tbody>
      </table>
    </main>
  );
}

function CaseItem({ c, view, open, onToggle, onChange }: { c: Case; view: View; open: boolean; onToggle: () => void; onChange: (v: View) => void }) {
  const due = deadline(c);
  const panel = `case-${c.id}`;
  return (
    <li className="case">
      <button type="button" className="case-head" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <span><strong>{c.ref}</strong> · {c.subject}<br /><span className="muted">{CATEGORY[c.category]} · {c.requester} · {CHANNEL[c.channel]} · received {when(c.received_at)}</span></span>
        <span className="case-pills">
          <span className={`pill ${c.kind === "complaint" ? "warn" : ""}`}>{KIND[c.kind]}</span>
          {c.upheld && <span className="pill">{UPHELD[c.upheld]}</span>}
          <span className={`pill ${due.pill}`}>{due.text}</span>
        </span>
      </button>
      <div id={panel} hidden={!open} className="case-body">
        <p>{c.detail}</p>
        <p className="hint">Contact: {c.contact}{c.client_id ? ` · Borrower ${c.client_id}` : ""} · Owner: {c.owner ?? "nobody"} ·
          {" "}acknowledge by {when(c.ack_due_at)}{c.acknowledged_at ? ` (done ${when(c.acknowledged_at)})` : ""} · answer by {day(c.resolve_due_on)}</p>
        {c.outcome && <p><strong>Answer:</strong> {c.outcome}{c.redress ? ` Redress: ${c.redress}` : ""}</p>}
        {c.referred_to && <p className="hint">Referred to {c.referred_to} on {when(c.referred_at)}.</p>}
        <ol className="timeline" aria-label="What was done">
          {c.events.map((e, n) => <li key={n}><time>{when(e.at)}</time> <span className="muted">{e.by}</span><br />{e.text}</li>)}
        </ol>
        {view.can_manage && open && <Actions c={c} view={view} onChange={onChange} />}
      </div>
    </li>
  );
}

type Form = { label: string; text: string; min: number; decide?: boolean; at?: boolean; grave?: boolean; submit: string };
const FORMS: Partial<Record<Action, Form>> = {
  note: { label: "Add a note", text: "Note", min: 1, submit: "Add note" },
  acknowledge: { label: "Acknowledge", text: "How it was acknowledged, and what the person was told", min: 5, submit: "Acknowledge" },
  resolve: { label: "Answer", text: "The answer given", min: 10, decide: true, submit: "Record the answer" },
  withdraw: { label: "Withdrawn", text: "How the person withdrew it", min: 10, submit: "Mark withdrawn" },
  reopen: { label: "Reopen", text: "Why it is reopened", min: 10, submit: "Reopen" },
  referred: { label: "Referred onwards", text: "To whom (a regulator, an ombudsman, a court)", min: 3, at: true, submit: "Record the referral" },
};

function Actions({ c, view, onChange }: { c: Case; view: View; onChange: (v: View) => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState("");
  const [upheld, setUpheld] = useState<Upheld | "">("");
  const [redress, setRedress] = useState("");
  const [at, setAt] = useState(localNow(view.now));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const closed = c.resolved_at !== null;
  const complaint = c.kind === "complaint";
  const canDecide = !complaint || view.can_resolve_complaint;
  const run = async (a: Action, input: Record<string, string> = {}) => {
    setBusy(true); setErr("");
    try { onChange(await act(c, a, input)); setAction(null); setText(""); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const choose = (a: Action) => { setErr(""); setText(""); if (FORMS[a]) setAction(a); else void run(a); };
  const f = action ? FORMS[action]! : null;
  const ready = f && text.trim().length >= f.min && (!f.decide || !complaint || (upheld && (upheld === "not_upheld" || redress.trim())));
  const btn = (a: Action, label: string, show = true) => show && <button key={a} type="button" className="ghost" disabled={busy} onClick={() => choose(a)}>{label}</button>;
  return (
    <div className="case-actions">
      {!f && <div className="actions left">
        {btn("acknowledge", "Acknowledge…", !closed && !c.acknowledged_at)}
        {btn("resolve", "Record the answer…", !closed && canDecide)}
        {btn("note", "Add a note")}
        {btn("take", "Take it over", !closed && !c.mine)}
        {btn("withdraw", "Withdrawn…", !closed)}
        {btn("reopen", "Reopen…", closed)}
        {btn("referred", "Referred onwards…", complaint && !c.referred_to)}
      </div>}
      {!f && !closed && complaint && !view.can_resolve_complaint && <p className="hint">Only compliance can decide a complaint.</p>}
      {f && action && (
        <div className={`confirm ${f.grave ? "grave" : ""}`}>
          <p className="consequence">{f.label}</p>
          <label htmlFor={`ct-${c.id}`}>{f.text}</label>
          <textarea id={`ct-${c.id}`} rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          {f.decide && complaint && <div className="two">
            <div className="fld"><label htmlFor={`up-${c.id}`}>Decision</label>
              <select id={`up-${c.id}`} value={upheld} onChange={(e) => setUpheld(e.target.value as Upheld | "")}>
                <option value="">Choose…</option>{(Object.keys(UPHELD) as Upheld[]).map((u) => <option key={u} value={u}>{UPHELD[u]}</option>)}
              </select></div>
            <div className="fld"><label htmlFor={`rd-${c.id}`}>What was put right</label>
              <input id={`rd-${c.id}`} maxLength={1000} value={redress} onChange={(e) => setRedress(e.target.value)} aria-describedby={`rd-h-${c.id}`} />
              <p className="hint" id={`rd-h-${c.id}`}>Required when upheld. An apology counts: say so.</p></div>
          </div>}
          {f.at && <div className="fld"><label htmlFor={`at-${c.id}`}>When (Mauritius time)</label>
            <input id={`at-${c.id}`} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></div>}
          <div className="actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
            <button type="button" className="primary" disabled={busy || !ready} onClick={() => run(action, {
              text, ...(f.decide && complaint ? { upheld, redress } : {}), ...(f.at ? { at: fromLocal(at) } : {}) })}>{busy ? "Saving…" : f.submit}</button>
          </div>
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </div>
  );
}

const blank = (now: string): NewCase => ({ kind: "", category: "", subject: "", detail: "", requester: "", contact: "", client_id: "", channel: "", received_at: localNow(now) });

function OpenForm({ now, onCancel, onSave }: { now: string; onCancel: () => void; onSave: (n: NewCase) => Promise<void> }) {
  const [n, setN] = useState<NewCase>(blank(now));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof NewCase) => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  const ready = n.kind && n.category && n.channel && n.subject.trim().length >= 5 && n.detail.trim().length >= 10 && n.requester.trim() && n.contact.trim() && n.received_at;
  return (
    <section className="panel form" aria-labelledby="case-new">
      <h2 id="case-new">Open a case</h2>
      <div className="two">
        <div className="fld"><label htmlFor="cs-kind">Kind</label>
          <select id="cs-kind" value={n.kind} onChange={set("kind")}><option value="">Choose…</option>
            {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></div>
        <div className="fld"><label htmlFor="cs-cat">About</label>
          <select id="cs-cat" value={n.category} onChange={set("category")}><option value="">Choose…</option>
            {(Object.keys(CATEGORY) as Category[]).map((k) => <option key={k} value={k}>{CATEGORY[k]}</option>)}</select></div>
        <div className="fld"><label htmlFor="cs-ch">Arrived by</label>
          <select id="cs-ch" value={n.channel} onChange={set("channel")}><option value="">Choose…</option>
            {(Object.keys(CHANNEL) as Channel[]).map((k) => <option key={k} value={k}>{CHANNEL[k]}</option>)}</select></div>
        <div className="fld"><label htmlFor="cs-at">Received (Mauritius time)</label>
          <input id="cs-at" type="datetime-local" value={n.received_at} onChange={set("received_at")} /></div>
      </div>
      <div className="fld"><label htmlFor="cs-sub">Subject</label><input id="cs-sub" maxLength={120} value={n.subject} onChange={set("subject")} /></div>
      <div className="fld"><label htmlFor="cs-det">What they said</label><textarea id="cs-det" rows={3} maxLength={4000} value={n.detail} onChange={set("detail")} /></div>
      <div className="two">
        <div className="fld"><label htmlFor="cs-name">Name</label><input id="cs-name" maxLength={120} value={n.requester} onChange={set("requester")} /></div>
        <div className="fld"><label htmlFor="cs-contact">Email or phone</label><input id="cs-contact" maxLength={200} value={n.contact} onChange={set("contact")} /></div>
        <div className="fld"><label htmlFor="cs-client">Borrower id, if a borrower</label><input id="cs-client" maxLength={36} value={n.client_id} onChange={set("client_id")} /></div>
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !ready} onClick={async () => {
          setBusy(true); setErr("");
          try { await onSave({ ...n, received_at: fromLocal(n.received_at) }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Opening…" : "Open case"}</button>
      </div>
    </section>
  );
}

function TargetForm({ t, onCancel, onSave }: { t: Target; onCancel: () => void; onSave: (ack: number, days: number, reason: string) => Promise<void> }) {
  const [ack, setAck] = useState(String(t.ack_hours));
  const [days, setDays] = useState(String(t.resolve_days));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="form">
      <div className="two">
        <div className="fld"><label htmlFor={`ta-${t.kind}`}>Acknowledge within (hours)</label>
          <input id={`ta-${t.kind}`} type="number" inputMode="numeric" min={1} max={720} value={ack} onChange={(e) => setAck(e.target.value)} /></div>
        <div className="fld"><label htmlFor={`td-${t.kind}`}>Answer within (days)</label>
          <input id={`td-${t.kind}`} type="number" inputMode="numeric" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></div>
      </div>
      <div className="fld"><label htmlFor={`tr-${t.kind}`}>Reason for this change</label>
        <textarea id={`tr-${t.kind}`} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || reason.trim().length < 10} onClick={async () => {
          setBusy(true); setErr("");
          try { await onSave(Number(ack), Number(days), reason.trim()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save targets"}</button>
      </div>
    </div>
  );
}
