import { useEffect, useState } from "react";
import { claims } from "../auth/client";
import ChangeTable from "../shared/ChangeTable";
import {
  load, review, askProvision, approveProvision, rejectProvision, withdrawProvision, resendInvite,
  type View, type Application, type ProvisionRequest, type Status, type Invite,
} from "./api";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const LABEL: Record<Status, string> = {
  submitted: "New", in_review: "In review", info_requested: "Waiting for information",
  approved: "Approved, awaiting contract", rejected: "Rejected", provisioned: "Provisioned",
};
const TYPE: Record<string, string> = {
  commercial_bank: "Commercial bank", fintech: "Fintech", micro_credit: "Micro-credit", leasing: "Leasing",
  insurance: "Insurance", cooperative: "Cooperative", other: "Other",
};
const inviteText = (i: Invite) => ("error" in i ? `The invitation was not sent: ${i.error}`
  : i.email_sent ? "Invitation emailed to the new admin." : "The login exists but the email did not leave. Re-send it.");

export default function ApplicationsPage() {
  const [which, setWhich] = useState<"open" | "closed">("open");
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const me = claims()?.email?.toLowerCase() ?? "";
  const refresh = () => load(which).then((v) => { setView(v); setError(""); }).catch((e) => setError(e.message));
  useEffect(() => { setView(null); refresh(); }, [which]);

  if (error && !view) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell"><p className="muted">Loading applications…</p></main>;

  const pending = view.requests.filter((r) => r.status === "pending");
  const waiting = (id: string) => pending.some((r) => r.target_key === id);

  return (
    <main className="shell">
      <header className="top"><h1>Applications</h1><p className="who">Signed in as {me}</p></header>
      <p className="lead muted">
        Institutions apply here instead of registering. Reviewing is one person; creating the bank and its
        first admin after the contract needs a second admin.
      </p>
      {notice && <p className="hint" role="status">{notice}</p>}

      {pending.length > 0 && (
        <section className="history">
          <h2>Provisioning waiting for a second approver</h2>
          <ul className="board">{pending.map((r) => (
            <Pending key={r.id} r={r} mine={r.maker_email.toLowerCase() === me}
              onDone={(msg) => { setNotice(msg ?? ""); refresh(); }} />))}</ul>
        </section>
      )}

      <section className="history">
        <div className="actions left" role="tablist" aria-label="Which applications">
          {(["open", "closed"] as const).map((w) => (
            <button key={w} role="tab" aria-selected={which === w} className={which === w ? "primary" : "ghost"}
              onClick={() => setWhich(w)}>{w === "open" ? "Open" : "Closed"}</button>
          ))}
        </div>
        {view.applications.length === 0 ? <p className="muted empty">No {which} applications.</p> : (
          <ul className="board">
            {view.applications.map((a) => (
              <li key={a.request_id} className={`breaker ${a.status === "rejected" ? "off" : "on"}`}>
                <button className="row-btn" aria-expanded={open === a.request_id}
                  onClick={() => setOpen(open === a.request_id ? null : a.request_id)}>
                  <span className="text">
                    <strong>{a.institution_name}</strong>
                    <span className="muted"> · {LABEL[a.status]} · {a.reference}{a.verified_at ? ` · applied ${fmt(a.verified_at)}` : ""}</span>
                  </span>
                  <span aria-hidden>{open === a.request_id ? "−" : "+"}</span>
                </button>
                {open === a.request_id && (
                  <Detail a={a} busy={waiting(a.request_id)} onDone={(msg) => { setNotice(msg ?? ""); refresh(); }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Pending({ r, mine, onDone }: { r: ProvisionRequest; mine: boolean; onDone: (msg?: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<string | undefined>) => {
    setBusy(true); setErr("");
    try { onDone(await fn()); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <li className="breaker on">
      <div className="text">
        <h2>Create {r.target_label}</h2>
        <p>Contract {r.args.contract_reference} · {r.args.deployment_model} · asked by {r.maker_email} · {fmt(r.created_at)}</p>
        <p className="reason">“{r.reason}”</p>
        <ChangeTable r={r} />
      </div>
      <div className="confirm">
        {mine ? <p className="hint">You asked for this, so someone else must approve it.</p> : <>
          <p className="consequence">Approving creates the bank (unapproved) and its first admin login, then emails that admin a set-password link.</p>
          <label htmlFor={`n-${r.id}`}>Note (required to reject)</label>
          <textarea id={`n-${r.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions">
          {mine ? <button className="ghost" disabled={busy} onClick={() => run(async () => { await withdrawProvision(r); return undefined; })}>Withdraw</button> : <>
            <button className="ghost" disabled={busy || note.trim().length < 10}
              onClick={() => run(async () => { await rejectProvision(r, note.trim()); return undefined; })}>Reject</button>
            <button className="primary" disabled={busy}
              onClick={() => run(async () => inviteText((await approveProvision(r, note.trim())).invite))}>
              {busy ? "Working…" : "Approve and create"}
            </button>
          </>}
        </div>
      </div>
    </li>
  );
}

function Detail({ a, busy, onDone }: { a: Application; busy: boolean; onDone: (msg?: string) => void }) {
  const [form, setForm] = useState<null | Status | "provision">(null);
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);
  const can = (to: Status) => ({
    submitted: ["in_review", "info_requested", "approved", "rejected"],
    in_review: ["info_requested", "approved", "rejected"],
    info_requested: ["in_review", "approved", "rejected"],
    approved: ["in_review", "rejected"],
  } as Record<string, string[]>)[a.status]?.includes(to) ?? false;
  const quick = async (to: Status) => {
    setWorking(true); setErr("");
    try { await review(a, to, ""); onDone(); } catch (e) { setErr((e as Error).message); setWorking(false); }
  };
  return (
    <div className="confirm">
      <p>{TYPE[a.institution_type] ?? a.institution_type} · {a.country}{a.regulator ? ` · regulated by ${a.regulator}` : ""}{a.reg_number ? ` · reg. ${a.reg_number}` : ""}</p>
      {a.website && <p>Website: {a.website}</p>}
      <p>Contact: {a.contact_name}{a.contact_role ? ` (${a.contact_role})` : ""} &lt;{a.contact_email}&gt;{a.contact_phone ? ` · ${a.contact_phone}` : ""}</p>
      {a.message && <p className="reason">“{a.message}”</p>}
      {a.review_note && <p className="consequence">Last note: “{a.review_note}”</p>}
      {a.status === "provisioned" && <p>Provisioned {a.provisioned_at ? fmt(a.provisioned_at) : ""} under contract {a.contract_reference}.</p>}
      {err && <p className="err" role="alert">{err}</p>}

      {busy ? <p className="hint">Provisioning for this application is waiting for a second admin.</p>
        : form === "provision" ? <Provision a={a} onCancel={() => setForm(null)} onDone={onDone} />
        : form ? <Note a={a} to={form} onCancel={() => setForm(null)} onDone={onDone} />
        : <div className="actions left">
            {can("in_review") && <button className="ghost" disabled={working} onClick={() => quick("in_review")}>{a.status === "approved" ? "Back to review" : "Start review"}</button>}
            {can("info_requested") && <button className="ghost" disabled={working} onClick={() => setForm("info_requested")}>Ask for information</button>}
            {can("approved") && <button className="ghost" disabled={working} onClick={() => setForm("approved")}>Approve application</button>}
            {a.status === "approved" && <button className="primary" onClick={() => setForm("provision")}>Contract signed: create the bank</button>}
            {can("rejected") && <button className="ghost destructive-ghost" disabled={working} onClick={() => setForm("rejected")}>Reject</button>}
            {a.status === "provisioned" && <button className="ghost" disabled={working} onClick={async () => {
              setWorking(true); setErr("");
              try { onDone(inviteText((await resendInvite(a.contact_email)).invite)); } catch (e) { setErr((e as Error).message); setWorking(false); }
            }}>Re-send the admin's invitation</button>}
          </div>}
    </div>
  );
}

function Note({ a, to, onCancel, onDone }: { a: Application; to: Status; onCancel: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const required = to === "rejected" || to === "info_requested";
  return (
    <form className={`confirm ${to === "rejected" ? "grave" : ""}`} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try { await review(a, to, note.trim()); onDone(); } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      {to === "approved" && <p className="hint">Approving creates nothing. After the contract is signed, ask to create the bank.</p>}
      {to === "info_requested" && <p className="hint">Contact the applicant yourself; this records what you asked for.</p>}
      <label htmlFor="r-note">{required ? "Why? (required)" : "Note (optional)"}</label>
      <textarea id="r-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className={to === "rejected" ? "primary destructive" : "primary"}
          disabled={busy || (required && note.trim().length < 10)}>{busy ? "Saving…" : LABEL[to]}</button>
      </div>
    </form>
  );
}

function Provision({ a, onCancel, onDone }: { a: Application; onCancel: () => void; onDone: () => void }) {
  const [contract, setContract] = useState("");
  const [model, setModel] = useState("saas");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <form className="confirm" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try { await askProvision(a, contract.trim(), model, reason.trim()); onDone(); } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      <p className="consequence">Once a second admin approves, {a.institution_name} is created (unapproved, in onboarding) with {a.contact_email} as its first admin, who is emailed a set-password link.</p>
      <label htmlFor="p-contract">Signed contract reference</label>
      <input id="p-contract" maxLength={100} value={contract} onChange={(e) => setContract(e.target.value)} />
      <label htmlFor="p-model">Deployment</label>
      <select id="p-model" value={model} onChange={(e) => setModel(e.target.value)}>
        <option value="saas">Standard: shared, hosted by Ficium</option>
        <option value="paas">Dedicated: own database, run by Ficium</option>
        <option value="on_prem">Sovereign: the institution's own infrastructure</option>
      </select>
      <label htmlFor="p-reason">Why?</label>
      <textarea id="p-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="hint">A second admin must approve this before anything is created.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || contract.trim().length < 3 || reason.trim().length < 10}>
          {busy ? "Sending…" : "Send for approval"}
        </button>
      </div>
    </form>
  );
}
