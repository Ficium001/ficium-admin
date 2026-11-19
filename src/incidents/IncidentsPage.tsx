/**
 * Incidents (both sites, under Monitoring): outages, security events, failed changes and supplier
 * failures, each with severity, an owner, a timeline, the root cause and follow-ups. When personal
 * data is involved, the 72-hour clock to tell the Data Protection Commissioner shows until the
 * report (or compliance's reason it is not needed) is recorded.
 */
import { useEffect, useState } from "react";
import { load, openIncident, act, type Action, type ActInput, type Incident, type Kind, type NewIncident, type View } from "./api";

export const KIND: Record<Kind, string> = {
  outage: "Outage", degraded: "Slow or partly broken", security: "Security event", data: "Data lost, exposed or wrong",
  third_party: "Supplier failure", change: "Failed change or deploy", other: "Other",
};
export const SEVERITY: Record<number, { text: string; help: string; pill: "" | "warn" | "danger" }> = {
  1: { text: "Severity 1", help: "Service down, or personal data exposed", pill: "danger" },
  2: { text: "Severity 2", help: "A major feature broken for many people", pill: "warn" },
  3: { text: "Severity 3", help: "Minor, or a few people affected", pill: "" },
};
export const STATUS: Record<Incident["status"], string> = { investigating: "Investigating", mitigated: "Harm stopped", resolved: "Resolved", closed: "Closed" };

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Indian/Mauritius" });
export const when = (iso: string | null) => (iso ? WHEN.format(new Date(iso)) : "—");
/** For <input type="datetime-local">: Mauritius local time, which is what staff type. */
const localNow = (now: string) => new Date(Date.parse(now) + 4 * 3_600_000).toISOString().slice(0, 16);
const fromLocal = (v: string) => (v ? new Date(`${v}:00+04:00`).toISOString() : "");

/** The breach clock in words, or null when none is running. */
export function breachClock(i: Incident, now: number): { text: string; pill: "warn" | "danger" } | null {
  if (!i.breach_due_at) return null;
  const h = Math.round((Date.parse(i.breach_due_at) - now) / 3_600_000);
  if (h < 0) return { text: `Commissioner not told: ${-h} h late`, pill: "danger" };
  return { text: `Tell the Commissioner within ${h} h`, pill: h <= 24 ? "danger" : "warn" };
}

export function summary(v: View): { text: string; tone: "ok" | "warn" | "danger" } {
  const now = Date.parse(v.now);
  const breaches = v.open.filter((i) => breachClock(i, now)).length;
  const major = v.open.filter((i) => i.severity <= 2).length;
  if (breaches) return { tone: "danger", text: `${breaches} incident${breaches === 1 ? " involves" : "s involve"} personal data the Commissioner has not been told about yet.` };
  if (v.open.some((i) => i.severity === 1)) return { tone: "danger", text: `${major} serious incident${major === 1 ? "" : "s"} open.` };
  if (major) return { tone: "warn", text: `${major} serious incident${major === 1 ? "" : "s"} open.` };
  if (v.open.length) return { tone: "ok", text: `${v.open.length} minor incident${v.open.length === 1 ? "" : "s"} open.` };
  return { tone: "ok", text: "No open incidents." };
}

/** "#incidents/new/deploy_borrower_app" opens the form for that Services row. */
export const prefillFrom = (hash: string) => /^#incidents\/new\/([a-z][a-z0-9_]{2,59})$/.exec(hash)?.[1] ?? null;

export default function IncidentsPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { load().then(setView).catch((e) => setError((e as Error).message)); }, []);
  if (error && !view) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell wide"><p className="muted">Loading incidents…</p></main>;
  return <IncidentsView view={view} onChange={setView} prefill={prefillFrom(window.location.hash)} />;
}

