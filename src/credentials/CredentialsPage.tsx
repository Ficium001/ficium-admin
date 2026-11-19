/**
 * Keys and tokens (both sites): every key and token this site depends on, where it is kept, who
 * owns it and when it must be replaced. Only names, places and dates are kept here; the values
 * stay in Doppler, Railway or GitHub secrets. 14 days before a date the Services page and the
 * Audit health banner turn amber, and red once it has passed.
 */
import { useEffect, useState } from "react";
import { SITE } from "../site";
import { load, save, retire, type Draft, type Entry, type Kind, type View } from "./api";

const MIN_REASON = 10;
export const KIND: Record<Kind, string> = {
  api_key: "API key", token: "Access token", signing_key: "Signing key", password: "Password or login",
  certificate: "Certificate", account: "Account or membership",
};
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtDay = (iso: string | null) => (iso ? DAY.format(new Date(`${iso}T00:00:00Z`)) : "—");

/** The "Replace by" cell: the date, and how urgent it is, in words. */
export function dueText(e: Entry): { text: string; pill: "" | "ok" | "warn" | "danger" } {
  const d = e.days_left;
  if (e.state === "no_date") return { text: "No date recorded", pill: "warn" };
  if (e.state === "expired") return { text: d === -1 ? "Expired yesterday" : `Expired ${-(d ?? 0)} days ago`, pill: "danger" };
  if (d === 0) return { text: "Due today", pill: "warn" };
  if (e.state === "due_soon") return { text: d === 1 ? "Due tomorrow" : `Due in ${d} days`, pill: "warn" };
  return { text: `${d} days left`, pill: "ok" };
}

/** One line for the top of the page: worst first. */
export function summary(items: Entry[]): { text: string; tone: "ok" | "warn" | "danger" } {
  const n = (s: Entry["state"]) => items.filter((e) => e.state === s).length;
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (n("expired")) return { text: `${plural(n("expired"), "key or token has", "keys or tokens have")} expired`, tone: "danger" };
  if (n("due_soon")) return { text: `${plural(n("due_soon"), "is", "are")} due within 14 days`, tone: "warn" };
  if (n("no_date")) return { text: `${plural(n("no_date"), "has", "have")} no date recorded, so no warning can be given for ${n("no_date") === 1 ? "it" : "them"}`, tone: "warn" };
  return { text: items.length ? "Every date is more than 14 days away" : "Nothing recorded yet", tone: items.length ? "ok" : "warn" };
}

const blank: Draft = { key: "", version: null, label: "", kind: "", purpose: "", env_names: "", stored_in: "", used_by: "", owner: "",
  expires_on: "", rotated_on: "", rotate_every_days: "", note: "", reason: "" };
export const draftOf = (e: Entry): Draft => ({
  key: e.key, version: e.version, label: e.label, kind: e.kind, purpose: e.purpose, env_names: e.env_names, stored_in: e.stored_in,
  used_by: e.used_by, owner: e.owner, expires_on: e.expires_on ?? "", rotated_on: e.rotated_on ?? "",
  rotate_every_days: e.rotate_every_days == null ? "" : String(e.rotate_every_days), note: e.note, reason: "",
});

export default function CredentialsPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Draft | null>(null);
  useEffect(() => { load().then(setView).catch((e) => setError((e as Error).message)); }, []);
  if (error && !view) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell wide"><p className="muted">Loading keys and tokens…</p></main>;
  const onSave = async (d: Draft) => { setView(await save(d)); setEditing(null); };
  const onRetire = async (e: Entry, reason: string) => { setView(await retire(e, reason)); setEditing(null); };
  return <CredentialsView view={view} editing={editing} onEdit={setEditing} onSave={onSave} onRetire={onRetire} />;
}

