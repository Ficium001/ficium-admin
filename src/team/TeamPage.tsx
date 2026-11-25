import { useEffect, useMemo, useState } from "react";
import {
  type Admin, type Change, type Group, type Op, type Team,
  approve, ask, cutOff, loadTeam, reject, resend, withdraw,
} from "./api";

const MIN_REASON = 10;
const fmt = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("en-MU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";
const errText = (x: unknown) => (x instanceof Error ? x.message : "Something went wrong");
const OP_LABEL: Record<Op, string> = {
  invite: "Invite", set_roles: "Change groups", reactivate: "Reactivate", reset_login: "Reset sign-in",
  rename: "Rename", group_create: "New group", group_update: "Change group", group_retire: "Retire group",
};
type Tab = "members" | "groups" | "approvals";

export default function TeamPage() {
  const [data, setData] = useState<Team | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("members");
  const refresh = () => loadTeam().then((d) => { setData(d); setError(""); }).catch((e) => setError(errText(e)));
  useEffect(() => { refresh(); }, []);
  const done = (msg: string) => { setNotice(msg); refresh(); };

  if (error && !data) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!data) return <main className="shell"><p className="muted">Loading the team…</p></main>;
  const pending = data.changes.filter((c) => c.status === "pending");
  const can = (p: string) => data.me.permissions.includes(p);
  const ctx: Ctx = { data, can, done, label: (k) => data.groups.find((g) => g.code === k)?.label ?? k };

  return (
    <main className="shell">
      <header className="top"><h1>Team</h1><p className="who">Signed in as {data.email}</p></header>
      <p className="lead">Everyone here signs in with their own Ficium username, password and authenticator app. What they can
        do depends on their groups. Giving or restoring access needs two people: one asks, a different admin approves.
        Suspending or disabling someone is immediate. Every step is recorded with who did it and why.</p>
      {notice && <p className="status ok" role="status">{notice}</p>}
      {error && <p className="status danger" role="alert">{error}</p>}
      {data.identity_error && <p className="status warn" role="status">Sign-in details (usernames, authenticator, last sign-in) could not be loaded: {data.identity_error}</p>}
      <div className="segmented" role="group" aria-label="Team sections">
        {(["members", "groups", "approvals"] as Tab[]).map((t) => (
          <button key={t} type="button" className="ghost" aria-pressed={tab === t} onClick={() => { setNotice(""); setTab(t); }}>
            {t === "members" ? `Members (${data.admins.filter((a) => a.status !== "disabled").length})`
              : t === "groups" ? `Groups (${data.groups.filter((g) => !g.retired).length})`
              : `Approvals${pending.length ? ` (${pending.length})` : ""}`}
          </button>
        ))}
      </div>
      {tab === "members" && <Members ctx={ctx} />}
      {tab === "groups" && <Groups ctx={ctx} />}
      {tab === "approvals" && <Approvals ctx={ctx} />}
    </main>
  );
}

type Ctx = { data: Team; can: (p: string) => boolean; done: (msg: string) => void; label: (code: string) => string };