export function IncidentsView({ view, onChange, prefill = null, initiallyOpen = null }: {
  view: View; onChange: (v: View) => void; prefill?: string | null; initiallyOpen?: string | null;
}) {
  const [reporting, setReporting] = useState(prefill !== null && view.can_manage);
  const [openId, setOpenId] = useState<string | null>(initiallyOpen);
  const top = summary(view);
  const now = Date.parse(view.now);
  return (
    <main className="shell wide">
      <header className="top">
        <h1>Incidents</h1>
        <p className="who">Signed in as {view.actor}</p>
      </header>
      <p className="lead">
        Outages, security events, failed changes and supplier failures: what happened, who is on it, what fixed it, and what
        changes so it does not happen again. If personal data is involved, the Data Protection Commissioner must be told within
        72 hours of noticing, unless it is unlikely to put anyone at risk.
      </p>
      <section className={`status ${top.tone}`} role={top.tone === "danger" ? "alert" : "status"}>
        <p><strong>{top.text}</strong></p>
        {view.can_manage && !reporting && <div className="actions left">
          <button type="button" className="ghost" onClick={() => setReporting(true)}>Report an incident</button>
        </div>}
      </section>

      {reporting && <ReportForm now={view.now} service={prefill} onCancel={() => setReporting(false)}
        onSave={async (n) => { const v = await openIncident(n); onChange(v); setReporting(false); setOpenId(v.open.find((i) => i.title === n.title.trim())?.id ?? null); }} />}

      <h2 className="group">Open</h2>
      {view.open.length === 0
        ? <p className="muted">None.</p>
        : <ul className="cases">{view.open.map((i) => {
            const clock = breachClock(i, now);
            const panel = `inc-${i.id}`;
            const isOpen = openId === i.id;
            return (
              <li key={i.id} className="case">
                <button type="button" className="case-head" aria-expanded={isOpen} aria-controls={panel} onClick={() => setOpenId(isOpen ? null : i.id)}>
                  <span><strong>{i.ref}</strong> · {i.title}<br /><span className="muted">{KIND[i.kind]} · noticed {when(i.detected_at)}{i.owner ? ` · ${i.owner}` : ""}</span></span>
                  <span className="case-pills">
                    <span className={`pill ${SEVERITY[i.severity]!.pill}`}>{SEVERITY[i.severity]!.text}</span>
                    {clock && <span className={`pill ${clock.pill}`}>{clock.text}</span>}
                    <span className="pill">{STATUS[i.status]}</span>
                  </span>
                </button>
                <div id={panel} hidden={!isOpen} className="case-body">
                  <Detail i={i} />
                  {view.can_manage && isOpen && <Actions i={i} view={view} onChange={onChange} />}
                </div>
              </li>
            );
          })}</ul>}

      {view.closed.length > 0 && <>
        <h2 className="group">Closed</h2>
        <table className="table">
          <caption className="sr-only">Closed incidents, most recent first</caption>
          <thead><tr><th scope="col">Incident</th><th scope="col">Root cause</th><th scope="col">Duration</th></tr></thead>
          <tbody>{view.closed.map((i) => (
            <tr key={i.id}>
              <th scope="row">{i.ref} · {i.title}<br /><span className="muted">{SEVERITY[i.severity]!.text} · {KIND[i.kind]}{i.personal_data ? " · personal data" : ""}</span></th>
              <td>{i.root_cause}</td>
              <td>{duration(i.started_at, i.resolved_at)}<br /><span className="muted">closed {when(i.closed_at)}</span></td>
            </tr>
          ))}</tbody>
        </table>
      </>}
    </main>
  );
}

