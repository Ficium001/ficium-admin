/**
 * Create (or re-send) a Ficium staff login in ficium-auth, AS the signed-in
 * admin: their own bearer token is forwarded, so ficium-auth independently
 * checks they are MFA-verified platform staff. The set-password link goes to
 * the invitee's email only; this app never sees it.
 */
export class StaffLoginError extends Error {
  constructor(public status: 400 | 403 | 409 | 429 | 502, message: string) { super(message); }
}

export type ProvisionResult = { status: "created" | "resent"; email_sent: boolean };

export async function provisionStaffLogin(
  bearer: string, body: { email: string; username?: string },
  env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch,
): Promise<ProvisionResult> {
  const base = env.FICIUM_AUTH_URL;
  if (!base) throw new StaffLoginError(502, "Sign-in service is not configured");
  let r: Response;
  try {
    r = await fetchImpl(`${base.replace(/\/+$/, "")}/auth/staff/provision`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new StaffLoginError(502, "Couldn't reach the sign-in service. Nothing was changed");
  }
  const b = await r.json().catch(() => ({})) as { detail?: unknown; status?: string; email_sent?: boolean };
  if (r.ok && (b.status === "created" || b.status === "resent")) return { status: b.status, email_sent: !!b.email_sent };
  const msg = typeof b.detail === "string" ? b.detail : "The sign-in service refused the request";
  const status = ([400, 403, 409, 429] as const).find((s) => s === r.status) ?? (r.status === 422 ? 400 : 502);
  throw new StaffLoginError(status, msg);
}
