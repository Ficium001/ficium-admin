/**
 * GET  /api/team -> { admins }
 * POST /api/team
 *   invite   { email, display_name, username, roles[], reason }
 *   resend   { email }
 *   set_roles  { id, roles[], version, reason }
 *   set_status { id, status, version, reason }   (active | suspended | disabled)
 *
 * Invite = ONE admin-DB transaction: api.iam_invite (checks iam.manage, audits)
 * then the ficium-auth login is created as the caller; if that fails, the
 * invite rolls back. Nobody can change their own roles or status (admin DB).
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { provisionStaffLogin, StaffLoginError, type ProvisionResult } from "./_lib/staff-login.js";

type H = Record<string, string | string[] | undefined>;
type Req = { method?: string; headers: H; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: H) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  provision: (bearer: string, body: { email: string; username?: string }) => Promise<ProvisionResult>;
};
const live: Deps = { requireStaff: (h) => requireStaffIdentity(h), withAdmin, provision: (b, x) => provisionStaffLogin(b, x) };

export const ROLES = ["super_admin", "compliance", "operations", "read_only"] as const;
const MIN_REASON = 10;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const roleList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((r) => (ROLES as readonly string[]).includes(r as string)) ? [...new Set(v as string[])] : null;

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
        const admins = await deps.withAdmin(staff, meta, async (q) => (await q("select api.iam_list() as a")).rows[0]?.a ?? []);
        return res.status(200).json({ admins, me: staff.email });
      }
      if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed" }); }

      const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
      const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
      const needReason = reason.length < MIN_REASON ? `Give a reason of at least ${MIN_REASON} characters` : null;

      if (b?.action === "invite") {
        const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
        const name = typeof b.display_name === "string" ? b.display_name.trim() : "";
        const username = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";
        const roles = roleList(b.roles);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email" });
        if (name.length < 2) return res.status(400).json({ error: "Enter their name" });
        if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) return res.status(400).json({ error: "Username: 3-40 letters, digits, dot, dash or underscore" });
        if (!roles) return res.status(400).json({ error: "Pick at least one role" });
        if (needReason) return res.status(400).json({ error: needReason });
        const out = await deps.withAdmin(staff, meta, async (q) => {
          const admin = (await q("select api.iam_invite($1, $2, $3, $4) as a", [email, name, roles, reason])).rows[0]?.a;
          const login = await deps.provision(bearer, { email, username });  // throws => invite rolls back
          return { admin, ...login };
        });
        return res.status(200).json(out);
      }

      if (b?.action === "resend") {
        const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
        if (!email) return res.status(400).json({ error: "Unknown admin" });
        // Permission (iam.manage), "still invited" and the audit entry are all in the admin DB.
        const out = await deps.withAdmin(staff, meta, async (q) => {
          await q("select api.iam_invite_resend($1)", [email]);
          return deps.provision(bearer, { email });            // throws => audit entry rolls back too
        });
        return res.status(200).json(out);
      }

      if (b?.action === "set_roles" || b?.action === "set_status") {
        const version = Number(b.version);
        if (!isUuid(b.id)) return res.status(400).json({ error: "Unknown admin" });
        if (!Number.isInteger(version) || version < 1) return res.status(400).json({ error: "version is required" });
        if (needReason) return res.status(400).json({ error: needReason });
        if (b.action === "set_roles") {
          const roles = roleList(b.roles);
          if (!roles) return res.status(400).json({ error: "Pick at least one role" });
          const admin = await deps.withAdmin(staff, meta, async (q) =>
            (await q("select api.iam_set_roles($1, $2, $3, $4) as a", [b.id, roles, version, reason])).rows[0]?.a);
          return res.status(200).json({ admin });
        }
        if (!["active", "suspended", "disabled"].includes(String(b.status))) return res.status(400).json({ error: "Unknown status" });
        const admin = await deps.withAdmin(staff, meta, async (q) =>
          (await q("select api.iam_set_status($1, $2, $3, $4) as a", [b.id, b.status, version, reason])).rows[0]?.a);
        return res.status(200).json({ admin });
      }
      return res.status(400).json({ error: "Unknown action" });
    } catch (e: any) {
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof StaffLoginError) return res.status(e.status).json({ error: e.message });
      if (e?.code === "23505") return res.status(409).json({ error: "That email is already on the team" });
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("team admin error", e?.code, e?.message);
      return res.status(500).json({ error: "The change could not be saved. Nothing was changed" });
    }
  };
}

export default makeHandler(live);
