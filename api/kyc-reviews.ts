/**
 * KYC review queue (app site only). Needs kyc.review (super_admin, compliance).
 *
 *   GET  /api/kyc-reviews            -> { actor, cases: [...each with this site's decision, if any] }
 *   GET  /api/kyc-reviews?id=<uuid>  -> { actor, case, decision }   opening a case is audited FIRST
 *   POST /api/kyc-reviews { submission_id, decision: "verified"|"rejected", reason }
 *
 * Cases and documents come from the borrower app (signed read, 5-minute image
 * links). Decisions are recorded here (one per submission, append-only, audited)
 * and reach the borrower app through the outbox; the dispatcher is kicked at once.
 */
import { requireStaffIdentity, AuthError, type Staff } from "./_lib/access.js";
import { withAdmin, requestMeta, kickDispatch, dbError, type Q, type Meta } from "./_lib/admin-db.js";
import { appKyc, AppKycError, type AppKyc } from "./_lib/app-kyc.js";
import { MIN_REASON } from "./_lib/checks.js";
import { isUuid } from "./_lib/offers.js";
import { onlyOn } from "./_lib/site.js";

type Req = { method?: string; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status(code: number): Res; json(body: unknown): void; setHeader(k: string, v: string): void };

export type Deps = {
  requireStaff: (h: Req["headers"]) => Promise<Staff>;
  withAdmin: <T>(s: Staff, m: Meta, fn: (q: Q) => Promise<T>) => Promise<T>;
  app: AppKyc | null;
  kick: () => Promise<void>;
};

const live = (): Deps => ({ requireStaff: (h) => requireStaffIdentity(h), withAdmin, app: appKyc(), kick: kickDispatch });
const WAITING = new Set(["pending_review", "under_review"]);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const access = async (q: Q) => (await q("select api.kyc_review_access() as v")).rows[0]?.v?.actor as string;

export function makeHandler(deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader("Cache-Control", "no-store");
    let staff: Staff;
    try {
      staff = await deps.requireStaff(req.headers);
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 401;
      return res.status(status).json({ error: e instanceof Error ? e.message : "Not signed in" });
    }
    const app = deps.app;
    if (!app) return res.status(503).json({ error: "The KYC queue needs the borrower app connection (APP_ADMIN_SYNC_URL and APP_ADMIN_SYNC_SIGNING_KEY)" });
    const meta = requestMeta(req.headers);
    try {
      if (req.method === "GET") {
        const id = one(req.query?.id);
        if (id) {
          if (!isUuid(id)) return res.status(400).json({ error: "Unknown case" });
          const out = await deps.withAdmin(staff, meta, async (q) => {
            const actor = await access(q);
            const c = await app.getCase(id);
            if (!c) throw new HttpError(404, "Case not found");
            // Recorded before anything is returned; if it can't be recorded, nothing is shown.
            const v = (await q("select api.kyc_case_viewed($1, $2) as v", [id, c.client_id])).rows[0]?.v;
            return { actor, case: c, decision: v?.decision ?? null };
          });
          return res.status(200).json(out);
        }
        const out = await deps.withAdmin(staff, meta, async (q) => {
          const actor = await access(q);
          const cases = await app.list();
          const ids = cases.map((c) => c.submission_id).filter(isUuid);
          const decided = (await q("select api.kyc_case_decisions($1::uuid[]) as v", [ids])).rows[0]?.v ?? {};
          return { actor, cases: cases.map((c) => ({ ...c, decision: decided[c.submission_id] ?? null })) };
        });
        return res.status(200).json(out);
      }

      if (req.method === "POST") {
        const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as Record<string, unknown> | undefined;
        const id = b?.submission_id, decision = b?.decision;
        const reason = typeof b?.reason === "string" ? b.reason.trim() : "";
        if (!isUuid(id)) return res.status(400).json({ error: "Unknown case" });
        if (decision !== "verified" && decision !== "rejected") return res.status(400).json({ error: "Decision must be verified or rejected" });
        if (reason.length < MIN_REASON) return res.status(400).json({ error: `Give a reason of at least ${MIN_REASON} characters` });
        if (reason.length > 2000) return res.status(400).json({ error: "Reason is too long" });
        const out = await deps.withAdmin(staff, meta, async (q) => {
          await access(q);
          const c = await app.getCase(String(id));
          if (!c) throw new HttpError(404, "Case not found");
          if (!WAITING.has(c.status)) throw new HttpError(409, "This case is no longer awaiting review");
          const d = (await q("select api.kyc_case_decide($1, $2, $3, $4) as v", [id, c.client_id, decision, reason])).rows[0]?.v;
          return { decision: d };
        });
        await deps.kick();
        return res.status(200).json(out);
      }

      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (e: any) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (e instanceof SyntaxError) return res.status(400).json({ error: "Body must be JSON" });
      if (e instanceof AppKycError) {
        console.error("kyc reviews: borrower app", e.message);
        return res.status(502).json({ error: "The borrower app didn't answer. Nothing was changed. Try again shortly" });
      }
      const m = dbError(e);
      if (m) return res.status(m.status).json({ error: m.error });
      console.error("kyc reviews error", e?.code, e?.message);
      return res.status(500).json({ error: "Something went wrong. Nothing was changed" });
    }
  };
}

export default onlyOn("app", (req: Req, res: Res) => makeHandler(live())(req, res));
