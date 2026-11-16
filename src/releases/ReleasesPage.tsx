/**
 * App releases (app site): which phone app versions may still run, and how
 * many borrowers are on each one.
 *
 * Every change is four-eyes: this page files a request, a different admin
 * approves it, and only then does it reach the apps. The admin database
 * enforces that; the page only shows what a change would do before it is asked.
 */
import { useEffect, useState } from "react";
import { MIN_REASON } from "../../api/_lib/checks";
import ChangeTable from "../shared/ChangeTable";
import { load, request, decide, type Loaded, type Platform, type Policy, type Request, type State, type Terms, type Usage } from "./api";
import { blockedBy, compareVersions, isVersion, statusOf, type VersionStatus } from "./versions";

const NAME: Record<Platform, string> = { ios: "iPhone (App Store)", android: "Android (Google Play)" };
const STORE: Record<Platform, string> = { ios: "App Store", android: "Google Play" };
const LINK_EXAMPLE: Record<Platform, string> = {
  ios: "https://apps.apple.com/app/id1234567890",
  android: "https://play.google.com/store/apps/details?id=net.ficium.app",
};
const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const people = (n: number) => `${n.toLocaleString("en-GB")} borrower${n === 1 ? "" : "s"}`;

const KIND: Record<string, string> = { error: "Uncaught error", rejection: "Failed background task", render: "Screen failed to draw" };

const STATUS_LABEL: Record<VersionStatus, { text: string; pill: string }> = {
  blocked: { text: "Blocked: must update", pill: "danger" },
  supported: { text: "Allowed", pill: "" },
  latest: { text: "Latest", pill: "ok" },
  ahead: { text: "Newer than recorded", pill: "warn" },
};

/** What raising (or lowering) the minimum does to people, in one sentence. Null when the minimum does not move. */
function impact(platform: Platform, from: string, to: string, usage: Usage | null): string | null {
  if (!isVersion(to) || compareVersions(to, from) === 0) return null;
  if (compareVersions(to, from) < 0) return `Versions from ${to} up will be allowed to run again.`;
  if (!usage) return `Everyone on a version older than ${to} will be blocked until they update. Usage numbers are unavailable, so how many is unknown.`;
  const { blocked, active } = blockedBy(to, platform, usage.versions);
  if (active === 0) return `Everyone on a version older than ${to} will be blocked until they update. No one has used this app in the last 30 days.`;
  return `This blocks ${people(blocked)} of the ${active.toLocaleString("en-GB")} active on ${STORE[platform]} in the last 30 days, until they update to ${to} or newer.`;
}

const termsRows = (before: Terms, after: Terms) => [
  { field: "Latest version in the store", before: before.latest_version, after: after.latest_version },
  { field: "Minimum version allowed", before: before.min_version, after: after.min_version },
  { field: "Store link", before: before.store_url || "Not set", after: after.store_url || "Not set" },
];

export default function ReleasesPage() {
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  const refresh = () => load().then((s) => { setState(s); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !state) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!state) return <main className="shell"><p className="muted">Loading app releases…</p></main>;

  // A change answers with the fresh policy and requests; usage is kept from the last full load.
  const apply = (next: State) => setState({ ...state, ...next });
  return (
    <ReleasesView state={state}
      onRequest={async (platform, terms, reason) => apply(await request(platform, terms, reason))}
      onDecide={async (op, r, note) => { apply(await decide(op, r, note)); if (op === "approve") refresh(); }} />
  );
}

