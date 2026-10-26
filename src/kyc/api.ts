export type Settings = Record<string, boolean | number | string> & { updated_at?: string };
export type Change = { id: number; changed_at: string; check_key: string; old_value: boolean; new_value: boolean; actor: string; reason: string };
export type State = { actor: string; settings: Settings | null; versions: Record<string, number>; history: Change[] };

async function call<T>(init?: RequestInit): Promise<T> {
  const r = await fetch("/api/kyc", { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body as T;
}
export const load = () => call<State>();
export const change = (key: string, value: boolean, reason: string, version: number) =>
  call<{ settings: Settings; versions: Record<string, number> }>({ method: "POST", body: JSON.stringify({ key, value, version, reason }) });
