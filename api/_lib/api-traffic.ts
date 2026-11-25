/**
 * API traffic (both sites). Served by the /api/audit function file as /api/audit?module=traffic: the
 * Vercel plan allows 12 function files and this repo has 12. On a plan without that limit, move the
 * default export to api/traffic.ts unchanged.
 *
 *   GET  ?module=traffic -> { actor, can_control, can_approve, channels, requests,
 *                              generated_at, window_hours, telemetry_error }
 *        each channel: the admin DB's state (enabled | paused, version, reason, who) plus `stats`
 *        (last 24 h, read from the product) and `applied` (what the product is actually enforcing)
 *   POST ?module=traffic (every answer is the fresh view, as GET without the live numbers)
 *     { op: "pause", key, version, reason }                  one admin, immediate
 *     { op: "resume_request", key, reason }                  asks; a different admin approves
 *     { op: "approve" | "reject" | "withdraw", id, version, note? }
 *
 * Which channels exist and whether they are paused lives in the admin database (pause is immediate,
 * resume is four-eyes, the admin channel can never be paused; all enforced there and audited). The
 * numbers belong to the product that carries the traffic: the borrower app is asked over its signed
 * API (app site), portal-api over its admin command channel (portal site). Never a database
 * connection to either. If the product cannot be reached the page still shows every channel and
 * its state, with telemetry_error saying why the numbers are missing.
 *
 * A change reaches the product two ways, one per site:
 *  - app site: through the outbox, right after it commits and again hourly until delivered.
 *  - portal site: as a signed command (api_channel.pause / api_channel.resume) inside the same admin-DB transaction. If portal-api refuses
 *    or is unreachable the transaction rolls back and nothing is recorded as done anywhere.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./access.js";
import { appEndpoint } from "./app-endpoint.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./admin-db.js";
import { portalApi, bearer, sign, PortalApiError, type PortalCall } from "./portal-api.js";
import { currentSite } from "./site.js";
import { MIN_REASON } from "./checks.js";
import { isUuid } from "./offers.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };
type Env = Record<string, string | undefined>;

export type Policy = { channel: string; state: "enabled" | "paused"; version: number; reason: string | null; changed_at: string; changed_by?: string };

export type ChannelStats = {
  key: string; total: number; ok: number; client_errors: number; server_errors: number; network_errors: number; blocked: number;
  p50_ms: number | null; p95_ms: number | null; last_ok_at: string | null; last_error_at: string | null; last_error: string | null;
  applied_state: "enabled" | "paused" | null; applied_version: number | null;
  hourly_total: number[]; hourly_errors: number[];
};
/** What the portal site sends portal-api: the admin DB builds it (op, command_id, maker_sub, args). */
export type Command = { op: "api_channel.pause" | "api_channel.resume"; command_id: string; maker_sub: string; args: Policy };
export type Snapshot = { generated_at: string; window_hours: number; channels: ChannelStats[] };

/** How this site reads live numbers from, and pushes a policy to, its product. */
export type Product = {
  read: (actor: string) => Promise<Snapshot>;
  /** Portal site only: apply the command now, inside the admin-DB transaction. The app site uses the outbox. */
  push: ((command: Command, actor: string) => Promise<void>) | null;
};

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  product: Product | null;
  kick: () => Promise<void>;
};

const KEY = /^[a-z][a-z0-9_.]{2,59}$/;
const HOURS = 24;
const count = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const ms = (v: unknown) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v)));
const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const state = (v: unknown): "enabled" | "paused" | null => (v === "enabled" || v === "paused" ? v : null);
const series = (v: unknown) => {
  const a = Array.isArray(v) ? v.slice(-HOURS).map(count) : [];
  return [...Array(Math.max(0, HOURS - a.length)).fill(0), ...a] as number[];
};

/** Keeps only the fields this site shows, typed and bounded, so a surprise in the answer cannot reach the page. */
export function cleanSnapshot(raw: any): Snapshot {
  const rows = Array.isArray(raw?.channels) ? raw.channels.slice(0, 100) : [];
  return {
    generated_at: iso(raw?.generated_at) ?? new Date().toISOString(),
    window_hours: HOURS,
    channels: rows.filter((c: any) => typeof c?.key === "string" && KEY.test(c.key)).map((c: any): ChannelStats => ({
      key: c.key, total: count(c.total), ok: count(c.ok), client_errors: count(c.client_errors), server_errors: count(c.server_errors),
      network_errors: count(c.network_errors), blocked: count(c.blocked), p50_ms: ms(c.p50_ms), p95_ms: ms(c.p95_ms),
      last_ok_at: iso(c.last_ok_at), last_error_at: iso(c.last_error_at),
      // Text that came from a remote system: bounded here and only ever rendered as text.
      last_error: typeof c.last_error === "string" ? c.last_error.slice(0, 300) : null,
      applied_state: state(c.applied_state), applied_version: c.applied_version == null ? null : count(c.applied_version),
      hourly_total: series(c.hourly_total), hourly_errors: series(c.hourly_errors),
    })),
  };
}

