/**
 * Ficium staff logins in ficium-auth, called AS the signed-in admin: their own bearer token is
 * forwarded, so ficium-auth independently checks they are MFA-verified platform staff. Links
 * (set-password, reset) go to the person's email only; this app never sees them.
 *
 *   provision  POST /auth/staff/provision {email, username}  created | resent | existing
 *   reset      POST /auth/staff/reset     {email, reset_mfa}  (only after a second admin approved)
 *   lookup     POST /auth/staff/lookup    {emails[]}          username, MFA, locked, last sign-in
 */
export class StaffLoginError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429 | 502, message: string) { super(message); }
}

export type ProvisionResult = { status: "created" | "resent" | "existing"; email_sent: boolean };
export type ResetResult = { status: "reset"; email_sent: boolean };
export type StaffAccount = {
  email: string; username: string; activated: boolean; mfa_enabled: boolean;
  locked: boolean; active: boolean; last_login_at: string | null;
};
type Env = Record<string, string | undefined>;

async function call(path: string, bearer: string, body: unknown, env: Env, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const base = env.FICIUM_AUTH_URL;
  if (!base) throw new StaffLoginError(502, "Sign-in service is not configured");
  let r: Response;
  try {
    r = await fetchImpl(`${base.replace(/\/+$/, "")}/auth/staff/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new StaffLoginError(502, "Couldn't reach the sign-in service. Nothing was changed");
  }
  const b = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (r.ok) return b;
  const msg = typeof b.detail === "string" ? b.detail : "The sign-in service refused the request";
  const status = ([400, 403, 404, 409, 429] as const).find((s) => s === r.status) ?? (r.status === 422 ? 400 : 502);
  throw new StaffLoginError(status, msg);
}

export async function provisionStaffLogin(
  bearer: string, body: { email: string; username?: string },
  env: Env = process.env, fetchImpl: typeof fetch = fetch,
): Promise<ProvisionResult> {
  const b = await call("provision", bearer, body, env, fetchImpl);
  if (b.status === "created" || b.status === "resent" || b.status === "existing") return { status: b.status, email_sent: !!b.email_sent };
  throw new StaffLoginError(502, "The sign-in service gave an unexpected answer");
}

export async function resetStaffLogin(
  bearer: string, body: { email: string; reset_mfa: boolean },
  env: Env = process.env, fetchImpl: typeof fetch = fetch,
): Promise<ResetResult> {
  const b = await call("reset", bearer, body, env, fetchImpl);
  if (b.status === "reset") return { status: "reset", email_sent: !!b.email_sent };
  throw new StaffLoginError(502, "The sign-in service gave an unexpected answer");
}

export async function lookupStaff(
  bearer: string, emails: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch,
): Promise<StaffAccount[]> {
  if (emails.length === 0) return [];
  const b = await call("lookup", bearer, { emails: emails.slice(0, 200) }, env, fetchImpl);
  return Array.isArray(b.accounts) ? (b.accounts as StaffAccount[]) : [];
}
