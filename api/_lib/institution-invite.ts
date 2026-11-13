/**
 * Email the first admin of a just-provisioned bank their set-password link, AS
 * the signed-in admin: their own bearer token is forwarded, so ficium-auth
 * independently checks they are MFA-verified platform staff. ficium-auth only
 * sends for a login that portal-api created and that was never activated; the
 * link goes to that email only and this app never sees it.
 */
export class InviteError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429 | 502, message: string) { super(message); }
}

export type InviteResult = { email_sent: boolean };

export async function inviteInstitutionAdmin(
  bearer: string, email: string,
  env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch,
): Promise<InviteResult> {
  const base = env.FICIUM_AUTH_URL;
  if (!base) throw new InviteError(502, "Sign-in service is not configured");
  let r: Response;
  try {
    r = await fetchImpl(`${base.replace(/\/+$/, "")}/auth/institution/invite`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: bearer },
      body: JSON.stringify({ email }), signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new InviteError(502, "Couldn't reach the sign-in service. The invitation was not sent");
  }
  const b = await r.json().catch(() => ({})) as { detail?: unknown; status?: string; email_sent?: boolean };
  if (r.ok && b.status === "sent") return { email_sent: !!b.email_sent };
  const msg = typeof b.detail === "string" ? b.detail : "The sign-in service refused the invitation";
  const status = ([400, 403, 404, 409, 429] as const).find((s) => s === r.status) ?? (r.status === 422 ? 400 : 502);
  throw new InviteError(status, msg);
}