export function duration(from: string, to: string | null): string {
  if (!to) return "—";
  const m = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.round(m / 6) / 10} h`;
  return `${Math.round(m / 144) / 10} days`;
}

function Detail({ i }: { i: Incident }) {
  return (
    <>
      <p>{i.impact}</p>
      <p className="hint">
        Started {when(i.started_at)} · noticed {when(i.detected_at)}{i.mitigated_at ? ` · harm stopped ${when(i.mitigated_at)}` : ""}
        {i.resolved_at ? ` · resolved ${when(i.resolved_at)}` : ""}{i.service_key ? ` · service ${i.service_key}` : ""} · owner {i.owner ?? "nobody"}
      </p>
      {i.personal_data && (
        <p className="hint">
          Personal data involved. Commissioner: {i.breach_reported_at ? `told ${when(i.breach_reported_at)}` : i.breach_not_reported ? `not told (${i.breach_not_reported})` : `due by ${when(i.breach_due_at)}`}.
          {" "}People affected: {i.people_told_at ? `told ${when(i.people_told_at)}` : "not told yet"}.
        </p>
      )}
      {i.root_cause && <p><strong>Root cause:</strong> {i.root_cause}</p>}
      <ol className="timeline" aria-label="What happened">
        {i.events.map((e, n) => <li key={n}><time>{when(e.at)}</time> <span className="muted">{e.by}</span><br />{e.text}</li>)}
      </ol>
    </>
  );
}

type Form = { label: string; text?: string; min?: number; at?: string; severity?: boolean; followUp?: boolean; grave?: boolean; submit: string; note?: string };
const FORMS: Partial<Record<Action, Form>> = {
  update: { label: "Post an update", text: "What is happening", min: 1, submit: "Post update" },
  severity: { label: "Change severity", text: "Why", min: 10, severity: true, submit: "Change severity" },
  mitigated: { label: "Harm stopped", text: "What stopped the harm (a workaround, a rollback, a pause)", min: 10, submit: "Mark harm stopped" },
  resolved: { label: "Resolved", text: "What fixed it", min: 10, submit: "Mark resolved" },
  personal_data: { label: "Personal data involved", text: "What personal data, and whose", min: 10, submit: "Start the 72-hour clock",
    note: "From now the page and the Audit banner count down 72 hours from when the incident was noticed." },
  breach_reported: { label: "Reported to the Commissioner", text: "Reference, or how it was sent", min: 5, at: "When", submit: "Record the report" },
  breach_not_reported: { label: "Not reportable", text: "Why it is unlikely to put anyone at risk", min: 10, grave: true, submit: "Record the decision",
    note: "Only when the breach is unlikely to put anyone at risk. This decision is yours and is kept in the audit log." },
  people_told: { label: "People affected told", text: "How they were told", min: 5, at: "When", submit: "Record it" },
  root_cause: { label: "Root cause", text: "Why it happened, not only what broke", min: 10, submit: "Save root cause" },
  follow_up: { label: "Add a follow-up", text: "What must change", min: 5, followUp: true, submit: "Add follow-up" },
  close: { label: "Close", text: "Closing summary", min: 10, grave: true, submit: "Close incident",
    note: "Closing needs it resolved, a root cause, every follow-up done, and the personal data question answered. It cannot be reopened." },
};

function Actions({ i, view, onChange }: { i: Incident; view: View; onChange: (v: View) => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState("");
  const [at, setAt] = useState(localNow(view.now));
  const [severity, setSeverity] = useState<number>(i.severity);
  const [owner, setOwner] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (a: Action, input: ActInput) => {
    setBusy(true); setErr("");
    try { onChange(await act(i, a, input)); setAction(null); setText(""); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const choose = (a: Action) => { setErr(""); setText(""); if (FORMS[a]) setAction(a); else void run(a, {}); };
  const f = action ? FORMS[action]! : null;
  const openFollowUps = i.follow_ups.filter((x) => !x.done_at).length;
  const btn = (a: Action, label: string, show = true) => show && <button key={a} type="button" className="ghost" disabled={busy} onClick={() => choose(a)}>{label}</button>;
  return (
    <div className="case-actions">
      {i.follow_ups.length > 0 && <>
        <h3 className="group">Follow-ups</h3>
        <ul className="followups">{i.follow_ups.map((x) => (
          <li key={x.id}>
            <span>{x.done_at ? "✓ " : ""}{x.text}<br /><span className="muted">{x.owner || "No owner"}{x.due_on ? ` · due ${x.due_on}` : ""}{x.done_at ? ` · done ${when(x.done_at)} by ${x.done_by}` : ""}</span></span>
            {!x.done_at && <button type="button" className="ghost" disabled={busy} aria-label={`Mark done: ${x.text}`} onClick={() => run("follow_up_done", { follow_up: x.id })}>Done</button>}
          </li>
        ))}</ul>
      </>}
      {!f && <div className="actions left">
        {btn("update", "Post an update")}
        {btn("mitigated", "Harm stopped…", i.status === "investigating")}
        {btn("resolved", "Resolved…", i.status !== "resolved")}
        {btn("personal_data", "Personal data involved…", !i.personal_data)}
        {btn("breach_reported", "Reported to the Commissioner…", i.personal_data && !i.breach_reported_at)}
        {btn("breach_not_reported", "Not reportable…", i.personal_data && view.can_close && !i.breach_reported_at && !i.breach_not_reported)}
        {btn("people_told", "People affected told…", i.personal_data && !i.people_told_at)}
        {btn("root_cause", i.root_cause ? "Edit root cause…" : "Root cause…")}
        {btn("follow_up", "Add a follow-up…")}
        {btn("severity", "Change severity…")}
        {btn("take", "Take it over", !i.mine)}
        {btn("close", "Close…", view.can_close && i.status === "resolved")}
      </div>}
      {!f && i.status === "resolved" && view.can_close && (openFollowUps > 0 || !i.root_cause) && (
        <p className="hint">To close: {[!i.root_cause && "record the root cause", openFollowUps > 0 && `finish ${openFollowUps} follow-up${openFollowUps === 1 ? "" : "s"}`].filter(Boolean).join(" and ")}.</p>
      )}
      {f && action && (
        <div className={`confirm ${f.grave ? "grave" : ""}`}>
          <p className="consequence">{f.label}</p>
          {f.note && <p className="hint">{f.note}</p>}
          {f.severity && <div className="fld"><label htmlFor={`sev-${i.id}`}>New severity</label>
            <select id={`sev-${i.id}`} value={severity} onChange={(e) => setSeverity(Number(e.target.value))}>
              {[1, 2, 3].map((n) => <option key={n} value={n}>{SEVERITY[n]!.text}: {SEVERITY[n]!.help}</option>)}
            </select></div>}
          <label htmlFor={`txt-${i.id}`}>{f.text}</label>
          <textarea id={`txt-${i.id}`} rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          {f.at && <div className="fld"><label htmlFor={`at-${i.id}`}>{f.at} (Mauritius time)</label>
            <input id={`at-${i.id}`} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></div>}
          {f.followUp && <div className="two">
            <div className="fld"><label htmlFor={`own-${i.id}`}>Owner</label><input id={`own-${i.id}`} maxLength={120} value={owner} onChange={(e) => setOwner(e.target.value)} /></div>
            <div className="fld"><label htmlFor={`due-${i.id}`}>Due</label><input id={`due-${i.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>}
          <div className="actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
            <button type="button" className={f.grave ? "primary destructive" : "primary"} disabled={busy || text.trim().length < (f.min ?? 1)}
              onClick={() => run(action, { text, ...(f.at ? { at: fromLocal(at) } : {}), ...(f.severity ? { number: severity } : {}),
                ...(f.followUp ? { owner, date } : {}) })}>{busy ? "Saving…" : f.submit}</button>
          </div>
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </div>
  );
}

