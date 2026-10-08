/**
 * Hosted login against a dedicated Supabase Auth project (REST, no SDK).
 * Only the project URL and its public anon key live in the browser. The API
 * re-verifies every token server-side; nothing here is trusted for access.
 */
const URL_ = (import.meta.env.VITE_AUTH_URL as string | undefined)?.replace(/\/+$/, "");
const ANON = import.meta.env.VITE_AUTH_ANON_KEY as string | undefined;
export const AUTH_ENABLED = Boolean(URL_ && ANON);

export type Factor = { id: string; factor_type: string; status: string };
export type Session = { access_token: string; user?: { email?: string; factors?: Factor[] } };
const KEY = "fa.session";

export function getSession(): Session | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null"); } catch { return null; }
}
const save = (s: Session) => sessionStorage.setItem(KEY, JSON.stringify({ access_token: s.access_token, user: s.user }));
export const clearSession = () => sessionStorage.removeItem(KEY);

function claims(token: string): { aal?: string; exp?: number } {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}
/** UI hint only. The server decides. */
export function isReady(s: Session | null): boolean {
  if (!s) return false;
  const c = claims(s.access_token);
  return c.aal === "aal2" && (c.exp ?? 0) * 1000 > Date.now();
}

async function auth<T>(path: string, token: string | null, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const r = await fetch(`${URL_}/auth/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", apikey: ANON!, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg ?? j.error_description ?? j.message ?? `Sign-in failed (${r.status})`);
  return j as T;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const s = await auth<Session>("/token?grant_type=password", null, { email, password });
  save(s); return s;
}
export const totpFactors = (s: Session) => (s.user?.factors ?? []).filter((f) => f.factor_type === "totp" && f.status === "verified");

export type Enrollment = { id: string; totp: { qr_code: string; secret: string } };
export const enroll = (s: Session) =>
  auth<Enrollment>("/factors", s.access_token, { factor_type: "totp", friendly_name: `ficium-admin-${Date.now()}` });

/** Challenge + verify; the response is a new session upgraded to aal2. */
export async function verifyCode(s: Session, factorId: string, code: string): Promise<Session> {
  const ch = await auth<{ id: string }>(`/factors/${factorId}/challenge`, s.access_token, {});
  const next = await auth<Session>(`/factors/${factorId}/verify`, s.access_token, { challenge_id: ch.id, code });
  const merged = { ...next, user: next.user ?? s.user };
  save(merged); return merged;
}