/** The page for a loaded state. No data access of its own, so it can be rendered and checked directly. */
export function ReleasesView({ state, onRequest, onDecide, initialEditing = null }: {
  state: Loaded;
  onRequest: (platform: Platform, terms: Terms, reason: string) => Promise<void>;
  onDecide: (op: "approve" | "reject" | "withdraw", r: Request, note?: string) => Promise<void>;
  initialEditing?: Platform | null;
}) {
  const [editing, setEditing] = useState<Platform | null>(initialEditing);
  const closed = state.requests.filter((r) => r.status !== "pending");

  return (
    <main className="shell">
      <header className="top">
        <h1>App releases</h1>
        <p className="who">Signed in as {state.actor}</p>
      </header>
      <p className="lead">
        The phone apps carry their screens inside the installed app, so older versions stay in use after a new one
        ships. Record here which version is live in each store, and set the lowest version allowed to run. Anything
        older shows “Update Ficium to continue” and cannot be used until it is updated.
      </p>

      {state.usage_error && (
        <section className="status warn" role="status">
          <p><strong>Usage numbers are missing.</strong> {state.usage_error}. The policy below is still correct.</p>
        </section>
      )}

      {state.policy.map((p) => {
        const pending = state.requests.find((r) => r.platform === p.platform && r.status === "pending");
        return (
          <PlatformPanel key={p.platform} policy={p} usage={state.usage} pending={pending}
            canRequest={state.can_request} canApprove={state.can_approve}
            editing={editing === p.platform} lockedOut={editing !== null && editing !== p.platform}
            onEdit={(on) => setEditing(on ? p.platform : null)}
            onRequest={async (terms, reason) => { await onRequest(p.platform, terms, reason); setEditing(null); }}
            onDecide={onDecide} />
        );
      })}

      <section className="history">
        <h2>Past requests</h2>
        {closed.length === 0
          ? <p className="muted">None yet. Every request and decision made here is kept, with who made it and why.</p>
          : <ol>{closed.map((r) => (
              <li key={r.id}>
                <p><strong>{NAME[r.platform]}</strong>: {r.status}{r.checker ? ` by ${r.checker}` : ""} · asked by {r.maker}</p>
                <ChangeTable r={{ change: { rows: termsRows(r.before, r) } }} decided hint={null} />
                <p className="reason">“{r.reason}”</p>
                {r.decision_note && <p className="muted">{r.decision_note}</p>}
                <time dateTime={r.decided_at ?? r.created_at}>{fmt(r.decided_at ?? r.created_at)}</time>
              </li>))}
            </ol>}
      </section>
    </main>
  );
}

