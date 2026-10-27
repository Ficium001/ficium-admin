import { useEffect, useState } from "react";
import { resetPassword, strongPassword } from "./client";

/**
 * /reset-password?token=… — where ficium-auth sends STAFF reset links
 * (accounts in the Ficium platform institution; bank users go to the portal).
 * The token is moved out of the address bar at once and kept in memory only.
 * ficium-auth enforces policy, single use and expiry, and signs out every session.
 */
export default function ResetPassword() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [p, setP] = useState(""); const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [done, setDone] = useState(false);
  useEffect(() => { if (window.location.search) window.history.replaceState(null, "", "/reset-password"); }, []);

  const toSignIn = () => window.location.assign("/");
  return (
    <main className="shell auth">
      <h1>Ficium Admin</h1>
      {done ? (
        <section className="panel form">
          <p>Password set. You've been signed out everywhere — sign in with the new password and your authenticator code.</p>
          <div className="actions"><button className="primary" onClick={toSignIn}>Go to sign in</button></div>
        </section>
      ) : !token ? (
        <section className="panel form">
          <p>This link is incomplete. Open it exactly as it arrived, or ask for a new one from the sign-in page.</p>
          <div className="actions"><button className="primary" onClick={toSignIn}>Go to sign in</button></div>
        </section>
      ) : (
        <form className="panel form" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr("");
          try { await resetPassword(token, p); setDone(true); }
          catch (x) { setErr(x instanceof Error ? x.message : "The link is invalid or has expired. Ask for a new one."); }
          finally { setBusy(false); }
        }}>
          <h2>Choose a new password</h2>
          <p className="hint">12+ characters with upper and lower case, a number and a symbol.</p>
          <label htmlFor="rp">New password</label>
          <input id="rp" type="password" autoComplete="new-password" value={p} onChange={(e) => setP(e.target.value)} required autoFocus />
          <label htmlFor="rq">Repeat it</label>
          <input id="rq" type="password" autoComplete="new-password" value={q} onChange={(e) => setQ(e.target.value)} required />
          {q && p !== q && <p className="err">The passwords don't match.</p>}
          {err && <p className="err" role="alert">{err}</p>}
          <div className="actions"><button className="primary" disabled={busy || !strongPassword(p) || p !== q}>{busy ? "Saving…" : "Set password"}</button></div>
        </form>
      )}
    </main>
  );
}