/** The page for a loaded state. No data access of its own, so it can be rendered and checked directly. */
export function CredentialsView({ view, editing, onEdit, onSave, onRetire }: {
  view: View; editing: Draft | null; onEdit: (d: Draft | null) => void;
  onSave: (d: Draft) => Promise<void>; onRetire: (e: Entry, reason: string) => Promise<void>;
}) {
  const top = summary(view.items);
  const scope = SITE === "portal" ? "this site and the bank portal" : "this site and the borrower app";
  const current = editing?.version != null ? view.items.find((e) => e.key === editing.key) ?? null : null;
  return (
    <main className="shell wide">
      <header className="top">
        <h1>Keys and tokens</h1>
        <p className="who">Signed in as {view.actor}</p>
      </header>
      <p className="lead">
        Every key and token {scope} depend on: what it is for, where it is kept, who owns it and when it must be replaced.
        Only names, places and dates are kept here. The keys themselves stay in Doppler, Railway or GitHub, and this page
        refuses anything that looks like one.
      </p>

      <section className={`status ${top.tone}`} role={top.tone === "danger" ? "alert" : "status"}>
        <p><strong>{top.text}.</strong> {top.tone !== "ok" && "Services and the Audit page show the same warning from 14 days before a date."}</p>
        {view.can_manage && !editing && (
          <div className="actions left">
            <button type="button" className="ghost" onClick={() => onEdit({ ...blank })}>Add a key or token</button>
          </div>
        )}
      </section>

      {editing && <Editor draft={editing} entry={current} today={view.today} onCancel={() => onEdit(null)} onSave={onSave} onRetire={onRetire} />}

      <table className="table">
        <caption className="sr-only">Keys and tokens, most urgent first</caption>
        <thead><tr>
          <th scope="col">Key or token</th><th scope="col">Replace by</th><th scope="col">Kept in</th>
          <th scope="col">Owner</th><th scope="col"><span className="sr-only">Edit</span></th>
        </tr></thead>
        <tbody>{view.items.map((e) => {
          const due = dueText(e);
          return (
            <tr key={e.key}>
              <th scope="row">
                {e.label}
                <br /><span className="muted">{KIND[e.kind]} · {e.purpose}</span>
                {e.env_names && <><br /><code>{e.env_names}</code></>}
                {e.note && <details><summary>Notes</summary><p>{e.note}</p></details>}
              </th>
              <td>
                {e.due_on && <>{fmtDay(e.due_on)}<br /></>}
                <span className={`pill ${due.pill}`}>{due.text}</span>
                <br /><span className="muted">{basis(e)}</span>
              </td>
              <td>{e.stored_in}<br /><span className="muted">Used by {e.used_by}</span></td>
              <td>{e.owner || <span className="muted">No owner</span>}</td>
              <td>{view.can_manage && (
                <button type="button" className="ghost" disabled={editing !== null} aria-label={`Edit ${e.label}`} onClick={() => onEdit(draftOf(e))}>Edit</button>
              )}</td>
            </tr>
          );
        })}</tbody>
      </table>
      {!view.can_manage && <p className="hint">You can see this register but not change it.</p>}

      {view.retired.length > 0 && (
        <details className="history">
          <summary>Retired ({view.retired.length})</summary>
          <ul>{view.retired.map((e) => <li key={e.key}>{e.label}, retired {fmtDay(e.retired_at?.slice(0, 10) ?? null)}{e.updated_by ? ` by ${e.updated_by}` : ""}</li>)}</ul>
        </details>
      )}
    </main>
  );
}

/** Where the date comes from, so nobody wonders why a key is due. */
function basis(e: Entry): string {
  const parts: string[] = [];
  if (e.expires_on) parts.push(`expires ${fmtDay(e.expires_on)}`);
  if (e.rotate_every_days) parts.push(e.rotated_on ? `rotate every ${e.rotate_every_days} days, last ${fmtDay(e.rotated_on)}` : `rotate every ${e.rotate_every_days} days, last rotation not recorded`);
  return parts.length ? parts.join("; ") : "No expiry or rotation recorded";
}