/** App site: the borrower app's signed API (/api/internal?op=admin-app), same key as the admin sync. */
export function appProduct(env: Env = process.env, f: typeof fetch = fetch): Product | null {
  const base = env.APP_ADMIN_SYNC_URL?.trim(), key = env.APP_ADMIN_SYNC_SIGNING_KEY?.trim();
  if (!base || !key) return null;
  return {
    push: null,
    read: async () => {
      const url = appEndpoint("admin-app", env);
      const raw = JSON.stringify({ action: "traffic" });
      const r = await f(url, {
        method: "POST", body: raw, signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, key) },
      });
      const data = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw new Error(`borrower app answered ${r.status}${data?.error ? ` (${data.error})` : ""}`);
      return cleanSnapshot(data?.traffic);
    },
  };
}

/** Portal site: portal-api's admin command channel (queries and one idempotent command). */
export function portalProduct(call: PortalCall): Product {
  return {
    read: async (actor) => cleanSnapshot(await call("query", { op: "traffic.overview", args: {} }, actor)),
    // command_id makes a retried call a no-op in portal-api; the policy version does the same for a replay.
    push: async (command, actor) => { await call("commands", command, actor); },
  };
}

export const live = (): Deps => ({
  requireStaff: (h) => requireStaffIdentity(h),
  withAdmin,
  product: currentSite() === "portal" ? portalProduct(portalApi()) : appProduct(),
  kick: kickDispatch,
});

const view = async (q: Q) => (await q("select api.traffic_view() as v")).rows[0]?.v ?? null;

async function readStats(deps: Deps, actor: string): Promise<{ stats: Snapshot | null; telemetry_error: string | null }> {
  if (!deps.product) return { stats: null, telemetry_error: "The connection to the product is not configured on this deployment" };
  try {
    return { stats: await deps.product.read(actor), telemetry_error: null };
  } catch (e) {
    console.warn("api traffic read failed", (e as Error)?.message);
    const why = e instanceof PortalApiError ? e.message : "The product could not be reached";
    return { stats: null, telemetry_error: `${why}, so the live numbers are missing` };
  }
}

/** Joins the admin DB's channels with the product's numbers. Unknown keys from the product are dropped, not shown. */
export function merge(v: any, stats: Snapshot | null) {
  const by = new Map((stats?.channels ?? []).map((c) => [c.key, c]));
  return {
    ...v,
    generated_at: stats?.generated_at ?? null,
    window_hours: HOURS,
    channels: (v?.channels ?? []).map((c: any) => {
      const s = by.get(c.key) ?? null;
      return {
        ...c, stats: s,
        applied: s && s.applied_state ? { state: s.applied_state, version: s.applied_version ?? 0 } : null,
      };
    }),
  };
}

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
    const actor = bearer(req.headers);
    try {
      if (req.method === "GET") {
        // Permission first (traffic.view, inside the admin DB); the product is asked only after.
        const v = await deps.withAdmin(staff, meta, view);
        const { stats, telemetry_error } = await readStats(deps, actor);
        return res.status(200).json({ ...merge(v, stats), telemetry_error });
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const op = String(b?.op ?? "");
        const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

        if (op === "pause" || op === "resume_request") {
          const key = text(b?.key), reason = text(b?.reason), version = Number(b?.version);
          if (!KEY.test(key)) return res.status(400).json({ error: "Unknown channel" });
          if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (reason.length > 2000) return res.status(400).json({ error: "The reason is too long" });
          if (op === "pause" && (!Number.isInteger(version) || version < 0)) return res.status(400).json({ error: "version is required" });
          const v = await deps.withAdmin(staff, meta, async (q) => {
            if (op === "pause") {
              const r = (await q("select api.traffic_pause($1, $2, $3) as v", [key, version, reason])).rows[0]?.v;
              if (deps.product?.push && r?.command) await deps.product.push(r.command, actor);
            } else {
              await q("select api.traffic_resume_request($1, $2)", [key, reason]);
            }
            return view(q);
          });
          if (op === "pause" && !deps.product?.push) await deps.kick();   // stop traffic now; hourly sweep retries
          return res.status(200).json(merge(v, null));
        }

        if (op === "approve" || op === "reject" || op === "withdraw") {
          const id = b?.id, version = Number(b?.version), note = text(b?.note);
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown request" });
          if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: "version is required" });
          if (op === "reject" && note.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
          if (note.length > 2000) return res.status(400).json({ error: "Note is too long" });
          const v = await deps.withAdmin(staff, meta, async (q) => {
            if (op === "approve") {
              const r = (await q("select api.traffic_resume_approve($1, $2, $3) as v", [id, version, note || null])).rows[0]?.v;
              if (deps.product?.push && r?.command) await deps.product.push(r.command, actor);
            }
            if (op === "reject") await q("select api.traffic_resume_reject($1, $2, $3)", [id, version, note]);
            if (op === "withdraw") await q("select api.traffic_resume_withdraw($1, $2)", [id, version]);
            return view(q);
          });
          if (op === "approve" && !deps.product?.push) await deps.kick();
          return res.status(200).json(merge(v, null));
        }

        return res.status(400).json({ error: "Unknown action" });
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof PortalApiError) return res.status(e.status).json({ error: e.message, code: e.code });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("api traffic admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

