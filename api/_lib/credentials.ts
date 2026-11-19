/**
 * Keys and tokens (both sites). Served by the /api/audit function file as
 * /api/audit?module=credentials: the Vercel plan allows 12 function files and this repo has 12.
 *
 *   GET  ?module=credentials -> { actor, can_manage, today, items: [...], retired: [...] }
 *   POST ?module=credentials (every answer is the fresh view)
 *     { op: "save", key, version: null | n, label, kind, purpose, env_names, stored_in, used_by,
 *       owner, expires_on, rotated_on, rotate_every_days, note, reason }
 *     { op: "retire", key, version, reason }
 *
 * A register of WHERE each key lives and WHEN it must be replaced, never the key itself: the
 * values stay in Doppler (or Railway, or GitHub secrets). Anything that looks like a secret value
 * is refused here and again by the database, and request bodies are never logged.
 * Permissions (credential.view / credential.manage), the reason, optimistic locking and the
 * audit record are all enforced inside the admin database.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./admin-db.js";
import { MIN_REASON } from "./checks.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
};
export const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin });

export const KINDS = ["api_key", "token", "signing_key", "password", "certificate", "account"] as const;
const KEY = /^[a-z][a-z0-9_]{2,59}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENV_NAMES = /^[A-Za-z0-9_ ,()/.-]*$/;

/**
 * Same rule as credential._looks_secret in the database, checked first so a pasted key is refused
 * before it travels any further than this function.
 */
export function looksSecret(t: string): boolean {
  return /(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|sk-ant-|sk_live_|sk_test_|rk_live_|xox[abprs]-|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|-----BEGIN|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/.test(t)
    || /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/i.test(t)
    || /[A-Za-z0-9+/=_-]{40,}/.test(t);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const dateOrNull = (v: unknown): string | null | undefined => {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return undefined;
  return v;
};

type Save = {
  key: string; version: number | null; label: string; kind: string; purpose: string; env_names: string;
  stored_in: string; used_by: string; owner: string; expires_on: string | null; rotated_on: string | null;
  rotate_every_days: number | null; note: string; reason: string;
};

/** The request as the database will receive it, or the one line that says what to fix. */
export function parseSave(b: Record<string, unknown>): Save | string {
  const s = {
    key: str(b.key), label: str(b.label), kind: str(b.kind), purpose: str(b.purpose), env_names: str(b.env_names),
    stored_in: str(b.stored_in), used_by: str(b.used_by), owner: str(b.owner), note: str(b.note), reason: str(b.reason),
  };
  if (!KEY.test(s.key)) return "The short name must be 3 to 60 lowercase letters, digits or _";
  if (!(KINDS as readonly string[]).includes(s.kind)) return "Choose what kind of key this is";
  if (!s.label || !s.purpose || !s.stored_in || !s.used_by) return "Name, purpose, where it is kept and what uses it are all required";
  if (s.label.length > 100 || s.purpose.length > 400 || s.stored_in.length > 200 || s.used_by.length > 200
      || s.owner.length > 120 || s.note.length > 1000 || s.env_names.length > 300) return "One of the fields is too long";
  if (!ENV_NAMES.test(s.env_names)) return "Setting names may only contain letters, digits, _ and commas";
  if (looksSecret(Object.values(s).join(" "))) return "This looks like a secret value. Record where it is kept, never the value itself";
  const expires_on = dateOrNull(b.expires_on), rotated_on = dateOrNull(b.rotated_on);
  if (expires_on === undefined || rotated_on === undefined) return "Dates must look like 2026-12-31";
  let rotate: number | null = null;
  if (b.rotate_every_days != null && b.rotate_every_days !== "") {
    const n = Number(b.rotate_every_days);
    if (!Number.isInteger(n) || n < 7 || n > 3650) return "Rotate every 7 to 3650 days, or leave it empty";
    rotate = n;
  }
  let version: number | null = null;
  if (b.version != null) {
    const v = Number(b.version);
    if (!Number.isInteger(v) || v < 0) return "Reload the page and try again";
    version = v;
  }
  if (s.reason.length < MIN_REASON) return `Give a reason of at least ${MIN_REASON} characters`;
  if (s.reason.length > 2000) return "The reason is too long";
  return { ...s, version, expires_on, rotated_on, rotate_every_days: rotate };
}

const view = async (q: Q) => (await q("select api.credential_view() as v")).rows[0]?.v ?? null;

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in", code: e instanceof AuthError ? e.code : undefined });
    }
    const meta = requestMeta(req.headers);
    try {
      if (req.method === "GET") return res.status(200).json(await deps.withAdmin(staff, meta, view));
      if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }

      let b: Record<string, unknown>;
      try {
        b = ((typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {}) as Record<string, unknown>;
      } catch {
        return res.status(400).json({ error: "Body must be JSON" });
      }
      const op = String(b.op ?? "");
      if (op === "save") {
        const s = parseSave(b);
        if (typeof s === "string") return res.status(400).json({ error: s });
        const v = await deps.withAdmin(staff, meta, async (q) => {
          await q(`select api.credential_save($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12, $13, $14)`,
            [s.key, s.version, s.label, s.kind, s.purpose, s.env_names, s.stored_in, s.used_by, s.owner,
             s.expires_on, s.rotated_on, s.rotate_every_days, s.note, s.reason]);
          return view(q);
        });
        return res.status(200).json(v);
      }
      if (op === "retire") {
        const key = str(b.key), reason = str(b.reason), version = Number(b.version);
        if (!KEY.test(key) || !Number.isInteger(version)) return res.status(400).json({ error: "Reload the page and try again" });
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
        if (reason.length > 2000) return res.status(400).json({ error: "The reason is too long" });
        const v = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.credential_retire($1, $2, $3)", [key, version, reason]);
          return view(q);
        });
        return res.status(200).json(v);
      }
      return res.status(400).json({ error: "Unknown action" });
    } catch (e: any) {
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      if (e?.code === "42883") return res.status(503).json({ error: "Keys and tokens is not set up on this database yet: its database change has not been applied" });
      // Code and message only: never the request body.
      console.error("credentials error", e?.code, e?.message);
      return res.status(500).json({ error: "Keys and tokens could not be loaded" });
    }
  };
}
