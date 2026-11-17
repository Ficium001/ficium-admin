/**
 * API traffic (both sites): every call that comes in to the product and every call that goes out,
 * grouped by channel, with how each is doing over the last 24 hours and a way to stop one.
 *
 * Pausing is immediate (stopping traffic is the safe direction). Resuming is four-eyes: one admin
 * asks, a different admin approves. The admin channel itself can never be paused. The admin database
 * enforces all of that; this page only shows what the product is actually doing, and says plainly
 * when it has not heard about a change yet.
 */
import { useEffect, useState } from "react";
import { MIN_REASON } from "../../api/_lib/checks";
import { SITE } from "../site";
import { load, pause, askResume, decide, type Channel, type Loaded, type ResumeRequest, type View } from "./api";
import { failures, failRate, health, millis, num, percent } from "./health";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const PRODUCT = SITE === "portal" ? "bank portal" : "borrower app";

export default function ApiTrafficPage() {
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  const refresh = () => load().then((s) => { setState(s); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !state) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!state) return <main className="shell wide"><p className="muted">Loading API traffic…</p></main>;

  // A change answers with the fresh channels and requests; the live numbers are kept from the last full load.
  const apply = (next: View) => setState({
    ...state, ...next,
    channels: next.channels.map((c) => ({ ...c, stats: state.channels.find((o) => o.key === c.key)?.stats ?? null, applied: state.channels.find((o) => o.key === c.key)?.applied ?? null })),
  });
  return (
    <TrafficView state={state} onRefresh={refresh}
      onPause={async (c, reason) => { apply(await pause(c, reason)); refresh(); }}
      onAskResume={async (c, reason) => apply(await askResume(c, reason))}
      onDecide={async (op, r, note) => { apply(await decide(op, r, note)); if (op === "approve") refresh(); }} />
  );
}

