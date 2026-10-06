import { useEffect, useState } from "react";
import { CHECKS, MIN_REASON } from "../api/_lib/checks";
import { load, change, type State } from "./api";

type Pending = { key: string; value: boolean };
const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const listOf = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!.toLowerCase()}`;
const nameOf = (key: string) => CHECKS.find((c) => c.key === key)?.name ?? key;

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => load().then((s) => { setState(s); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !state) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!state) return <main className="shell"><p className="muted">Loading KYC checks…</p></main>;
  if (!state.settings) return <main className="shell"><p className="fatal" role="alert">No KYC settings row found in the borrower database.</p></main>;

  const off = CHECKS.filter((c) => state.settings![c.key] === false);
  const criticalOff = off.filter((c) => c.critical);

  return (
    <main className="shell">
      <header className="top">
        <h1>KYC checks</h1>
        <p className="who">Signed in as {state.actor}</p>
      </header>

      <section className={`status ${criticalOff.length ? "danger" : off.length ? "warn" : "ok"}`} aria-live="polite">
        {criticalOff.length
          ? <p><strong>Identity is not fully verified.</strong> {listOf(criticalOff.map((c) => c.name))} {criticalOff.length === 1 ? "is" : "are"} off, so new borrowers can pass KYC without proving they are a real, unique person holding the ID.</p>
          : off.length
            ? <p><strong>{off.length} check{off.length > 1 ? "s are" : " is"} off.</strong> Identity checks are all on.</p>
            : <p><strong>All 10 checks are on.</strong></p>}
      </section>

      <ul className="board">
        {CHECKS.map((c) => {
          const on = state.settings![c.key] !== false;
          const open = pending?.key === c.key;
          return (
            <li key={c.key} className={`breaker ${on ? "on" : c.critical ? "off critical" : "off"}`}>
              <div className="row">
                <div className="text">
                  <h2>{c.name}{c.critical && <span className="tag">Identity</span>}</h2>
                  <p>{on ? c.confirms : <>Not checked: {c.confirms.charAt(0).toLowerCase() + c.confirms.slice(1)}</>}</p>
                </div>
                <button className={`switch ${on ? "is-on" : "is-off"}`} role="switch" aria-checked={on}
                  aria-label={`${c.name} is ${on ? "on" : "off"}`} disabled={!!pending && !open}
                  onClick={() => setPending(open ? null : { key: c.key, value: !on })}>
                  <span className="knob" /><span className="label">{on ? "On" : "Off"}</span>
                </button>
              </div>
              {open && <Confirm check={c} value={pending!.value} onCancel={() => setPending(null)}
                onSave={async (reason) => { await change(c.key, pending!.value, reason); setPending(null); await refresh(); }} />}
            </li>
          );
        })}
      </ul>

      <section className="history">
        <h2>Change history</h2>
        {state.history.length === 0
          ? <p className="muted">No changes recorded yet. Every change made here is logged with who made it and why.</p>
          : <ol>{state.history.map((h) => (
              <li key={h.id}>
                <p><strong>{nameOf(h.check_key)}</strong> turned {h.new_value ? "on" : "off"} by {h.actor}</p>
                <p className="reason">“{h.reason}”</p>
                <time dateTime={h.changed_at}>{fmt(h.changed_at)}</time>
              </li>))}
            </ol>}
      </section>
    </main>
  );
}

function Confirm({ check, value, onCancel, onSave }: {
  check: (typeof CHECKS)[number]; value: boolean; onCancel: () => void; onSave: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = reason.trim().length >= MIN_REASON;
  const verb = value ? "Turn on" : "Turn off";
  return (
    <form className={`confirm ${!value && check.critical ? "grave" : ""}`}
      onSubmit={async (e) => { e.preventDefault(); if (!ok) return; setBusy(true); setErr("");
        try { await onSave(reason.trim()); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
      {!value && <p className="consequence">From the moment you save, new verifications will no longer confirm that {check.confirms.charAt(0).toLowerCase() + check.confirms.slice(1, -1)}.</p>}
      <label htmlFor={`r-${check.key}`}>Why are you making this change?</label>
      <textarea id={`r-${check.key}`} rows={2} value={reason} autoFocus maxLength={500}
        onChange={(e) => setReason(e.target.value)} placeholder={value ? "e.g. Face matching service restored after outage" : "e.g. Face matching service down, ticket #123"} />
      <p className="hint">{ok ? "This reason is saved in the change history with your name." : `At least ${MIN_REASON} characters.`}</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={value ? "primary" : "primary destructive"} disabled={!ok || busy}>
          {busy ? "Saving…" : `${verb} ${check.name.toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}