function PlatformPanel({ policy, usage, pending, canRequest, canApprove, editing, lockedOut, onEdit, onRequest, onDecide }: {
  policy: Policy; usage: Usage | null; pending: Request | undefined; canRequest: boolean; canApprove: boolean;
  editing: boolean; lockedOut: boolean; onEdit: (on: boolean) => void;
  onRequest: (terms: Terms, reason: string) => Promise<void>;
  onDecide: (op: "approve" | "reject" | "withdraw", r: Request, note?: string) => Promise<void>;
}) {
  const platform = policy.platform;
  const rows = (usage?.versions ?? []).filter((u) => u.platform === platform);
  const inApp = usage?.policy.find((x) => x.platform === platform)?.version;
  const delivered = inApp === undefined ? null : inApp >= policy.version;
  const errors = (usage?.errors ?? []).filter((e) => e.platform === platform);
  const total7 = rows.reduce((n, u) => n + u.active_7d, 0), total30 = rows.reduce((n, u) => n + u.active_30d, 0);
  const { blocked } = blockedBy(policy.min_version, platform, rows);

  return (
    <section className="panel" aria-labelledby={`rel-${platform}`}>
      <div className="meta">
        <h2 id={`rel-${platform}`}>{NAME[platform]}</h2>
        {delivered === null
          ? <span className="pill">Delivery to the apps unknown</span>
          : delivered
            ? <span className="pill ok">In force in the apps</span>
            : <span className="pill warn">Approved, not yet delivered to the apps (retried hourly)</span>}
      </div>

      <table className="table">
        <tbody>
          <tr><th scope="row">Latest version in the store</th><td>{policy.latest_version}</td></tr>
          <tr><th scope="row">Minimum version allowed</th><td>{policy.min_version}</td></tr>
          <tr><th scope="row">Store link</th><td>{policy.store_url
            ? <a href={policy.store_url} target="_blank" rel="noreferrer noopener">{policy.store_url}</a>
            : <span className="muted">Not set: the update screen shows no button, only “find it in your app store”</span>}</td></tr>
          <tr><th scope="row">Last changed</th><td>{policy.version === 0
            ? <span className="muted">Never (starting values)</span>
            : <>{fmt(policy.updated_at)}{policy.updated_by ? `, approved by ${policy.updated_by}` : ""}</>}</td></tr>
        </tbody>
      </table>

      <h3 className="sr-only">Versions in use</h3>
      {usage === null
        ? <p className="muted">Versions in use: unavailable.</p>
        : rows.length === 0
          ? <p className="muted">No borrower has used this app in the last 30 days.</p>
          : <>
              <table className="table">
                <caption className="sr-only">Borrowers by app version, {NAME[platform]}</caption>
                <thead><tr><th scope="col">Version in use</th><th scope="col" className="num">Active, 7 days</th><th scope="col" className="num">Active, 30 days</th><th scope="col">Under this policy</th></tr></thead>
                <tbody>{rows.map((u) => {
                  const s = STATUS_LABEL[statusOf(u.app_version, policy)];
                  return (
                    <tr key={u.app_version}>
                      <th scope="row">{u.app_version}</th>
                      <td className="num">{u.active_7d.toLocaleString("en-GB")}</td>
                      <td className="num">{u.active_30d.toLocaleString("en-GB")}</td>
                      <td><span className={`pill ${s.pill}`}>{s.text}</span></td>
                    </tr>
                  );
                })}</tbody>
                <tfoot><tr><th scope="row">All versions</th><th className="num">{total7.toLocaleString("en-GB")}</th><th className="num">{total30.toLocaleString("en-GB")}</th><th>{blocked > 0 ? `${people(blocked)} blocked now` : "No one blocked"}</th></tr></tfoot>
              </table>
              <p className="hint">Signed-in borrowers only, counted once each by the version they last used. As of {fmt(usage.generated_at)}.</p>
            </>}

      {usage !== null && (errors.length === 0
        ? <p className="muted">No errors reported by this app in the last 7 days.</p>
        : <>
            <table className="table">
              <caption className="sr-only">Errors reported by the app in the last 7 days, {NAME[platform]}</caption>
              <thead><tr><th scope="col">Error in the last 7 days</th><th scope="col">Version</th><th scope="col" className="num">Borrowers</th><th scope="col" className="num">Times</th><th scope="col">Last seen</th></tr></thead>
              <tbody>{errors.map((e) => (
                <tr key={`${e.app_version}-${e.fingerprint}`}>
                  <th scope="row">
                    {e.message}
                    <br /><span className="muted">{KIND[e.kind] ?? e.kind}{e.route ? ` · on ${e.route}` : ""}{e.location ? ` · ${e.location}` : ""}</span>
                  </th>
                  <td>{e.app_version}{statusOf(e.app_version, policy) === "blocked" ? " (blocked)" : ""}</td>
                  <td className="num">{e.borrowers_7d.toLocaleString("en-GB")}</td>
                  <td className="num">{e.occurrences_7d.toLocaleString("en-GB")}</td>
                  <td>{e.last_seen_at ? fmt(e.last_seen_at) : "—"}</td>
                </tr>))}
              </tbody>
            </table>
            <p className="hint">Most widespread first. Reported by signed-in apps, with emails, tokens, ids and long numbers removed. Crashes in the native shell appear in the store consoles, not here.</p>
          </>)}

      {pending && <Waiting req={pending} usage={usage} canApprove={canApprove} onDecide={(op, note) => onDecide(op, pending, note)} />}

      {!pending && !editing && (
        <div className="actions left">
          <button type="button" className="ghost" disabled={!canRequest || lockedOut} onClick={() => onEdit(true)}>Change…</button>
          {!canRequest && <p className="hint">You can see this page but not ask for changes.</p>}
        </div>
      )}
      {!pending && editing && <Ask policy={policy} usage={usage} onCancel={() => onEdit(false)} onSave={onRequest} />}
    </section>
  );
}