function useBusy() {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const run = (fn: () => Promise<unknown>, after: (r: any) => void) => async () => {
    setBusy(true); setErr("");
    try { after(await fn()); } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return { busy, err, run };
}

function Reason({ id, value, onChange, hint }: { id: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="fld"><label htmlFor={id}>Reason</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={2000} />
      <span className="hint">{hint ?? `Saved in the audit log with your name. At least ${MIN_REASON} characters.`}</span></div>
  );
}

function GroupPicker({ groups, value, onChange }: { groups: Group[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="fld"><legend>Groups</legend>
      {groups.filter((g) => !g.retired).map((g) => (
        <label key={g.code} className="check">
          <input type="checkbox" checked={value.includes(g.code)}
            onChange={(e) => onChange(e.target.checked ? [...value, g.code] : value.filter((x) => x !== g.code))} />
          <span><strong>{g.label}</strong> — {g.description}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────── members
function signIn(a: Admin): { text: string; tone: "" | "ok" | "warn" | "danger" } {
  const l = a.login;
  if (!l) return { text: a.status === "invited" ? "Invitation sent" : "No sign-in details", tone: "warn" };
  if (!l.activated) return { text: "Hasn't set a password", tone: "warn" };
  if (l.locked) return { text: "Locked (too many tries)", tone: "danger" };
  if (!l.mfa_enabled) return { text: "No authenticator yet", tone: "warn" };
  return { text: "Authenticator on", tone: "ok" };
}
const statusTone = (s: Admin["status"]) => (s === "active" ? "ok" : s === "invited" ? "warn" : "danger");

function Members({ ctx }: { ctx: Ctx }) {
  const { data, can } = ctx;
  const [q, setQ] = useState(""); const [showOff, setShowOff] = useState(false);
  const [inviting, setInviting] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const pendingFor = useMemo(() => {
    const m = new Map<string, Change[]>();
    for (const c of data.changes) if (c.status === "pending" && c.target_user) m.set(c.target_user, [...(m.get(c.target_user) ?? []), c]);
    return m;
  }, [data.changes]);
  const invites = data.changes.filter((c) => c.status === "pending" && c.op === "invite");
  const list = data.admins.filter((a) => {
    const s = q.trim().toLowerCase();
    return (showOff || a.status !== "disabled")
      && (!s || [a.display_name, a.email, a.login?.username ?? ""].some((v) => v.toLowerCase().includes(s)));
  });
  const offCount = data.admins.filter((a) => a.status === "disabled").length;
  return (
    <>
      {inviting
        ? <InviteForm ctx={ctx} onCancel={() => setInviting(false)} onDone={(m) => { setInviting(false); ctx.done(m); }} />
        : can("iam.manage") && <div className="actions left"><button className="primary" onClick={() => setInviting(true)}>Invite someone</button></div>}
      {invites.length > 0 && (
        <p className="status warn" role="status">Waiting for a second admin: {invites.map((c) => c.target_label).join(", ")}. See Approvals.</p>
      )}
      <div className="two">
        <div className="fld"><label htmlFor="team-q">Search</label>
          <input id="team-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or username" maxLength={100} /></div>
        {offCount > 0 && <label className="check" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
          <span>Show disabled ({offCount})</span></label>}
      </div>
      <ul className="board">
        {list.length === 0 && <li className="breaker"><p className="muted">Nobody matches.</p></li>}
        {list.map((a) => {
          const si = signIn(a); const waiting = pendingFor.get(a.id) ?? [];
          return (
            <li key={a.id} className="offer-row">
              <button className="row-btn" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                <span className="text">
                  <span className="name">{a.display_name}{a.login?.username && <span className="muted"> · @{a.login.username}</span>}</span>
                  <span className="sub">{a.email} · {a.roles.map(ctx.label).join(", ") || "no groups"}</span>
                  <span className="sub">{si.text} · last seen {fmt(a.last_seen_at)}{waiting.length > 0 && ` · ${waiting.length} change waiting`}</span>
                </span>
                <span className={`pill ${statusTone(a.status)}`}>{a.status}</span>
              </button>
              {open === a.id && <Manage ctx={ctx} admin={a} waiting={waiting}
                onDone={(m) => { setOpen(null); ctx.done(m); }} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function InviteForm({ ctx, onCancel, onDone }: { ctx: Ctx; onCancel: () => void; onDone: (msg: string) => void }) {
  const [email, setEmail] = useState(""); const [name, setName] = useState(""); const [username, setUsername] = useState("");
  const [touchedUser, setTouchedUser] = useState(false);
  const [roles, setRoles] = useState<string[]>(["read_only"]); const [reason, setReason] = useState("");
  const { busy, err, run } = useBusy();
  const suggested = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "") ?? "";
  const user = touchedUser ? username : suggested;
  const ok = /^[^@\s]+@ficium\.net$/i.test(email.trim()) && name.trim().length >= 2
    && /^[a-z0-9][a-z0-9._-]{2,39}$/.test(user) && roles.length > 0 && reason.trim().length >= MIN_REASON;
  return (
    <form className="panel form" onSubmit={(e) => { e.preventDefault();
      run(() => ask("invite", { email: email.trim(), display_name: name.trim(), username: user, roles }, reason.trim()),
        () => onDone(`Invitation for ${email.trim()} is waiting for a second admin. Once approved, they get an email to set a password (valid 24 hours), then set up their authenticator.`))(); }}>
      <h2>Invite someone</h2>
      <div className="two">
        <div className="fld"><label htmlFor="ie">Ficium email</label>
          <input id="ie" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="fld"><label htmlFor="in">Full name</label>
          <input id="in" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></div>
      </div>
      <div className="fld"><label htmlFor="iu">Username</label>
        <input id="iu" value={user} onChange={(e) => { setTouchedUser(true); setUsername(e.target.value.toLowerCase().replace(/\s+/g, "")); }} required maxLength={40} />
        <span className="hint">What they type to sign in. 3–40 letters, digits, dot, dash or underscore. If they already sign in to the
          other admin site, use the same username: no new login is made.</span></div>
      <GroupPicker groups={ctx.data.groups} value={roles} onChange={setRoles} />
      <Reason id="ir" value={reason} onChange={setReason} />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="primary" disabled={!ok || busy}>{busy ? "Sending…" : "Ask for approval"}</button>
      </div>
    </form>
  );
}

function Manage({ ctx, admin, waiting, onDone }: { ctx: Ctx; admin: Admin; waiting: Change[]; onDone: (msg: string) => void }) {
  const { data, can } = ctx;
  const self = admin.id === data.me.admin_id;
  const [roles, setRoles] = useState(admin.roles); const [name, setName] = useState(admin.display_name);
  const [mfa, setMfa] = useState(false); const [reason, setReason] = useState("");
  const { busy, err, run } = useBusy();
  const r = reason.trim(); const okReason = r.length >= MIN_REASON;
  const rolesChanged = roles.slice().sort().join() !== admin.roles.slice().sort().join();
  const asked = (what: string) => `${what} for ${admin.display_name} is waiting for a second admin.`;
  const l = admin.login;
  return (
    <div className="panel form">
      <div className="change"><table><tbody>
        <tr><th>Username</th><td>{l?.username ?? "—"}</td></tr>
        <tr><th>Email</th><td>{admin.email}</td></tr>
        <tr><th>Sign-in</th><td>{signIn(admin).text}{l?.last_login_at ? ` · last password sign-in ${fmt(l.last_login_at)}` : ""}</td></tr>
        <tr><th>Last used this site</th><td>{fmt(admin.last_seen_at)}</td></tr>
        <tr><th>Added</th><td>{fmt(admin.created_at)}{admin.created_by ? ` by ${admin.created_by}` : ""}</td></tr>
      </tbody></table></div>
      {waiting.length > 0 && <p className="hint">Waiting for approval: {waiting.map((c) => OP_LABEL[c.op]).join(", ")}.</p>}
      {self && <p className="muted">This is you. Someone else must ask for changes to your groups, name, sign-in or status.</p>}
      {!self && can("iam.manage") && <>
        {admin.status === "invited" && (
          <div className="actions left">
            <button className="ghost" disabled={busy} onClick={run(() => resend(admin.email), (x) => {
              if (!x.email_sent) throw new Error("The invitation email could not be sent. Check the email setup (Resend).");
              onDone(`Invitation re-sent to ${admin.email}.`);
            })}>Re-send invitation</button>
          </div>
        )}
        {admin.status !== "disabled" && <GroupPicker groups={data.groups} value={roles} onChange={setRoles} />}
        {admin.status !== "disabled" && (
          <div className="fld"><label htmlFor={`n-${admin.id}`}>Full name</label>
            <input id={`n-${admin.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></div>
        )}
        {(admin.status === "active" || admin.status === "suspended") && (
          <label className="check"><input type="checkbox" checked={mfa} onChange={(e) => setMfa(e.target.checked)} />
            <span>When resetting sign-in, also remove their authenticator app (lost or replaced phone)</span></label>
        )}
        <Reason id={`r-${admin.id}`} value={reason} onChange={setReason} hint={`Required for any change below. At least ${MIN_REASON} characters.`} />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions">
          {admin.status === "active" && <button className="ghost destructive-ghost" disabled={!okReason || busy}
            onClick={run(() => cutOff(admin, "suspended", r), () => onDone(`${admin.display_name} is suspended, effective now.`))}>Suspend now</button>}
          {admin.status !== "disabled" && <button className="ghost destructive-ghost" disabled={!okReason || busy}
            onClick={run(() => cutOff(admin, "disabled", r), () => onDone(`${admin.display_name} is disabled, effective now.`))}>Disable now</button>}
          {(admin.status === "suspended" || admin.status === "disabled") && <button className="ghost" disabled={!okReason || busy}
            onClick={run(() => ask("reactivate", {}, r, admin.id), () => onDone(asked("Reactivation")))}>Ask to reactivate</button>}
          {(admin.status === "active" || admin.status === "suspended") && <button className="ghost" disabled={!okReason || busy}
            onClick={run(() => ask("reset_login", { reset_mfa: mfa }, r, admin.id), () => onDone(asked(mfa ? "Sign-in and authenticator reset" : "Sign-in reset")))}>
            Ask to reset sign-in</button>}
          {admin.status !== "disabled" && <button className="ghost" disabled={!okReason || busy || name.trim() === admin.display_name || name.trim().length < 2}
            onClick={run(() => ask("rename", { display_name: name.trim() }, r, admin.id), () => onDone(asked("Rename")))}>Ask to rename</button>}
          {admin.status !== "disabled" && <button className="primary" disabled={!okReason || !rolesChanged || roles.length === 0 || busy}
            onClick={run(() => ask("set_roles", { roles }, r, admin.id), () => onDone(asked("Group change")))}>Ask to change groups</button>}
        </div>
        <p className="hint">A sign-in reset signs them out everywhere, makes their password stop working and emails them (only them) a
          link to set a new one. Nobody ever sees a password.</p>
      </>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── groups
function permLabel(ctx: Ctx, code: string) { return ctx.data.permissions.find((p) => p.code === code)?.description ?? code; }

function PermissionPicker({ ctx, value, onChange }: { ctx: Ctx; value: string[]; onChange: (v: string[]) => void }) {
  const byArea = useMemo(() => {
    const m = new Map<string, { code: string; description: string }[]>();
    for (const p of ctx.data.permissions) { const k = p.code.split(".")[0]!; m.set(k, [...(m.get(k) ?? []), p]); }
    return [...m.entries()];
  }, [ctx.data.permissions]);
  return (
    <fieldset className="fld"><legend>Permissions</legend>
      {byArea.map(([area, ps]) => (
        <div key={area}><p className="hint" style={{ textTransform: "uppercase", marginTop: 8 }}>{area}</p>
          {ps.map((p) => (
            <label key={p.code} className="check">
              <input type="checkbox" checked={value.includes(p.code)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.code] : value.filter((x) => x !== p.code))} />
              <span>{p.description} <span className="muted">({p.code})</span></span>
            </label>
          ))}
        </div>
      ))}
    </fieldset>
  );
}

function Groups({ ctx }: { ctx: Ctx }) {
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const list = ctx.data.groups.filter((g) => showRetired || !g.retired);
  const retired = ctx.data.groups.filter((g) => g.retired).length;
  if (editing) return <GroupForm ctx={ctx} group={editing === "new" ? null : editing}
    onCancel={() => setEditing(null)} onDone={(m) => { setEditing(null); ctx.done(m); }} />;
  return (
    <>
      <p className="lead muted">A group is a set of permissions. People can be in more than one group. Built-in groups can have their
        permissions changed (except Super admin); new groups can be added and, once empty, retired. Every change needs a second admin.</p>
      {ctx.can("iam.manage") && <div className="actions left"><button className="primary" onClick={() => setEditing("new")}>New group</button></div>}
      {retired > 0 && <label className="check"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
        <span>Show retired ({retired})</span></label>}
      <ul className="board">
        {list.map((g) => <GroupRow key={g.code} ctx={ctx} g={g} onEdit={() => setEditing(g)} />)}
      </ul>
    </>
  );
}

function GroupRow({ ctx, g, onEdit }: { ctx: Ctx; g: Group; onEdit: () => void }) {
  const [reason, setReason] = useState(""); const [retiring, setRetiring] = useState(false);
  const { busy, err, run } = useBusy();
  const waiting = ctx.data.changes.some((c) => c.status === "pending" && c.target_key === g.code && c.op.startsWith("group_"));
  return (
    <li className="breaker">
      <div className="text">
        <h2>{g.label} <span className="tag">{g.retired ? "Retired" : g.is_system ? "Built-in" : "Custom"}</span>
          {waiting && <span className="tag">Change waiting</span>}</h2>
        <p>{g.description}</p>
        <p className="hint">{g.members.length === 0 ? "Nobody" : g.members.map((m) => m.display_name).join(", ")}</p>
        <details><summary>{g.permissions.length} permission{g.permissions.length === 1 ? "" : "s"}</summary>
          <ul>{g.permissions.map((p) => <li key={p} className="hint">{permLabel(ctx, p)} <span className="muted">({p})</span></li>)}</ul>
        </details>
      </div>
      {ctx.can("iam.manage") && !g.retired && !g.locked && (
        <div className="actions left" style={{ marginTop: 8 }}>
          <button className="ghost" onClick={onEdit}>Change</button>
          {!g.is_system && g.members.length === 0 && <button className="ghost destructive-ghost" onClick={() => setRetiring(!retiring)}>Retire</button>}
        </div>
      )}
      {retiring && <div className="form">
        <Reason id={`gr-${g.code}`} value={reason} onChange={setReason} />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions left"><button className="ghost destructive-ghost" disabled={busy || reason.trim().length < MIN_REASON}
          onClick={run(() => ask("group_retire", { code: g.code }, reason.trim()), () => ctx.done(`Retiring ${g.label} is waiting for a second admin.`))}>
          Ask to retire</button></div>
      </div>}
    </li>
  );
}

function GroupForm({ ctx, group, onCancel, onDone }: { ctx: Ctx; group: Group | null; onCancel: () => void; onDone: (m: string) => void }) {
  const [label, setLabel] = useState(group?.label ?? ""); const [desc, setDesc] = useState(group?.description ?? "");
  const [perms, setPerms] = useState<string[]>(group?.permissions ?? []); const [reason, setReason] = useState("");
  const [code, setCode] = useState(""); const [touched, setTouched] = useState(false);
  const { busy, err, run } = useBusy();
  const key = group ? group.code : touched ? code : label.trim().toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  const ok = label.trim().length >= 2 && desc.trim().length >= 1 && perms.length > 0 && reason.trim().length >= MIN_REASON
    && /^[a-z][a-z_]{2,39}$/.test(key);
  return (
    <form className="panel form" onSubmit={(e) => { e.preventDefault();
      run(() => ask(group ? "group_update" : "group_create", { code: key, label: label.trim(), description: desc.trim(), permissions: perms }, reason.trim()),
        () => onDone(`${group ? "Changes to" : "New group"} ${label.trim()} ${group ? "are" : "is"} waiting for a second admin.`))(); }}>
      <h2>{group ? `Change ${group.label}` : "New group"}</h2>
      <div className="two">
        <div className="fld"><label htmlFor="gl">Name</label><input id="gl" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required /></div>
        <div className="fld"><label htmlFor="gk">Key</label>
          <input id="gk" value={key} disabled={!!group} onChange={(e) => { setTouched(true); setCode(e.target.value.toLowerCase()); }} maxLength={40} />
          <span className="hint">Fixed once created. Lowercase letters and underscores.</span></div>
      </div>
      <div className="fld"><label htmlFor="gd">What it is for</label><input id="gd" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} required /></div>
      <PermissionPicker ctx={ctx} value={perms} onChange={setPerms} />
      <Reason id="gr" value={reason} onChange={setReason} />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="primary" disabled={!ok || busy}>{busy ? "Sending…" : "Ask for approval"}</button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────── approvals
function Diff({ ctx, c }: { ctx: Ctx; c: Change }) {
  const a = c.args; const b = c.before ?? {};
  const list = (v: unknown, f: (s: string) => string = (s) => s) => (Array.isArray(v) ? v.map((x) => f(String(x))).join(", ") : "—");
  const rows: [string, string, string][] = [];
  if (c.op === "invite") rows.push(["Email", "", String(a.email)], ["Name", "", String(a.display_name)], ["Username", "", String(a.username)], ["Groups", "", list(a.roles, ctx.label)]);
  if (c.op === "set_roles") rows.push(["Groups", list(b.roles, ctx.label), list(a.roles, ctx.label)]);
  if (c.op === "rename") rows.push(["Name", String(b.display_name ?? ""), String(a.display_name)]);
  if (c.op === "reactivate") rows.push(["Status", String(b.status ?? ""), "active"]);
  if (c.op === "reset_login") rows.push(["Password", "works", "stops working, link emailed to them"], ["Authenticator", "kept", a.reset_mfa ? "removed, set up again" : "kept"]);
  if (c.op === "group_create" || c.op === "group_update") {
    rows.push(["Name", String(b.label ?? ""), String(a.label)], ["For", String(b.description ?? ""), String(a.description)]);
    const was = new Set((b.permissions as string[] | undefined) ?? []); const now = new Set((a.permissions as string[]) ?? []);
    const added = [...now].filter((p) => !was.has(p)); const removed = [...was].filter((p) => !now.has(p));
    if (added.length) rows.push(["Permissions added", "", added.map((p) => permLabel(ctx, p)).join("; ")]);
    if (removed.length) rows.push(["Permissions removed", removed.map((p) => permLabel(ctx, p)).join("; "), ""]);
  }
  if (c.op === "group_retire") rows.push(["Group", "in use", "retired, all permissions removed"]);
  return (
    <div className="change"><table>
      <thead><tr><th></th><th>Now</th><th>After approval</th></tr></thead>
      <tbody>{rows.map(([k, x, y]) => <tr key={k} className="changed"><th>{k}</th><td>{x || "—"}</td><td><strong>{y || "—"}</strong></td></tr>)}</tbody>
    </table></div>
  );
}

function Approvals({ ctx }: { ctx: Ctx }) {
  const pending = ctx.data.changes.filter((c) => c.status === "pending");
  const decided = ctx.data.changes.filter((c) => c.status !== "pending").slice(0, 25);
  return (
    <>
      <p className="lead muted">Changes that give or restore access. Approving one makes it happen straight away. You can't approve your
        own request, or one about yourself. Requests expire after 7 days.</p>
      <ul className="board">
        {pending.length === 0 && <li className="breaker"><p className="muted">Nothing is waiting.</p></li>}
        {pending.map((c) => <PendingRow key={c.id} ctx={ctx} c={c} />)}
      </ul>
      {decided.length > 0 && <>
        <h2 style={{ margin: "24px 0 8px" }}>Recently decided</h2>
        <table className="table"><thead><tr><th>Change</th><th>Asked by</th><th>Outcome</th></tr></thead>
          <tbody>{decided.map((c) => (
            <tr key={c.id}>
              <td>{OP_LABEL[c.op]}: {c.target_label}<div className="hint">{c.reason}</div></td>
              <td>{c.maker_name}<div className="hint">{fmt(c.created_at)}</div></td>
              <td><span className={`pill ${c.status === "approved" ? "ok" : c.status === "rejected" ? "danger" : ""}`}>{c.status}</span>
                <div className="hint">{c.checker_email ? `by ${c.checker_email}` : ""} {fmt(c.decided_at)}</div>
                {c.decision_note && <div className="hint">{c.decision_note}</div>}
                {c.result && "email_sent" in c.result && !c.result.email_sent && c.result.status !== "existing" &&
                  <div className="err">Email not sent: re-send from Members.</div>}</td>
            </tr>))}</tbody></table>
      </>}
    </>
  );
}

function PendingRow({ ctx, c }: { ctx: Ctx; c: Change }) {
  const [note, setNote] = useState(""); const { busy, err, run } = useBusy();
  const mine = c.maker_id === ctx.data.me.admin_id; const aboutMe = c.target_user === ctx.data.me.admin_id;
  const canDecide = ctx.can("iam.approve") && !mine && !aboutMe;
  const outcome = (r: { result: { status: string; email_sent: boolean } | null }) => {
    const x = r.result;
    if (!x) return `Approved: ${OP_LABEL[c.op].toLowerCase()} for ${c.target_label} is done.`;
    if (x.status === "existing") return `Approved. ${c.target_label} already has a Ficium login, so they can sign in to this site now with it.`;
    if (!x.email_sent) return `Approved, but the email to ${c.target_label} could not be sent. Fix email sending, then re-send from Members.`;
    return c.op === "invite" ? `Approved. ${c.target_label} has been emailed a link to set a password (24 hours).`
      : `Approved. ${c.target_label} is signed out everywhere and has been emailed a link to set a new password.`;
  };
  return (
    <li className="breaker">
      <div className="text">
        <h2>{OP_LABEL[c.op]}: {c.target_label}</h2>
        <p className="hint">Asked by {c.maker_name} ({c.maker_email}) on {fmt(c.created_at)} · expires {fmt(c.expires_at)}</p>
        <p>“{c.reason}”</p>
      </div>
      <Diff ctx={ctx} c={c} />
      <div className="form">
        {canDecide && <div className="fld"><label htmlFor={`note-${c.id}`}>Note</label>
          <input id={`note-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          <span className="hint">Optional to approve; needed to reject (at least {MIN_REASON} characters).</span></div>}
        {!canDecide && <p className="hint">{mine ? "You asked for this, so someone else must approve it."
          : aboutMe ? "This is about you, so someone else must decide."
          : "You don't have permission to approve team changes."}</p>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions left">
          {canDecide && <button className="primary" disabled={busy} onClick={run(() => approve(c, note.trim() || undefined), (r) => ctx.done(outcome(r)))}>Approve</button>}
          {canDecide && <button className="ghost destructive-ghost" disabled={busy || note.trim().length < MIN_REASON}
            onClick={run(() => reject(c, note.trim()), () => ctx.done(`Rejected: ${OP_LABEL[c.op].toLowerCase()} for ${c.target_label}.`))}>Reject</button>}
          {mine && <button className="ghost" disabled={busy} onClick={run(() => withdraw(c), () => ctx.done("Request withdrawn."))}>Withdraw</button>}
        </div>
      </div>
    </li>
  );
}
