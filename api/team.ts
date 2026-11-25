/**
 * GET  /api/team -> { admins, me, groups, permissions, changes }
 *      admins are joined with ficium-auth (username, MFA, locked, last sign-in); if ficium-auth
 *      cannot be reached the page still loads, with identity_error set.
 * POST /api/team
 *   request    { op, target?, args, reason }   ask for a change; a DIFFERENT admin approves it
 *              op: invite | set_roles | reactivate | reset_login | rename
 *                  | group_create | group_update | group_retire
 *   approve    { id, version, note? }         the approval IS the change (iam.approve)
 *   reject     { id, version, note }
 *   cancel     { id, version }                 withdraw your own request
 *   resend     { email }                       re-send a pending invitation (audited, one person)
 *   set_status { id, status, version, reason } suspend | disable: immediate, one person
 *
 * Approving an invite or a sign-in reset calls ficium-auth INSIDE the admin-DB transaction, as
 * the approver; if ficium-auth refuses or is unreachable the transaction rolls back and the
 * request stays pending. All rules (permissions, four-eyes, never about yourself, last super
 * admin, expiry) are enforced in the admin DB; this file only validates shape.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import {
  provisionStaffLogin, resetStaffLogin, lookupStaff, StaffLoginError,
  type ProvisionResult, type ResetResult, type StaffAccount,
} from "./_lib/staff-login.js";

type H = Record<string, string | string[] | undefined>;
type Req = { method?: string; headers: H; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: H) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  provision: (bearer: string, body: { email: string; username?: string }) => Promise<ProvisionResult>;
  reset: (bearer: string, body: { email: string; reset_mfa: boolean }) => Promise<ResetResult>;
  lookup: (bearer: string, emails: string[]) => Promise<StaffAccount[]>;
};
const live: Deps = {
  requireStaff: (h) => requireStaffIdentity(h), withAdmin,
  provision: (b, x) => provisionStaffLogin(b, x), reset: (b, x) => resetStaffLogin(b, x), lookup: (b, e) => lookupStaff(b, e),
};

export const OPS = ["invite", "set_roles", "reactivate", "reset_login", "rename", "group_create", "group_update", "group_retire"] as const;
const TARGETED = new Set(["set_roles", "reactivate", "reset_login", "rename"]);
const MIN_REASON = 10;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const version = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 1 ? n : null; };

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let staff: Staff;
    try { staff = await deps.requireStaff(req.headers); }
    catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in", code: e instanceof AuthError ? e.code : undefined });
    }
    const meta = requestMeta(req.headers);
    const bearer = String(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization ?? "");
    try {
      if (req.method === "GET") {
        type Row = { email: string } & Record<string, unknown>;
        const data = await deps.withAdmin(staff, meta, async (q) => ({
          admins: ((await q("select api.iam_list() as a")).rows[0]?.a ?? []) as Row[],
          me: (await q("select api.iam_me() as a")).rows[0]?.a ?? { permissions: [] },
          ...((await q("select api.iam_groups() as a")).rows[0]?.a ?? { groups: [], permissions: [] }),
          changes: (await q("select api.iam_change_list(null) as a")).rows[0]?.a ?? [],
        }));
        // Identity lives in ficium-auth. Joined after the DB transaction so a slow auth call
        // never holds a database connection; a failure degrades the page instead of breaking it.
        let identity_error: string | undefined;
        let accounts: StaffAccount[] = [];
        try { accounts = await deps.lookup(bearer, data.admins.map((a: Row) => a.email)); }
        catch (e) { identity_error = e instanceof Error ? e.message : "Sign-in details unavailable"; }
        const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]));
        const admins = data.admins.map((a: Row) => ({ ...a, login: byEmail.get(a.email.toLowerCase()) ?? null }));
        return res.status(200).json({ ...data, admins, email: staff.email, identity_error });
      }
      if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }

      const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
      const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
      const note = typeof b?.note === "string" ? b.note.trim() : "";

      if (b?.action === "request") {
        const op = String(b.op ?? "");
        if (!(OPS as readonly string[]).includes(op)) return res.status(400).json({ error: "Unknown change type" });
        if (TARGETED.has(op) && !isUuid(b.target)) return res.status(400).json({ error: "Unknown admin" });
        const args = b.args && typeof b.args === "object" && !Array.isArray(b.args) ? b.args : {};
        if (JSON.stringify(args).length > 6000) return res.status(400).json({ error: "Too much detail in one request" });
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
        const change = await deps.withAdmin(staff, meta, async (q) =>
          (await q("select api.iam_change_request($1, $2, $3::jsonb, $4) as a",
            [op, TARGETED.has(op) ? b.target : null, JSON.stringify(args), reason])).rows[0]?.a);
        return res.status(200).json({ change });
      }

      if (b?.action === "approve" || b?.action === "reject" || b?.action === "cancel") {
        const v = version(b.version);
        if (!isUuid(b.id) || !v) return res.status(400).json({ error: "Unknown request" });
        if (b.action === "reject" && note.length < MIN_REASON) return res.status(400).json({ error: `Say why, in at least ${MIN_REASON} characters` });
        if (b.action === "cancel") {
          const change = await deps.withAdmin(staff, meta, async (q) => (await q("select api.iam_change_cancel($1, $2) as a", [b.id, v])).rows[0]?.a);
          return res.status(200).json({ change });
        }
        if (b.action === "reject") {
          const change = await deps.withAdmin(staff, meta, async (q) => (await q("select api.iam_change_reject($1, $2, $3) as a", [b.id, v, note])).rows[0]?.a);
          return res.status(200).json({ change });
        }
        const out = await deps.withAdmin(staff, meta, async (q) => {
          const r = (await q("select api.iam_change_approve($1, $2, $3) as a", [b.id, v, note || null])).rows[0]?.a as
            { change: unknown; apply: null | { kind: string; email: string; username?: string; reset_mfa?: boolean } };
          if (!r?.apply) return { change: r?.change, result: null };
          // Throws => the approval rolls back with everything else.
          const result = r.apply.kind === "provision"
            ? await deps.provision(bearer, { email: r.apply.email, username: r.apply.username })
            : await deps.reset(bearer, { email: r.apply.email, reset_mfa: !!r.apply.reset_mfa });
          const change = (await q("select api.iam_change_record_result($1, $2::jsonb) as a", [b.id, JSON.stringify(result)])).rows[0]?.a;
          return { change, result };
        });
        return res.status(200).json(out);
      }

      if (b?.action === "resend") {
        const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
        if (!email) return res.status(400).json({ error: "Unknown admin" });
        const out = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.iam_invite_resend($1)", [email]);
          return deps.provision(bearer, { email });            // throws => audit entry rolls back too
        });
        return res.status(200).json(out);
      }

      if (b?.action === "set_status") {
        const v = version(b.version);
        if (!isUuid(b.id)) return res.status(400).json({ error: "Unknown admin" });
        if (!v) return res.status(400).json({ error: "version is required" });
        if (!["suspended", "disabled"].includes(String(b.status))) {
          return res.status(400).json({ error: "Only suspend or disable here. Reactivating needs a second admin" });
        }
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
        const admin = await deps.withAdmin(staff, meta, async (q) =>
          (await q("select api.iam_set_status($1, $2, $3, $4) as a", [b.id, b.status, v, reason])).rows[0]?.a);
        return res.status(200).json({ admin });
      }
      return res.status(400).json({ error: "Unknown action" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof StaffLoginError) return res.status(e.status).json({ error: e.message });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("team admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

export default makeHandler(live);
