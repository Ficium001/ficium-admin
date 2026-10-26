import { useEffect, useState, type ReactNode } from "react";
import {
  AuthFailure, changePassword, claims, enrolConfirm, enrolStart, hasMfa, isSignedIn,
  login, logout, onAuthChange, refresh, verifyMfa,
} from "./client";

type View =
  | { v: "loading" } | { v: "signin" } | { v: "code"; mfaToken: string }
  | { v: "password" } | { v: "enrol" } | { v: "codes"; codes: string[] } | { v: "in" };

const routeAfterToken = (mustChange = false): View =>
  !isSignedIn() ? { v: "signin" } : mustChange ? { v: "password" } : hasMfa() ? { v: "in" } : { v: "enrol" };

export default function Gate({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>({ v: "loading" });
  useEffect(() => { refresh().then(() => setView(routeAfterToken())); }, []);
  useEffect(() => onAuthChange(() => setView((cur) =>
    !isSignedIn() && cur.v !== "codes" && cur.v !== "code" && cur.v !== "signin" ? { v: "signin" } : cur)), []);

  if (view.v === "loading") return <main className="shell"><p className="muted">Checking your session…</p></main>;
  if (view.v === "in") return (
    <>
      <div className="session"><span>{claims()?.email}</span>
        <button className="ghost" onClick={() => logout()}>Sign out</button></div>
      {children}
    </>
  );
  return (
    <main className="shell auth">
      <h1>Ficium Admin</h1>
      {view.v === "signin" && <SignIn onNext={setView} />}
      {view.v === "code" && <Code mfaToken={view.mfaToken} onNext={setView} />}
      {view.v === "password" && <NewPassword onNext={setView} />}
      {view.v === "enrol" && <Enrol onNext={setView} />}
      {view.v === "codes" && <BackupCodes codes={view.codes} onDone={() => setView({ v: "signin" })} />}
    </main>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (e) { setErr(e instanceof AuthFailure || e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  };
  return { busy, err, run };
}

function SignIn({ onNext }: { onNext: (v: View) => void }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const s = useSubmit();
  return (
    <form className="panel form" onSubmit={(e) => { e.preventDefault(); s.run(async () => {
      const step = await login(u, p);
      onNext(step.kind === "mfa" ? { v: "code", mfaToken: step.mfaToken } : routeAfterToken(step.mustChangePassword));
    }); }}>
      <label htmlFor="u">Username</label>
      <input id="u" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required autoFocus />
      <label htmlFor="p">Password</label>
      <input id="p" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required />
      {s.err && <p className="err" role="alert">{s.err}</p>}
      <div className="actions"><button className="primary" disabled={s.busy || !u || !p}>{s.busy ? "Signing in…" : "Sign in"}</button></div>
      <p className="hint">Ficium staff only. Two-factor authentication is required.</p>
    </form>
  );
}

function Code({ mfaToken, onNext }: { mfaToken: string; onNext: (v: View) => void }) {
  const [c, setC] = useState(""); const s = useSubmit();
  return (
    <form className="panel form" onSubmit={(e) => { e.preventDefault(); s.run(async () => {
      const step = await verifyMfa(mfaToken, c);
      onNext(routeAfterToken(step.kind === "done" && step.mustChangePassword));
    }).catch(() => undefined); }}>
      <label htmlFor="c">Code from your authenticator app</label>
      <input id="c" inputMode="numeric" autoComplete="one-time-code" value={c} onChange={(e) => setC(e.target.value)} required autoFocus maxLength={20} />
      <p className="hint">Lost your phone? Enter one of your backup codes instead.</p>
      {s.err && <p className="err" role="alert">{s.err}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={() => onNext({ v: "signin" })}>Back</button>
        <button className="primary" disabled={s.busy || c.trim().length < 6}>{s.busy ? "Checking…" : "Continue"}</button>
      </div>
    </form>
  );
}

function NewPassword({ onNext }: { onNext: (v: View) => void }) {
  const [p, setP] = useState(""); const [q, setQ] = useState(""); const s = useSubmit();
  const ok = p.length >= 12 && p === q;
  return (
    <form className="panel form" onSubmit={(e) => { e.preventDefault(); s.run(async () => {
      await changePassword(p); onNext(routeAfterToken());
    }); }}>
      <p>Choose a new password before continuing.</p>
      <label htmlFor="np">New password (12+ characters)</label>
      <input id="np" type="password" autoComplete="new-password" value={p} onChange={(e) => setP(e.target.value)} required />
      <label htmlFor="nq">Repeat it</label>
      <input id="nq" type="password" autoComplete="new-password" value={q} onChange={(e) => setQ(e.target.value)} required />
      {s.err && <p className="err" role="alert">{s.err}</p>}
      <div className="actions"><button className="primary" disabled={!ok || s.busy}>Save password</button></div>
    </form>
  );
}

function Enrol({ onNext }: { onNext: (v: View) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr_code_svg: string } | null>(null);
  const [c, setC] = useState(""); const s = useSubmit();
  useEffect(() => { s.run(async () => { setSetup(await enrolStart()); }); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="panel form">
      <h2>Set up two-factor authentication</h2>
      <p>This app needs a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) every time you sign in.</p>
      {setup && <>
        <img className="qr" alt="QR code to add Ficium Admin to your authenticator app" src={`data:image/svg+xml;base64,${setup.qr_code_svg}`} />
        <p className="hint">Can't scan? Enter this key: <code className="secret">{setup.secret}</code></p>
        <form onSubmit={(e) => { e.preventDefault(); s.run(async () => onNext({ v: "codes", codes: await enrolConfirm(c) })); }}>
          <label htmlFor="ec">Enter the 6-digit code the app shows</label>
          <input id="ec" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={c} onChange={(e) => setC(e.target.value)} required />
          <div className="actions"><button className="primary" disabled={s.busy || c.length !== 6}>Turn on</button></div>
        </form>
      </>}
      {s.err && <p className="err" role="alert">{s.err}</p>}
    </section>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel form">
      <h2>Save your backup codes</h2>
      <p>Each code works once if you lose your phone. They won't be shown again. Store them in your password manager.</p>
      <ol className="codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved them somewhere safe</label>
      <div className="actions"><button className="primary" disabled={!saved} onClick={onDone}>Sign in with two-factor</button></div>
    </section>
  );
}