const blank = (now: string, service: string | null): NewIncident => ({
  title: "", severity: 2, kind: "", service_key: service ?? "", impact: "", started_at: localNow(now), detected_at: localNow(now), personal_data: false,
});

function ReportForm({ now, service, onCancel, onSave }: { now: string; service: string | null; onCancel: () => void; onSave: (n: NewIncident) => Promise<void> }) {
  const [n, setN] = useState<NewIncident>(blank(now, service));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: "title" | "kind" | "impact" | "started_at" | "detected_at") => (e: { target: { value: string } }) => setN({ ...n, [k]: e.target.value });
  const ready = n.title.trim().length >= 5 && n.kind && n.impact.trim().length >= 10 && n.started_at && n.detected_at && n.detected_at >= n.started_at;
  return (
    <section className="panel form" aria-labelledby="inc-new">
      <h2 id="inc-new">Report an incident</h2>
      {n.service_key && <p className="hint">From the Services row <strong>{n.service_key}</strong>.</p>}
      <div className="fld"><label htmlFor="inc-title">What is wrong</label>
        <input id="inc-title" maxLength={120} value={n.title} onChange={set("title")} placeholder="Borrower app deploys failing" /></div>
      <div className="two">
        <div className="fld"><label htmlFor="inc-sev">Severity</label>
          <select id="inc-sev" value={n.severity} onChange={(e) => setN({ ...n, severity: Number(e.target.value) })}>
            {[1, 2, 3].map((s) => <option key={s} value={s}>{SEVERITY[s]!.text}: {SEVERITY[s]!.help}</option>)}
          </select></div>
        <div className="fld"><label htmlFor="inc-kind">Kind</label>
          <select id="inc-kind" value={n.kind} onChange={set("kind")}><option value="">Choose…</option>
            {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}</select></div>
      </div>
      <div className="fld"><label htmlFor="inc-impact">Who or what is affected</label>
        <textarea id="inc-impact" rows={3} maxLength={2000} value={n.impact} onChange={set("impact")} /></div>
      <div className="two">
        <div className="fld"><label htmlFor="inc-start">Started (Mauritius time)</label>
          <input id="inc-start" type="datetime-local" value={n.started_at} onChange={set("started_at")} /></div>
        <div className="fld"><label htmlFor="inc-seen">Noticed (Mauritius time)</label>
          <input id="inc-seen" type="datetime-local" value={n.detected_at} onChange={set("detected_at")} aria-describedby="inc-seen-h" />
          <p className="hint" id="inc-seen-h">If personal data is involved, the 72 hours start here.</p></div>
      </div>
      <label className="check"><input type="checkbox" checked={n.personal_data} onChange={(e) => setN({ ...n, personal_data: e.target.checked })} />
        {" "}Personal data may have been lost, exposed, changed or made unavailable</label>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !ready} onClick={async () => {
          setBusy(true); setErr("");
          try { await onSave({ ...n, title: n.title.trim(), started_at: fromLocal(n.started_at), detected_at: fromLocal(n.detected_at) }); }
          catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? "Reporting…" : "Report incident"}</button>
      </div>
    </section>
  );
}
