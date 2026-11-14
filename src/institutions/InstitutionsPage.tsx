import { useEffect, useState } from "react";
import { claims } from "../auth/client";
import { load, ask, approve, reject, withdraw, type View, type Institution, type ChangeRequest, type Module } from "./api";
import ChangeTable from "../shared/ChangeTable";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" });
const describe = (r: ChangeRequest) =>
  r.op === "institution.invite_admin" ? `Invite a first admin to ${r.target_label}`
  : r.op === "institution.approve" ? `Approve ${r.target_label}`
  : r.op === "institution.suspend" ? `Suspend ${r.target_label}`
  : `${r.target_label} → ${String(r.args.status)} (${String(r.args.plan_tier ?? "standard")})${r.args.valid_to ? ` until ${day(String(r.args.valid_to))}` : ""}`;

export default function InstitutionsPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const me = claims()?.email?.toLowerCase() ?? "";
  const refresh = () => load().then((v) => { setView(v); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !view) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell"><p className="muted">Loading banks…</p></main>;

  const pending = view.requests.filter((r) => r.status === "pending");
  const decided = view.requests.filter((r) => r.status !== "pending").slice(0, 30);
  const waitingFor = (key: string) => pending.some((r) => r.target_key === key || r.target_key.startsWith(`${key}:`));

  return (
    <main className="shell">
      <header className="top"><h1>Banks</h1><p className="who">Signed in as {me}</p></header>
      <p className="lead muted">Every change here needs a second admin to approve it before it reaches the portal.</p>
      {notice && <p className="hint" role="status">{notice}</p>}

      {pending.length > 0 && (
        <section className="history">
          <h2>Waiting for a second approver</h2>
          <ul className="board">{pending.map((r) => <Pending key={r.id} r={r} mine={r.maker_email.toLowerCase() === me} onDone={(msg) => { setNotice(msg ?? ""); refresh(); }} />)}</ul>
        </section>
      )}

      <section className="history">
        <h2>All banks</h2>
        {view.institutions.length === 0 ? <p className="muted empty">No banks yet.</p> : (
          <ul className="board">
            {view.institutions.map((i) => (
              <li key={i.institution_id} className={`breaker ${i.approved ? "on" : "off"}`}>
                <button className="row-btn" aria-expanded={open === i.institution_id} onClick={() => setOpen(open === i.institution_id ? null : i.institution_id)}>
                  <span className="text">
                    <strong>{i.name}</strong>
                    <span className="muted"> · {i.onboarding_stage} · {i.active_members} active user{i.active_members === 1 ? "" : "s"} · {i.entitlements.filter((e) => e.status === "active" || e.status === "trial").length} module(s)</span>
                  </span>
                  <span aria-hidden>{open === i.institution_id ? "−" : "+"}</span>
                </button>
                {open === i.institution_id && <Detail inst={i} catalog={view.catalog} busy={waitingFor(i.institution_id)} onDone={refresh} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="history">
        <h2>Decisions</h2>
        {decided.length === 0 ? <p className="muted">None yet. Every request and decision is logged with who made it and why.</p> : (
          <ol>{decided.map((r) => (
            <li key={r.id}>
              <p><strong>{describe(r)}</strong>: {r.status}{r.checker_email ? ` by ${r.checker_email}` : ""} (asked by {r.maker_email})</p>
              <p className="reason">“{r.decision_note ?? r.reason}”</p>
              <ChangeTable r={r} decided />
              {r.decided_at && <time dateTime={r.decided_at}>{fmt(r.decided_at)}</time>}
            </li>))}
          </ol>
        )}
      </section>
    </main>
  );
}

function Pending({ r, mine, onDone }: { r: ChangeRequest; mine: boolean; onDone: (msg?: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); } };
  return (
    <li className="breaker on">
      <div className="text">
        <h2>{describe(r)}</h2>
        <p>Asked by {r.maker_email} · {fmt(r.created_at)}</p>
        <p className="reason">“{r.reason}”</p>
        <ChangeTable r={r} />
      </div>
      <div className="confirm">
        {mine ? <p className="hint">You asked for this, so someone else must approve it.</p> : <>
          <label htmlFor={`n-${r.id}`}>Note (required to reject)</label>
          <textarea id={`n-${r.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions">
          {mine ? <button className="ghost" disabled={busy} onClick={() => run(() => withdraw(r))}>Withdraw</button> : <>
            <button className="ghost" disabled={busy || note.trim().length < 10} onClick={() => run(() => reject(r, note.trim()))}>Reject</button>
            <button className={r.op === "institution.suspend" ? "primary destructive" : "primary"} disabled={busy} onClick={async () => {
              setBusy(true); setErr("");
              try {
                const out = await approve(r, note.trim());
                const i = out.invite;
                onDone(!i ? undefined : "error" in i ? `Created, but the invitation was not sent: ${i.error}`
                  : i.email_sent ? "Invitation emailed to the new admin." : "Created, but the email did not leave. Ask again to re-send.");
              } catch (e) { setErr((e as Error).message); setBusy(false); }
            }}>
              {busy ? "Working…" : "Approve and apply"}
            </button>
          </>}
        </div>
      </div>
    </li>
  );
}

function Detail({ inst, catalog, busy, onDone }: { inst: Institution; catalog: Module[]; busy: boolean; onDone: () => void }) {
  const [form, setForm] = useState<null | "approve" | "suspend" | "module" | "admin">(null);
  return (
    <div className="confirm">
      <p>{inst.legal_name} · {inst.institution_type} · {inst.country}{inst.primary_contact_email ? ` · ${inst.primary_contact_name ?? ""} <${inst.primary_contact_email}>` : ""}</p>
      {inst.suspension_reason && <p className="consequence">Suspended: “{inst.suspension_reason}”</p>}
      <ul className="board">
        {catalog.map((m) => {
          const e = inst.entitlements.find((x) => x.module_code === m.module_code);
          return <li key={m.module_code} className="breaker on"><div className="text"><h2>{m.name}<span className="tag">{m.module_code}</span></h2>
            <p>{e ? `${e.status} · ${e.plan_tier}${e.valid_to ? ` · until ${day(e.valid_to)}` : ""}` : "Not granted"}</p></div></li>;
        })}
      </ul>
      {busy ? <p className="hint">A change for this bank is waiting for approval.</p>
        : form ? <Ask kind={form} inst={inst} catalog={catalog} onCancel={() => setForm(null)} onDone={onDone} />
        : <div className="actions left">
            {!inst.approved && <button className="ghost" onClick={() => setForm("approve")}>Ask to approve</button>}
            {inst.onboarding_stage !== "suspended" && <button className="ghost" onClick={() => setForm("suspend")}>Ask to suspend</button>}
            <button className="ghost" onClick={() => setForm("module")}>Change a module</button>
            {inst.active_members === 0 && <button className="ghost" onClick={() => setForm("admin")}>Invite a first admin</button>}
          </div>}
    </div>
  );
}

function Ask({ kind, inst, catalog, onCancel, onDone }: { kind: "approve" | "suspend" | "module" | "admin"; inst: Institution; catalog: Module[]; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState(catalog[0]?.module_code ?? "");
  const [status, setStatus] = useState("active");
  const [tier, setTier] = useState("standard");
  const [until, setUntil] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const op = kind === "approve" ? "institution.approve" : kind === "suspend" ? "institution.suspend"
    : kind === "admin" ? "institution.invite_admin" : "entitlement.set";
  return (
    <form className={`confirm ${kind === "suspend" ? "grave" : ""}`} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try {
        await ask({ op, institution_id: inst.institution_id, institution_name: inst.name, reason: reason.trim(),
          ...(kind === "module" && { module_code: code, status, plan_tier: tier, valid_to: until ? `${until}T23:59:59Z` : undefined }),
          ...(kind === "admin" && { email: email.trim(), full_name: fullName.trim() }) });
        onDone();
      } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      {kind === "suspend" && <p className="consequence">Once approved, {inst.name} can no longer use the portal or bid.</p>}
      {kind === "admin" && <>
        <p className="consequence">{inst.name} has no active users. Once approved, this person becomes its administrator and is emailed a link to set a password; they then invite their own team.</p>
        <label htmlFor="a-email">Their work email</label>
        <input id="a-email" type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="a-name">Their full name</label>
        <input id="a-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </>}
      {kind === "module" && <>
        <label htmlFor="m-code">Module</label>
        <select id="m-code" value={code} onChange={(e) => setCode(e.target.value)}>{catalog.map((m) => <option key={m.module_code} value={m.module_code}>{m.name}</option>)}</select>
        <label htmlFor="m-status">Status</label>
        <select id="m-status" value={status} onChange={(e) => setStatus(e.target.value)}>{["active", "trial", "suspended", "expired"].map((s) => <option key={s}>{s}</option>)}</select>
        <label htmlFor="m-tier">Plan</label>
        <select id="m-tier" value={tier} onChange={(e) => setTier(e.target.value)}>{["trial", "standard", "professional", "enterprise"].map((s) => <option key={s}>{s}</option>)}</select>
        <label htmlFor="m-until">Until (optional)</label>
        <input id="m-until" type="date" value={until} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
      </>}
      <label htmlFor="a-reason">Why?</label>
      <textarea id="a-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="hint">A second admin must approve this before it takes effect.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || reason.trim().length < 10 || (kind === "admin" && (!email.includes("@") || fullName.trim().length < 2))}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </form>
  );
}
