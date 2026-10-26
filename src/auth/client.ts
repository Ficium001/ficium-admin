/**
 * ficium-auth from the browser, through this app's own origin: /auth/* is a
 * Vercel rewrite to ficium-auth, so there is no CORS, the CSP stays
 * connect-src 'self', and the refresh cookie (HttpOnly, path /auth/refresh)
 * is first-party — it also works on Safari/iOS.
 *
 * The access token lives in memory only (never localStorage). A reload signs
 * in silently through the refresh cookie.
 */
let token: string | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<() => void>();
export const onAuthChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const set = (t: string | null) => { token = t; listeners.forEach((f) => f()); };

export class AuthFailure extends Error { constructor(public status: number, message: string) { super(message); } }

async function post<T>(path: string, body?: unknown, auth = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`/auth/${path}`, { method: "POST", credentials: "same-origin", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = (b as { detail?: unknown }).detail;
    throw new AuthFailure(r.status, typeof d === "string" ? d : r.status === 422 ? "Check what you entered" : `Sign-in failed (${r.status})`);
  }
  return b as T;
}

type LoginResponse = { access_token?: string; mfa_required?: boolean; mfa_token?: string; must_change_password?: boolean };

/** For display/routing only — the server verifies every request. */
export type Claims = { email?: string; amr?: string[]; exp?: number };
export function claims(): Claims | null {
  if (!token) return null;
  try { return JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as Claims; } catch { return null; }
}
export const hasMfa = () => !!claims()?.amr?.includes("mfa");
export const isSignedIn = () => token !== null;

export type Step = { kind: "done"; mustChangePassword: boolean } | { kind: "mfa"; mfaToken: string };

export async function login(username: string, password: string): Promise<Step> {
  const b = await post<LoginResponse>("login", { username, password });
  if (b.mfa_required && b.mfa_token) return { kind: "mfa", mfaToken: b.mfa_token };
  set(b.access_token ?? null);
  return { kind: "done", mustChangePassword: !!b.must_change_password };
}

export async function verifyMfa(mfaToken: string, code: string): Promise<Step> {
  const clean = code.trim();
  const body = /^\d{6}$/.test(clean) ? { mfa_token: mfaToken, totp_code: clean } : { mfa_token: mfaToken, backup_code: clean };
  const b = await post<LoginResponse>("mfa/verify", body);
  set(b.access_token ?? null);
  return { kind: "done", mustChangePassword: !!b.must_change_password };
}

/** One refresh at a time; null when there is no valid session. */
export function refresh(): Promise<string | null> {
  refreshing ??= post<LoginResponse>("refresh")
    .then((b) => { set(b.access_token ?? null); return token; })
    .catch(() => { set(null); return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function logout(): Promise<void> {
  try { await post("logout", undefined, true); } finally { set(null); }
}

export const enrolStart = () => post<{ secret: string; qr_code_svg: string; expires_in: number }>("mfa/enrol", undefined, true);
export async function enrolConfirm(code: string): Promise<string[]> {
  const b = await post<{ backup_codes: string[] }>("mfa/verify-enrolment", { totp_code: code.trim() }, true);
  set(null);  // enrolment signs out every session: sign in again with MFA
  return b.backup_codes;
}
export const changePassword = (newPassword: string) => post("password/force-change", { new_password: newPassword }, true);

/**
 * fetch() for this app's /api: adds the bearer token, refreshes once on 401.
 * A 403 with code MFA_REQUIRED is surfaced so the gate can start enrolment.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const go = () => fetch(input, { ...init, credentials: "same-origin",
    headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  let r = await go();
  if (r.status === 401 && (await refresh())) r = await go();
  if (r.status === 401) set(null);
  return r;
}