function Editor({ draft, entry, today, onCancel, onSave, onRetire }: {
  draft: Draft; entry: Entry | null; today: string; onCancel: () => void;
  onSave: (d: Draft) => Promise<void>; onRetire: (e: Entry, reason: string) => Promise<void>;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [retiring, setRetiring] = useState(false);
  const isNew = draft.version == null;
  const set = (k: keyof Draft) => (ev: { target: { value: string } }) => setD({ ...d, [k]: ev.target.value });
  const ready = d.label.trim() && d.kind && d.purpose.trim() && d.stored_in.trim() && d.used_by.trim()
    && (isNew ? /^[a-z][a-z0-9_]{2,59}$/.test(d.key) : true) && d.reason.trim().length >= MIN_REASON;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const id = (k: string) => `cred-${k}`;
  return (
    <section className="panel form" aria-labelledby={id("title")}>
      <h2 id={id("title")}>{isNew ? "Add a key or token" : `Edit ${draft.label}`}</h2>
      <p className="consequence">Record where it is kept and when it must be replaced. Never paste the key itself.</p>
      <div className="two">
        <div className="fld"><label htmlFor={id("label")}>Name</label>
          <input id={id("label")} value={d.label} maxLength={100} onChange={set("label")} /></div>
        {isNew && <div className="fld"><label htmlFor={id("key")}>Short name</label>
          <input id={id("key")} value={d.key} maxLength={60} onChange={set("key")} aria-describedby={id("key-h")} />
          <p className="hint" id={id("key-h")}>Lowercase letters, digits and _. It cannot be changed later.</p></div>}
        <div className="fld"><label htmlFor={id("kind")}>Kind</label>
          <select id={id("kind")} value={d.kind} onChange={set("kind")}>
            <option value="">Choose…</option>
            {(Object.keys(KIND) as Kind[]).map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
          </select></div>
        <div className="fld"><label htmlFor={id("owner")}>Owner</label>
          <input id={id("owner")} value={d.owner} maxLength={120} onChange={set("owner")} /></div>
      </div>
      <div className="fld"><label htmlFor={id("purpose")}>What it is for</label>
        <textarea id={id("purpose")} rows={2} value={d.purpose} maxLength={400} onChange={set("purpose")} /></div>
      <div className="two">
        <div className="fld"><label htmlFor={id("stored")}>Kept in</label>
          <input id={id("stored")} value={d.stored_in} maxLength={200} onChange={set("stored_in")} placeholder="Doppler, synced to Vercel (borrower app)" /></div>
        <div className="fld"><label htmlFor={id("used")}>Used by</label>
          <input id={id("used")} value={d.used_by} maxLength={200} onChange={set("used_by")} /></div>
      </div>
      <div className="fld"><label htmlFor={id("env")}>Setting names</label>
        <input id={id("env")} value={d.env_names} maxLength={300} onChange={set("env_names")} placeholder="GITHUB_TOKEN" /></div>
      <div className="two">
        <div className="fld"><label htmlFor={id("expires")}>Expires on</label>
          <input id={id("expires")} type="date" value={d.expires_on} onChange={set("expires_on")} aria-describedby={id("expires-h")} />
          <p className="hint" id={id("expires-h")}>The date the issuer stops accepting it. Empty if it never expires.</p></div>
        <div className="fld"><label htmlFor={id("rotated")}>Last replaced on</label>
          <input id={id("rotated")} type="date" value={d.rotated_on} max={today} onChange={set("rotated_on")} />
          <button type="button" className="ghost inline" onClick={() => setD({ ...d, rotated_on: today })}>Replaced today</button></div>
        <div className="fld"><label htmlFor={id("every")}>Replace every (days)</label>
          <input id={id("every")} type="number" inputMode="numeric" min={7} max={3650} value={d.rotate_every_days} onChange={set("rotate_every_days")} aria-describedby={id("every-h")} />
          <p className="hint" id={id("every-h")}>For keys that never expire. Empty if it has an expiry date only.</p></div>
      </div>
      <div className="fld"><label htmlFor={id("note")}>Notes</label>
        <textarea id={id("note")} rows={2} value={d.note} maxLength={1000} onChange={set("note")} /></div>
      <div className="fld"><label htmlFor={id("reason")}>Reason for this change</label>
        <textarea id={id("reason")} rows={2} value={d.reason} maxLength={2000} onChange={set("reason")} aria-describedby={id("reason-h")} />
        <p className="hint" id={id("reason-h")}>{d.reason.trim().length >= MIN_REASON ? "Saved in the audit log with your name." : `At least ${MIN_REASON} characters.`}</p></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        {entry && !retiring && <button type="button" className="ghost" disabled={busy} onClick={() => setRetiring(true)}>Retire…</button>}
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="primary" disabled={busy || !ready} onClick={() => run(() => onSave(d))}>
          {busy ? "Saving…" : isNew ? "Add" : "Save"}
        </button>
      </div>
      {entry && retiring && (
        <div className="confirm grave">
          <p className="consequence">Retire this entry when nothing uses it any more. It stops raising warnings and is kept in the record.</p>
          <p className="hint">Uses the reason above.</p>
          <div className="actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setRetiring(false)}>Keep it</button>
            <button type="button" className="primary destructive" disabled={busy || d.reason.trim().length < MIN_REASON} onClick={() => run(() => onRetire(entry, d.reason.trim()))}>Retire</button>
          </div>
        </div>
      )}
    </section>
  );
}