function Ask({ policy, usage, onCancel, onSave }: {
  policy: Policy; usage: Usage | null; onCancel: () => void; onSave: (terms: Terms, reason: string) => Promise<void>;
}) {
  const platform = policy.platform;
  const [latest, setLatest] = useState(policy.latest_version);
  const [min, setMin] = useState(policy.min_version);
  const [url, setUrl] = useState(policy.store_url);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const l = latest.trim(), m = min.trim(), u = url.trim();
  const formatOk = isVersion(l) && isVersion(m);
  const tooHigh = formatOk && compareVersions(m, l) > 0;
  const changed = l !== policy.latest_version || m !== policy.min_version || u !== policy.store_url;
  const ok = formatOk && !tooHigh && changed && reason.trim().length >= MIN_REASON;
  const effect = formatOk && !tooHigh ? impact(platform, policy.min_version, m, usage) : null;
  const raises = formatOk && compareVersions(m, policy.min_version) > 0;

  return (
    <form className={`confirm ${raises ? "grave" : ""}`}
      onSubmit={async (e) => { e.preventDefault(); if (!ok) return; setBusy(true); setErr("");
        try { await onSave({ latest_version: l, min_version: m, store_url: u }, reason.trim()); } catch (x) { setErr((x as Error).message); setBusy(false); } }}>
      <div className="two">
        <div className="fld">
          <label htmlFor={`latest-${platform}`}>Latest version in the store</label>
          <input id={`latest-${platform}`} value={latest} inputMode="decimal" autoComplete="off" maxLength={17}
            onChange={(e) => setLatest(e.target.value)} aria-describedby={`latest-h-${platform}`} />
          <p className="hint" id={`latest-h-${platform}`}>Change this only once that version is public on {STORE[platform]}.</p>
        </div>
        <div className="fld">
          <label htmlFor={`min-${platform}`}>Minimum version allowed</label>
          <input id={`min-${platform}`} value={min} inputMode="decimal" autoComplete="off" maxLength={17}
            onChange={(e) => setMin(e.target.value)} aria-describedby={`min-h-${platform}`} aria-invalid={tooHigh || undefined} />
          <p className="hint" id={`min-h-${platform}`}>Older versions stop working until updated.</p>
        </div>
      </div>
      <div className="fld">
        <label htmlFor={`url-${platform}`}>Store link (where “Update now” goes)</label>
        <input id={`url-${platform}`} value={url} type="url" autoComplete="off" maxLength={300} placeholder={LINK_EXAMPLE[platform]}
          onChange={(e) => setUrl(e.target.value)} />
      </div>

      {!formatOk && <p className="err" role="alert">Versions must look like 1.4.2.</p>}
      {tooHigh && <p className="err" role="alert">The minimum cannot be higher than the latest version in the store: people would be told to update to something they cannot get.</p>}
      {effect && <p className="consequence">{effect}</p>}
      <p className="consequence">A second admin must approve this before anything changes in the apps.</p>

      <label htmlFor={`why-${platform}`}>Why are you making this change?</label>
      <textarea id={`why-${platform}`} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. 1.2.0 is live in the store; 1.1.x has the session bug fixed in 1.2.0" />
      <p className="hint">{reason.trim().length >= MIN_REASON ? "This reason is saved in the history with your name." : `At least ${MIN_REASON} characters.`}</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={raises ? "primary destructive" : "primary"} disabled={!ok || busy}>
          {busy ? "Saving…" : "Ask for approval"}
        </button>
      </div>
    </form>
  );
}

function Waiting({ req, usage, canApprove, onDecide }: {
  req: Request; usage: Usage | null; canApprove: boolean;
  onDecide: (op: "approve" | "reject" | "withdraw", note?: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (op: "approve" | "reject" | "withdraw") => {
    setBusy(true); setErr("");
    try { await onDecide(op, note.trim() || undefined); setBusy(false); } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  const decider = canApprove && !req.mine;
  const raises = compareVersions(req.min_version, req.before.min_version) > 0;
  const effect = impact(req.platform, req.before.min_version, req.min_version, usage);
  return (
    <div className={`confirm ${raises ? "grave" : ""}`} role="group" aria-label={`Requested change for ${NAME[req.platform]}`}>
      <p className="consequence">{req.mine ? "You asked" : `${req.maker} asked`} for this change. Nothing changes in the apps until a different admin approves.</p>
      <ChangeTable r={{ change: { rows: termsRows(req.before, req) } }} hint={null} />
      {effect && <p className="consequence">{effect}</p>}
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
          <button type="button" className={raises ? "primary destructive" : "primary"} disabled={busy} onClick={() => act("approve")}>
            {busy ? "Saving…" : "Approve change"}
          </button>
        </>}
      </div>
    </div>
  );
}
