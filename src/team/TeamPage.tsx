import { useEffect, useState } from "react";
import { type Admin, ROLES, invite, listTeam, resend, setRoles, setStatus } from "./api";

const MIN_REASON = 10;
const label = (k: string) => ROLES.find((r) => r.key === k)?.label ?? k;

export default function TeamPage() {
  const [data, setData] = useState<{ admins: Admin[]; me: string } | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [inviting, setInviting] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const refresh = () => listTeam().then(setData).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !data) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!data) return <main className="shell"><p className="muted">Loading the team…</p></main>;
  return (
    <main className="shell">
      <header className="top"><h1>Team</h1><p className="who">Signed in as {data.me}</p></header>
      <p className="lead">Everyone here signs in with their own Ficium account and an authenticator app. What they can do depends on their roles. Every change is recorded with who made it and why.</p>
      {notice && <p className="status ok" role="status">{notice}</p>}
      {inviting
        ? <InviteForm onCancel={() => setInviting(false)} onDone={(msg) => { setInviting(false); setNotice(msg); refresh(); }} />
        : <div className="actions left"><button className="primary" onClick={() => { setNotice(""); setInviting(true); }}>Invite someone</button></div>}
      <ul className="board">
        {data.admins.map((a) => (
          <li key={a.id} className="offer-row">
            <button className="row-btn" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
              <span><strong>{a.display_name}</strong> <span className="muted">· {a.email}</span><br />
                <span className="hint">{a.roles.map(label).join(", ")}</span></span>
              <span className="pill">{a.status}</span>
            </button>
            {open === a.id && <Manage admin={a} self={a.email === data.me}
              onDone={(msg) => { setOpen(null); setNotice(msg); refresh(); }} />}
          </li>
        ))}
      </ul>
    </main>
  );
}

function RolePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="fld"><legend>Roles</legend>
      {ROLES.map((r) => (
        <label key={r.key} className="check">
          <input type="checkbox" checked={value.includes(r.key)}
            onChange={(e) => onChange(e.target.checked ? [...value, r.key] : value.filter((x) => x !== r.key))} />
          <span><strong>{r.label}</strong> — {r.does}</span>
        </label>
      ))}
    </fieldset>
  );
}

function InviteForm({ onCancel, onDone }: { onCancel: () => void; onDone: (msg: string) => void }) {
  const [email, setEmail] = useState(""); const [name, setName] = useState(""); const [username, setUsername] = useState("");
  const [roles, setRolesV] = useState<string[]>(["compliance"]); const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const ok = /@ficium\.net$/i.test(email.trim()) && name.trim().length >= 2 && /^[a-z0-9][a-z0-9._-]{2,39}$/.test(username) && roles.length > 0 && reason.trim().length >= MIN_REASON;
  return (
    <form className="panel form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try {
        const r = await invite({ email: email.trim(), display_name: name.trim(), username, roles, reason: reason.trim() });
        onDone(r.email_sent
          ? `Invited ${email.trim()}. They'll get an email to set a password (valid 24 hours), then set up their authenticator.`
          : `${email.trim()} is on the team, but the invitation email could not be sent. Fix email sending, then use "Re-send invitation".`);
      } catch (x) { setErr(x instanceof Error ? x.message : "Something went wrong"); } finally { setBusy(false); }
    }}>
      <h2>Invite someone</h2>
      <div className="two">
        <div className="fld"><label htmlFor="ie">Ficium email</label>
          <input id="ie" type="email" value={email} onChange={(e) => { setEmail(e.target.value); if (!username) setUsername(""); }} required /></div>
        <div className="fld"><label htmlFor="in">Name</label><input id="in" value={name} onChange={(e) => setName(e.target.value)} required /></div>
      </div>
      <div className="fld"><label htmlFor="iu">Username</label>
        <input id="iu" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder={email.split("@")[0]?.toLowerCase() ?? ""} required />
        <span className="hint">What they type to sign in. 3–40 letters, digits, dot, dash or underscore.</span></div>
      <RolePicker value={roles} onChange={setRolesV} />
      <div className="fld"><label htmlFor="ir">Reason</label>
        <input id="ir" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Second approver for offers (maker-checker)" required />
        <span className="hint">Saved in the audit log with your name. At least {MIN_REASON} characters.</span></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="primary" disabled={!ok || busy}>{busy ? "Inviting…" : "Send invitation"}</button>
      </div>
    </form>
  );
}

function Manage({ admin, self, onDone }: { admin: Admin; self: boolean; onDone: (msg: string) => void }) {
  const [roles, setRolesV] = useState(admin.roles); const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const go = (fn: () => Promise<unknown>, msg: string) => async () => {
    setBusy(true); setErr("");
    try { await fn(); onDone(msg); } catch (x) { setErr(x instanceof Error ? x.message : "Something went wrong"); } finally { setBusy(false); }
  };
  if (self) return <div className="panel"><p className="muted">This is you. Someone else with "Super admin" must change your roles or status.</p></div>;
  const r = reason.trim(); const okReason = r.length >= MIN_REASON;
  const rolesChanged = roles.slice().sort().join() !== admin.roles.slice().sort().join();
  return (
    <div className="panel form">
      {admin.status === "invited" && (
        <div className="actions left">
          <button className="ghost" disabled={busy} onClick={go(async () => {
            const x = await resend(admin.email);
            if (!x.email_sent) throw new Error("The invitation email could not be sent. Check the email setup (Resend).");
          }, `Invitation re-sent to ${admin.email}.`)}>Re-send invitation</button>
        </div>
      )}
      <RolePicker value={roles} onChange={setRolesV} />
      <div className="fld"><label htmlFor={`r-${admin.id}`}>Reason</label>
        <input id={`r-${admin.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        <span className="hint">Required for any change below. At least {MIN_REASON} characters.</span></div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        {admin.status === "active" && <button className="ghost destructive-ghost" disabled={!okReason || busy}
          onClick={go(() => setStatus(admin, "suspended", r), `${admin.display_name} is suspended.`)}>Suspend</button>}
        {admin.status === "suspended" && <button className="ghost" disabled={!okReason || busy}
          onClick={go(() => setStatus(admin, "active", r), `${admin.display_name} is active again.`)}>Reactivate</button>}
        {admin.status !== "disabled" && <button className="ghost destructive-ghost" disabled={!okReason || busy}
          onClick={go(() => setStatus(admin, "disabled", r), `${admin.display_name} is disabled.`)}>Disable</button>}
        <button className="primary" disabled={!okReason || !rolesChanged || roles.length === 0 || busy}
          onClick={go(() => setRoles(admin, roles, r), `Roles updated for ${admin.display_name}.`)}>Save roles</button>
      </div>
    </div>
  );
}
