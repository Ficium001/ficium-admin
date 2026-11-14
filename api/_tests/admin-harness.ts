import { vi } from "vitest";
import type { Staff } from "../_lib/access.js";

export function res() {
  const r: any = { code: 0, body: null, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  return r;
}

export const KJ: Staff = { email: "kj@ficium.net", sub: "cf-access:abc" };

/**
 * Fake admin DB: records every statement run inside the session and answers
 * from `answer` (by SQL substring). `fail` makes a statement throw.
 */
export function fakeAdmin(answer: Record<string, unknown> = {}, fail?: { match: string; err: unknown }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const sessions: { staff: Staff; meta: unknown }[] = [];
  const withAdmin = vi.fn(async (staff: Staff, meta: unknown, fn: any) => {
    sessions.push({ staff, meta });
    return fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (fail && sql.includes(fail.match)) throw fail.err;
      const key = Object.keys(answer).find((k) => sql.includes(k));
      return { rows: key ? [answer[key]] : [] };
    });
  });
  return { withAdmin: withAdmin as any, calls, sessions };
}
export const staffOk = (s: Staff = KJ) => vi.fn(async () => s);

/** Fake portal-api: queries answer from `state` by op; commands go to `command`. */
export function fakePortal(state: Record<string, unknown>, command: (cmd: any) => unknown = () => ({ ok: true })) {
  return vi.fn(async (path: string, body: any) => (path === "query" ? state[body.op] ?? [] : command(body)));
}