/** The page for a loaded state. No data access of its own, so it can be rendered and checked directly. */
export function TrafficView({ state, onRefresh, onPause, onAskResume, onDecide }: {
  state: Loaded; onRefresh: () => void;
  onPause: (c: Channel, reason: string) => Promise<void>;
  onAskResume: (c: Channel, reason: string) => Promise<void>;
  onDecide: (op: "approve" | "reject" | "withdraw", r: ResumeRequest, note?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);   // one form at a time
  const withStats = state.channels.filter((c) => c.stats);
  const total = withStats.reduce((n, c) => n + c.stats!.total, 0);
  const failed = withStats.reduce((n, c) => n + failures(c.stats!), 0);
  const paused = state.channels.filter((c) => c.state === "paused").length;
  const closed = state.requests.filter((r) => r.status !== "pending");
  const groups: [string, string, Channel[]][] = [
    ["Coming in", `Calls made to the ${PRODUCT}`, state.channels.filter((c) => c.direction === "inbound")],
    ["Going out", `Calls the ${PRODUCT} makes to others`, state.channels.filter((c) => c.direction === "outbound")],
  ];

  return (
    <main className="shell wide">
      <header className="top">
        <h1>API traffic</h1>
        <p className="who">Signed in as {state.actor}</p>
      </header>
      <p className="lead">
        Every call that comes into the {PRODUCT} or goes out of it belongs to a channel. Here you can see how each
        channel did in the last {state.window_hours} hours and stop one if something is wrong. Pausing takes effect at once.
        Starting a paused channel again needs a second admin to approve. The admin channel can never be paused.
      </p>

      {state.telemetry_error && (
        <section className="status warn" role="status">
          <p><strong>Live numbers are missing.</strong> {state.telemetry_error}. Each channel’s state below is still correct.</p>
        </section>
      )}

      <section className="summary" aria-label="Summary">
        <div><strong>{num(total)}</strong><span>calls in 24 h</span></div>
        <div><strong>{total === 0 ? "—" : percent(failed / total)}</strong><span>failed (no answer or server error)</span></div>
        <div className={paused > 0 ? "alert" : ""}><strong>{paused}</strong><span>channel{paused === 1 ? "" : "s"} paused</span></div>
        <div><button type="button" className="ghost" onClick={onRefresh}>Refresh</button>
          <span>{state.generated_at ? `as of ${fmt(state.generated_at)}` : "no live numbers"}</span></div>
      </section>

      {groups.map(([title, sub, list]) => (
        <section key={title} aria-labelledby={`g-${title}`}>
          <h2 id={`g-${title}`} className="group">{title} <span className="muted">· {sub}</span></h2>
          {list.length === 0 ? <p className="muted">None.</p> : (
            <ul className="board">
              {list.map((c) => (
                <ChannelRow key={c.key} c={c}
                  pending={state.requests.find((r) => r.channel_key === c.key && r.status === "pending")}
                  canControl={state.can_control} canApprove={state.can_approve}
                  open={open === c.key} otherOpen={open !== null && open !== c.key} onOpen={(on) => setOpen(on ? c.key : null)}
                  onPause={async (reason) => { await onPause(c, reason); setOpen(null); }}
                  onAskResume={async (reason) => { await onAskResume(c, reason); setOpen(null); }}
                  onDecide={onDecide} />
              ))}
            </ul>
          )}
        </section>
      ))}

      <section className="history">
        <h2>Past resume requests</h2>
        {closed.length === 0
          ? <p className="muted">None yet. Every pause and every resume is kept in the audit log with who did it and why.</p>
          : <ol>{closed.map((r) => (
              <li key={r.id}>
                <p><strong>{state.channels.find((c) => c.key === r.channel_key)?.label ?? r.channel_key}</strong>: {r.status}{r.checker ? ` by ${r.checker}` : ""} · asked by {r.maker}</p>
                <p className="reason">“{r.reason}”</p>
                {r.decision_note && <p className="muted">{r.decision_note}</p>}
                <time dateTime={r.decided_at ?? r.created_at}>{fmt(r.decided_at ?? r.created_at)}</time>
              </li>))}
            </ol>}
      </section>
    </main>
  );
}

function Bars({ total, errors }: { total: number[]; errors: number[] }) {
  const max = Math.max(1, ...total);
  const sum = total.reduce((a, b) => a + b, 0);
  return (
    <svg className="spark" viewBox="0 0 96 28" role="img" aria-label={`Calls per hour for the last 24 hours, ${num(sum)} in total`}>
      {total.map((t, i) => {
        const h = t === 0 ? 1 : Math.max(2, (t / max) * 26), e = errors[i] ?? 0, eh = t === 0 ? 0 : Math.min(h, Math.max(e > 0 ? 2 : 0, (e / t) * h));
        return (
          <g key={i}>
            <rect x={i * 4} y={27 - h} width="3" height={h} className="bar" />
            {eh > 0 && <rect x={i * 4} y={27 - eh} width="3" height={eh} className="bar err" />}
          </g>
        );
      })}
    </svg>
  );
}

function ChannelRow({ c, pending, canControl, canApprove, open, otherOpen, onOpen, onPause, onAskResume, onDecide }: {
  c: Channel; pending: ResumeRequest | undefined; canControl: boolean; canApprove: boolean;
  open: boolean; otherOpen: boolean; onOpen: (on: boolean) => void;
  onPause: (reason: string) => Promise<void>; onAskResume: (reason: string) => Promise<void>;
  onDecide: (op: "approve" | "reject" | "withdraw", r: ResumeRequest, note?: string) => Promise<void>;
}) {
  const h = health(c), s = c.stats;
  return (
    <li className={`chan ${c.state === "paused" ? "off" : ""}`}>
      <div className="row">
        <div className="text">
          <h3>{c.label} <span className="tag">{c.peer}</span> {!c.pausable && <span className="tag">cannot be paused</span>}</h3>
          <p>{c.description}</p>
        </div>
        <span className={`pill ${h.pill}`}>{h.text}</span>
      </div>

      {s && s.total > 0 ? (
        <div className="figures">
          <dl>
            <div><dt>Calls</dt><dd>{num(s.total)}</dd></div>
            <div><dt>Failed</dt><dd className={failRate(s) >= 0.02 ? "bad" : ""}>{num(failures(s))} <span className="muted">({percent(failRate(s))})</span></dd></div>
            <div><dt>Refused (4xx)</dt><dd>{num(s.client_errors)}</dd></div>
            <div><dt>Held by a pause</dt><dd>{num(s.blocked)}</dd></div>
            <div><dt>Typical / slowest 5%</dt><dd>{millis(s.p50_ms)} / {millis(s.p95_ms)}</dd></div>
          </dl>
          <Bars total={s.hourly_total} errors={s.hourly_errors} />
        </div>
      ) : <p className="muted figures-none">{s ? "No calls in the last 24 hours." : "No numbers for this channel."}</p>}

      {s?.last_error && <p className="lasterr"><strong>Last failure{s.last_error_at ? ` (${fmt(s.last_error_at)})` : ""}:</strong> {s.last_error}</p>}

      {c.state === "paused" && (
        <p className="consequence">Paused{c.updated_by ? ` by ${c.updated_by}` : ""} on {fmt(c.updated_at)}{c.state_reason ? `: “${c.state_reason}”` : ""}</p>
      )}
      {!c.pausable && c.lock_reason && <p className="hint">{c.lock_reason}</p>}

      {pending && <Waiting req={pending} canApprove={canApprove} onDecide={(op, note) => onDecide(op, pending, note)} />}

      {c.pausable && !pending && !open && (
        <div className="actions left">
          {c.state === "enabled"
            ? <button type="button" className="ghost" disabled={!canControl || otherOpen} onClick={() => onOpen(true)}>Pause…</button>
            : <button type="button" className="ghost" disabled={!canControl || otherOpen} onClick={() => onOpen(true)}>Ask to resume…</button>}
          {!canControl && <p className="hint">You can see this page but not change channels.</p>}
        </div>
      )}
      {c.pausable && !pending && open && (
        <Reason grave={c.state === "enabled"} id={c.key}
          consequence={c.state === "enabled"
            ? `Stops this channel now. ${c.description} A second admin must approve starting it again.`
            : "A second admin must approve before traffic flows again."}
          label={c.state === "enabled" ? "Why are you pausing it?" : "Why is it safe to resume?"}
          placeholder={c.state === "enabled" ? "e.g. the provider key may be exposed; stop calls until it is rotated" : "e.g. key rotated and checked in the sandbox"}
          submit={c.state === "enabled" ? "Pause now" : "Ask for approval"}
          onCancel={() => onOpen(false)} onSave={c.state === "enabled" ? onPause : onAskResume} />
      )}
    </li>
  );
}

function Reason({ id, grave, consequence, label, placeholder, submit, onCancel, onSave }: {
  id: string; grave: boolean; consequence: string; label: string; placeholder: string; submit: string;
  onCancel: () => void; onSave: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = reason.trim().length >= MIN_REASON;
  return (
    <form className={`confirm ${grave ? "grave" : ""}`}
      onSubmit={async (e) => { e.preventDefault(); if (!ok) return; setBusy(true); setErr("");
        try { await onSave(reason.trim()); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
      <p className="consequence">{consequence}</p>
      <label htmlFor={`why-${id}`}>{label}</label>
      <textarea id={`why-${id}`} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={placeholder} />
      <p className="hint">{ok ? "This reason is saved in the audit log with your name." : `At least ${MIN_REASON} characters.`}</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={grave ? "primary destructive" : "primary"} disabled={!ok || busy}>{busy ? "Saving…" : submit}</button>
      </div>
    </form>
  );
}

function Waiting({ req, canApprove, onDecide }: {
  req: ResumeRequest; canApprove: boolean; onDecide: (op: "approve" | "reject" | "withdraw", note?: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (op: "approve" | "reject" | "withdraw") => {
    setBusy(true); setErr("");
    try { await onDecide(op, note.trim() || undefined); setBusy(false); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const decider = canApprove && !req.mine;
  return (
    <div className="confirm" role="group" aria-label="Request to resume this channel">
      <p className="consequence">{req.mine ? "You asked" : `${req.maker} asked`} to resume this channel. Traffic stays stopped until a different admin approves.</p>
      <p className="reason">“{req.reason}”</p>
      <p className="hint">Asked {fmt(req.created_at)} · expires {fmt(req.expires_at)}</p>
      {decider && <>
        <label htmlFor={`n-${req.id}`}>Note (required to reject)</label>
        <textarea id={`n-${req.id}`} rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </>}
      {!decider && !req.mine && <p className="hint">Only an admin with approval rights who didn't ask can decide.</p>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        {req.mine && <button type="button" className="ghost" disabled={busy} onClick={() => act("withdraw")}>Withdraw request</button>}
        {decider && <>
          <button type="button" className="ghost" disabled={busy || note.trim().length < MIN_REASON} onClick={() => act("reject")}>Reject</button>
          <button type="button" className="primary" disabled={busy} onClick={() => act("approve")}>{busy ? "Saving…" : "Approve: resume traffic"}</button>
        </>}
      </div>
    </div>
  );
}
