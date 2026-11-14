/**
 * Four-eyes "show the change": for every portal change request, what the
 * record looks like NOW (read from portal-api when the request is made) and
 * what it will be after approval, as plain rows a person can check.
 *
 * snapshotAndRows() runs when a request is made: `before` is frozen in the
 * admin DB with the rows. At approval the backend reads the portal again and
 * the admin DB refuses (api.change_request_confirm_unchanged) if `before` no
 * longer matches, so nobody approves a change against a record that moved.
 * Snapshots are plain JSON objects built only from portal state, never from
 * the browser.
 */
import type { PortalCall } from "./portal-api.js";

export type ChangeRow = { field: string; before: string | null; after: string | null };
export type Change = { rows: ChangeRow[]; described: true };
export type Snapshot = Record<string, unknown>;

type Ent = { module_code: string; status: string; plan_tier: string | null; valid_to: string | null };
type Inst = {
  institution_id: string; name: string; approved: boolean; suspended_at: string | null;
  active_members: number | string; entitlements: Ent[];
};
type Rule = {
  rule_id: string; institution_id: string | null; product_code: string | null; rate: string;
  effective_from: string; ended_on: string | null;
};
type Application = {
  request_id: string; status: string; institution_name: string; contact_name: string; contact_email: string;
};

export class ChangeError extends Error {}

const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
export const pct = (fraction: unknown) => {
  const n = Number(fraction);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%` : String(fraction);
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
const instStatus = (i: Inst) => (i.suspended_at ? "Suspended" : i.approved ? "Active" : "Not yet approved");
const APP_STATUS: Record<string, string> = {
  submitted: "Submitted", in_review: "In review", info_requested: "Information requested",
  approved: "Approved, awaiting contract", rejected: "Rejected", provisioned: "Provisioned",
};
const MODEL: Record<string, string> = { saas: "SaaS", paas: "PaaS", on_prem: "On premises" };

async function institution(portal: PortalCall, actor: string, iid: string): Promise<Inst> {
  const all = (await portal("query", { op: "institutions.list", args: {} }, actor)) as Inst[];
  const i = all.find((x) => x.institution_id === iid);
  if (!i) throw new ChangeError("That bank was not found in the portal");
  return i;
}

/** The state that matters to this op, read from the portal. Deterministic: same portal state, same JSON. */
export async function snapshot(op: string, args: Record<string, unknown>, portal: PortalCall, actor: string): Promise<Snapshot> {
  switch (op) {
    case "institution.approve":
    case "institution.suspend": {
      const i = await institution(portal, actor, String(args.institution_id));
      return { status: instStatus(i) };
    }
    case "institution.invite_admin": {
      const i = await institution(portal, actor, String(args.institution_id));
      return { active_members: Number(i.active_members) };
    }
    case "entitlement.set": {
      const i = await institution(portal, actor, String(args.institution_id));
      const e = (i.entitlements ?? []).find((x) => x.module_code === args.module_code);
      return e ? { exists: true, status: e.status, plan_tier: e.plan_tier, valid_to: day(e.valid_to) } : { exists: false };
    }
    case "commission.set": {
      const rules = (await portal("query", { op: "commission.rules", args: {} }, actor)) as Rule[];
      const r = rules.find((x) => x.ended_on == null
        && (x.institution_id ?? null) === (args.institution_id ?? null)
        && (x.product_code ?? null) === (args.product_code ?? null));
      return r ? { exists: true, rule_id: r.rule_id, rate: String(r.rate), effective_from: day(r.effective_from) } : { exists: false };
    }
    case "commission.end": {
      const rules = (await portal("query", { op: "commission.rules", args: {} }, actor)) as Rule[];
      const r = rules.find((x) => x.rule_id === args.rule_id);
      if (!r) throw new ChangeError("That commission rule was not found in the portal");
      return { rate: String(r.rate), effective_from: day(r.effective_from), ended_on: day(r.ended_on) };
    }
    case "institution.provision": {
      const apps = (await portal("query", { op: "access_requests.list", args: { status: "open" } }, actor)) as Application[];
      const a = apps.find((x) => x.request_id === args.request_id);
      if (!a) throw new ChangeError("That application is no longer open");
      return { status: a.status, institution_name: a.institution_name, contact_name: a.contact_name, contact_email: a.contact_email };
    }
    default:
      throw new ChangeError("Unknown change");
  }
}

/** Plain rows: Field | Now | After approval. `before: null` means "nothing yet". */
export function rows(op: string, args: Record<string, unknown>, s: Snapshot): ChangeRow[] {
  const a = (k: string) => (args[k] == null ? null : String(args[k]));
  switch (op) {
    case "institution.approve":
      return [{ field: "Status", before: String(s.status), after: "Active" }];
    case "institution.suspend":
      return [{ field: "Status", before: String(s.status), after: "Suspended" },
              { field: "Effect", before: null, after: "Its users can no longer sign in or bid" }];
    case "institution.invite_admin":
      return [{ field: "Active users", before: String(s.active_members), after: String(s.active_members) },
              { field: "First administrator", before: "None", after: `${a("full_name")} (${a("email")})` }];
    case "entitlement.set": {
      const had = s.exists === true;
      return [
        { field: "Module", before: had ? a("module_code") : "Not granted", after: a("module_code") },
        { field: "Status", before: had ? cap(String(s.status)) : null, after: cap(String(args.status)) },
        { field: "Plan", before: had && s.plan_tier ? cap(String(s.plan_tier)) : null, after: cap(String(args.plan_tier ?? "standard")) },
        { field: "Valid until", before: had ? (s.valid_to ? String(s.valid_to) : "No end date") : null,
          after: args.valid_to ? day(args.valid_to) : "No end date" },
      ];
    }
    case "commission.set": {
      const had = s.exists === true;
      const out: ChangeRow[] = [
        { field: "Rate", before: had ? pct(s.rate) : "No rule of its own", after: pct(args.rate) },
        { field: "Applies from", before: had ? String(s.effective_from) : null, after: day(args.effective_from) },
      ];
      if (had) out.push({ field: `Current ${pct(s.rate)} rule ends`, before: "Open", after: day(args.effective_from) });
      return out;
    }
    case "commission.end":
      return [{ field: "Rate", before: pct(s.rate), after: pct(s.rate) },
              { field: "In force from", before: String(s.effective_from), after: String(s.effective_from) },
              { field: "Ends on", before: s.ended_on ? String(s.ended_on) : "Open", after: day(args.ended_on) }];
    case "institution.provision":
      return [
        { field: "Application", before: APP_STATUS[String(s.status)] ?? String(s.status), after: "Provisioned" },
        { field: "New bank", before: null, after: String(s.institution_name) },
        { field: "First administrator", before: null, after: `${s.contact_name} (${s.contact_email})` },
        { field: "Contract", before: null, after: a("contract_reference") },
        { field: "Deployment", before: null, after: MODEL[String(args.deployment_model)] ?? a("deployment_model") },
      ];
    default:
      throw new ChangeError("Unknown change");
  }
}

/** For a new request: freeze what it is now and what it will be. */
export async function describeChange(op: string, args: Record<string, unknown>, portal: PortalCall, actor: string) {
  const before = await snapshot(op, args, portal, actor);
  if (op === "institution.provision" && before.status !== "approved") {
    throw new ChangeError("Only an approved application can be provisioned");
  }
  const change: Change = { rows: rows(op, args, before), described: true };
  return { before, change };
}
