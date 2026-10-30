import { useEffect, useState } from "react";
import { apiFetch } from "../auth/client";
import { SITE } from "../site";

type AdminEvent = { chain_pos: number; occurred_at: string; actor_type: string; action: string; resource_type: string;
  resource_id: string | null; reason: string | null; source_ip: string | null };
type PortalEvent = { id: string; occurred_at: string; actor_type: string; actor_email: string | null; actor_role: string | null;
  institution_name: string | null; action: string; resource_label: string | null; outcome: string; outcome_note: string | null };
type Source = "admin" | "portal";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });

async function fetchEvents(source: Source, before: string, prefix: string) {
  const qs = new URLSearchParams({ source, ...(before && { before }), ...(prefix && { action_prefix: prefix }) });
  const r = await apiFetch(`/api/audit?${qs}`);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error ?? `Request failed (${r.status})`);
  return b.events as (AdminEvent | PortalEvent)[];
}

type Health = { healthy: boolean; alerts: string[]; at: string;
  outbox: { pending: number; dead: number; oldest_pending_s: number | null; last_dispatched_at: string | null } | null;
  chain: { ok: boolean; mode: string; checked: number; head_pos: number | null; head_hash: string | null; checked_at: string } | null };

function HealthBanner() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    apiFetch("/api/audit?source=health").then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? `Health check failed (${r.status})`);
      setH(b.health as Health);
    }).catch((x) => setErr(x.message));
  }, []);
  if (err) return <section className="status warn" role="status"><p><strong>System health is unavailable.</strong> {err}</p></section>;
  if (!h) return null;
  return (
    <section className={`status ${h.healthy ? "ok" : "danger"}`} role={h.healthy ? "status" : "alert"}>
      {h.healthy
        ? <p><strong>Audit log verified.</strong> {h.chain ? `${h.chain.head_pos ?? 0} entries, last checked ${fmt(h.chain.checked_at)}.` : ""}
            {h.outbox ? ` Sync: ${h.outbox.pending} waiting, none failed.` : ""}</p>
        : <><p><strong>Needs attention.</strong></p><ul>{h.alerts.map((a) => <li key={a}>{a}</li>)}</ul></>}
    </section>
  );
}

export default function AuditPage() {
  const [source, setSource] = useState<Source>(SITE === "portal" ? "portal" : "admin");
  const [prefix, setPrefix] = useState("");
  const [events, setEvents] = useState<(AdminEvent | PortalEvent)[] | null>(null);
  const [error, setError] = useState("");
  const [more, setMore] = useState(true);

  const loadFirst = () => { setEvents(null); setError("");
    fetchEvents(source, "", prefix).then((e) => { setEvents(e); setMore(e.length === 100); }).catch((x) => setError(x.message)); };
  useEffect(loadFirst, [source]);

  const loadMore = () => {
    if (!events?.length) return;
    const last = events[events.length - 1]!;
    const before = source === "admin" ? String((last as AdminEvent).chain_pos) : last.occurred_at;
    fetchEvents(source, before, prefix).then((e) => { setEvents([...events, ...e]); setMore(e.length === 100); }).catch((x) => setError(x.message));
  };

  return (
    <main className="shell">
      <header className="top"><h1>Audit log</h1></header>
      <p className="lead muted">Read-only. Entries cannot be edited or deleted.</p>
      <HealthBanner />
      {SITE === "portal" && (
        <nav className="sections" aria-label="Audit source">
          <a href="#audit" aria-current={source === "portal" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setSource("portal"); }}>Portal (banks)</a>
          <a href="#audit" aria-current={source === "admin" ? "page" : undefined} onClick={(e) => { e.preventDefault(); setSource("admin"); }}>Admin site</a>
        </nav>
      )}
      {source === "portal" && (
        <form className="actions left" onSubmit={(e) => { e.preventDefault(); loadFirst(); }}>
          <label htmlFor="pfx" className="hint">Action starts with</label>
          <input id="pfx" value={prefix} placeholder="e.g. compliance." maxLength={64} onChange={(e) => setPrefix(e.target.value.toLowerCase())} />
          <button className="ghost" type="submit">Filter</button>
        </form>
      )}
      {error && <p className="err" role="alert">{error}</p>}
      {!events ? !error && <p className="muted">Loading…</p> : events.length === 0 ? <p className="muted empty">No entries.</p> : (
        <section className="history">
          <ol>{events.map((e) => source === "admin" ? <AdminRow key={(e as AdminEvent).chain_pos} e={e as AdminEvent} /> : <PortalRow key={(e as PortalEvent).id} e={e as PortalEvent} />)}</ol>
          {more && <div className="actions left"><button className="ghost" onClick={loadMore}>Older entries</button></div>}
        </section>
      )}
    </main>
  );
}

function AdminRow({ e }: { e: AdminEvent }) {
  return (
    <li>
      <p><strong>{e.action}</strong> · {e.resource_type}{e.resource_id ? ` ${e.resource_id}` : ""} · {e.actor_type}</p>
      {e.reason && <p className="reason">“{e.reason}”</p>}
      <time dateTime={e.occurred_at}>#{e.chain_pos} · {fmt(e.occurred_at)}{e.source_ip ? ` · ${e.source_ip}` : ""}</time>
    </li>
  );
}

function PortalRow({ e }: { e: PortalEvent }) {
  return (
    <li>
      <p><strong>{e.action}</strong> · {e.outcome}{e.institution_name ? ` · ${e.institution_name}` : ""}{e.resource_label ? ` · ${e.resource_label}` : ""}</p>
      <p className="muted">{e.actor_email ?? e.actor_type}{e.actor_role ? ` (${e.actor_role})` : ""}</p>
      {e.outcome_note && <p className="reason">“{e.outcome_note}”</p>}
      <time dateTime={e.occurred_at}>{fmt(e.occurred_at)}</time>
    </li>
  );
}
