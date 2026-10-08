import { useState } from "react";
import { signIn, totpFactors, enroll, verifyCode, type Session, type Enrollment } from "./auth";

type Step = { kind: "creds" } | { kind: "code"; session: Session; factorId: string } | { kind: "enroll"; session: Session; e: Enrollment };

export default function Login({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "creds" });
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [code, setCode] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(""); try { await fn(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };

  const creds = () => run(async () => {
    const s = await signIn(email.trim(), password); setPassword("");
    const f = totpFactors(s)[0];
    setStep(f ? { kind: "code", session: s, factorId: f.id } : { kind: "enroll", session: s, e: await enroll(s) });
  });
  const verify = (s: Session, id: string) => run(async () => { await verifyCode(s, id, code.trim()); onDone(); });

  return (
    <main className="shell login">
      <header className="top"><h1>Ficium staff sign-in</h1></header>
      {step.kind === "creds" && (
        <form onSubmit={(e) => { e.preventDefault(); creds(); }}>
          <label htmlFor="em">Email</label>
          <input id="em" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
        </form>
      )}
      {step.kind === "enroll" && (
        <form onSubmit={(e) => { e.preventDefault(); verify(step.session, step.e.id); }}>
          <p>Set up two-factor sign-in. Scan this in your authenticator app, or enter the key by hand.</p>
          <img src={step.e.totp.qr_code} alt="Authenticator QR code" width={180} height={180} />
          <p className="hint">Key: <code>{step.e.totp.secret}</code></p>
          <CodeField code={code} setCode={setCode} />
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify and sign in"}</button>
        </form>
      )}
      {step.kind === "code" && (
        <form onSubmit={(e) => { e.preventDefault(); verify(step.session, step.factorId); }}>
          <p>Enter the 6-digit code from your authenticator app.</p>
          <CodeField code={code} setCode={setCode} />
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
        </form>
      )}
    </main>
  );
}

const CodeField = ({ code, setCode }: { code: string; setCode: (v: string) => void }) => (
  <>
    <label htmlFor="otp">Code</label>
    <input id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
  </>
);
