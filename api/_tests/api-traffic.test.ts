import { describe, it, expect, vi } from "vitest";
import { makeHandler, cleanSnapshot, merge, appProduct, portalProduct, type Deps, type Product, type Snapshot } from "../_lib/api-traffic.js";
import { route } from "../audit.js";
import { PortalApiError } from "../_lib/portal-api.js";
import { res, fakeAdmin, staffOk, KJ } from "./admin-harness.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const channel = (over: Record<string, unknown> = {}) => ({
  key: "kyc.aws_out", direction: "outbound", label: "Face checks", peer: "AWS", description: "d", pausable: true, lock_reason: null,
  state: "enabled", state_reason: null, version: 0, updated_at: "2026-11-17T00:00:00Z", updated_by: null, ...over,
});
const VIEW = { actor: "kj@ficium.net", can_control: true, can_approve: true, channels: [channel(), channel({ key: "admin.channel", pausable: false })], requests: [] };
const stats = (over: Record<string, unknown> = {}) => ({
  key: "kyc.aws_out", total: 10, ok: 8, client_errors: 1, server_errors: 1, network_errors: 0, blocked: 0, p50_ms: 120, p95_ms: 900,
  last_ok_at: "2026-11-17T01:00:00Z", last_error_at: null, last_error: null, applied_state: "enabled", applied_version: 0,
  hourly_total: [1, 2], hourly_errors: [0, 1], ...over,
});
const snap = (channels: unknown[] = [stats()]): Snapshot => cleanSnapshot({ generated_at: "2026-11-17T02:00:00Z", channels });

function setup(over: Partial<Deps> = {}, answer: Record<string, unknown> = { "api.traffic_view": { v: VIEW } }) {
  const admin = fakeAdmin(answer);
  const deps: Deps = { requireStaff: staffOk(), withAdmin: admin.withAdmin, product: { read: vi.fn(async () => snap()), push: null }, kick: vi.fn(async () => undefined), ...over };
  return { admin, deps, handler: makeHandler(deps) };
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { authorization: "Bearer tok", ...headers }, body });
const get = () => ({ method: "GET", headers: { authorization: "Bearer tok" } });

describe("GET", () => {
  it("joins every channel with the product's numbers and what it is enforcing", async () => {
    const { handler } = setup();
    const r = res(); await handler(get(), r);
    expect(r.code).toBe(200);
    const aws = r.body.channels.find((c: any) => c.key === "kyc.aws_out");
    expect(aws.stats.total).toBe(10);
    expect(aws.applied).toEqual({ state: "enabled", version: 0 });
    expect(r.body.channels.find((c: any) => c.key === "admin.channel").stats).toBeNull();   // no numbers: still listed
    expect(r.body.telemetry_error).toBeNull();
    expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("checks the permission in the admin DB before the product is asked", async () => {
    const e = Object.assign(new Error("permission denied: traffic.view"), { code: "42501" });
    const admin = fakeAdmin({}, { match: "api.traffic_view", err: e });
    const read = vi.fn();
    const { handler } = setup({ withAdmin: admin.withAdmin, product: { read, push: null } });
    const r = res(); await handler(get(), r);
    expect(r.code).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("still lists every channel when the product cannot be reached", async () => {
    const { handler } = setup({ product: { read: vi.fn(async () => { throw new Error("boom"); }), push: null } });
    const r = res(); await handler(get(), r);
    expect(r.code).toBe(200);
    expect(r.body.channels).toHaveLength(2);
    expect(r.body.telemetry_error).toMatch(/could not be reached/);
    expect(JSON.stringify(r.body)).not.toContain("boom");   // the cause stays in the logs
  });

  it("says so when the product connection is not configured", async () => {
    const { handler } = setup({ product: null });
    const r = res(); await handler(get(), r);
    expect(r.code).toBe(200);
    expect(r.body.telemetry_error).toMatch(/not configured/);
  });

  it("needs a signed-in staff member", async () => {
    const { handler } = setup({ requireStaff: vi.fn(async () => { throw new Error("no"); }) });
    const r = res(); await handler(get(), r);
    expect(r.code).toBe(401);
  });
});

describe("pause", () => {
  it("app site: pauses in the admin DB, then kicks the outbox so the app hears at once", async () => {
    const { handler, admin, deps } = setup({}, { "api.traffic_view": { v: VIEW }, "api.traffic_pause": { v: { policy: { channel: "kyc.aws_out", state: "paused", version: 1 } } } });
    const r = res();
    await handler(post({ op: "pause", key: "kyc.aws_out", version: 0, reason: "AWS key may be exposed" }), r);
    expect(r.code).toBe(200);
    const call = admin.calls.find((c) => c.sql.includes("api.traffic_pause"))!;
    expect(call.params).toEqual(["kyc.aws_out", 0, "AWS key may be exposed"]);
    expect(deps.kick).toHaveBeenCalledTimes(1);
    expect(admin.sessions[0].staff).toEqual(KJ);
  });

  it("portal site: pushes the policy inside the same admin-DB transaction", async () => {
    const policy = { channel: "public.v1_in", state: "paused", version: 1, reason: "r", changed_at: "t" };
    const command = { op: "api_channel.pause", command_id: ID, maker_sub: ID, args: policy };
    const order: string[] = [];
    const push = vi.fn(async () => { order.push("push"); });
    const base = fakeAdmin({ "api.traffic_view": { v: VIEW }, "api.traffic_pause": { v: { policy, command } } });
    const withAdmin: any = async (s: any, m: any, fn: any) => { const out = await base.withAdmin(s, m, async (q: any) => { const x = await fn(q); order.push("fn-done"); return x; }); order.push("commit"); return out; };
    const { handler, deps } = setup({ withAdmin, product: { read: vi.fn(), push } });
    const r = res();
    await handler(post({ op: "pause", key: "public.v1_in", version: 0, reason: "partner key leaked, stop it" }), r);
    expect(r.code).toBe(200);
    expect(push).toHaveBeenCalledWith(command, "tok");   // acts as the signed-in staff member
    expect(order).toEqual(["push", "fn-done", "commit"]);   // pushed before the transaction commits
    expect(deps.kick).not.toHaveBeenCalled();
  });

  it("portal site: if the portal refuses, the error reaches the admin and no view is returned (the transaction rolls back)", async () => {
    const push = vi.fn(async () => { throw new PortalApiError(502, "unreachable", "The portal could not be reached. Nothing was changed"); });
    const { handler } = setup({ product: { read: vi.fn(), push } }, { "api.traffic_view": { v: VIEW }, "api.traffic_pause": { v: { policy: { channel: "x.y_z" }, command: { op: "api_channel.pause" } } } });
    const r = res();
    await handler(post({ op: "pause", key: "public.v1_in", version: 0, reason: "partner key leaked, stop it" }), r);
    expect(r.code).toBe(502);
    expect(r.body.error).toMatch(/Nothing was changed/);
  });

  it("refuses bad input before touching the database", async () => {
    const { handler, admin } = setup();
    for (const [body, msg] of [
      [{ op: "pause", key: "Not A Key", version: 0, reason: "long enough reason" }, /Unknown channel/],
      [{ op: "pause", key: "kyc.aws_out", version: 0, reason: "short" }, /reason/],
      [{ op: "pause", key: "kyc.aws_out", reason: "long enough reason" }, /version/],
      [{ op: "pause", key: "kyc.aws_out", version: -1, reason: "long enough reason" }, /version/],
      [{ op: "pause", key: "kyc.aws_out", version: 0, reason: "x".repeat(2001) }, /too long/],
      [{ op: "nope" }, /Unknown action/],
    ] as const) {
      const r = res(); await handler(post(body), r);
      expect(r.code).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    expect(admin.calls).toHaveLength(0);
  });

  it("shows the database's own refusal for a locked channel", async () => {
    const e = Object.assign(new Error("this channel cannot be paused: it is how this site changes anything"), { code: "42501" });
    const admin = fakeAdmin({}, { match: "api.traffic_pause", err: e });
    const { handler } = setup({ withAdmin: admin.withAdmin });
    const r = res();
    await handler(post({ op: "pause", key: "admin.channel", version: 0, reason: "try to cut the admin channel" }), r);
    expect(r.code).toBe(403);
    expect(r.body.error).toMatch(/cannot be paused/);
  });
});

describe("resume (four-eyes)", () => {
  it("asking changes nothing for traffic: no push, no kick", async () => {
    const push = vi.fn();
    const { handler, deps } = setup({ product: { read: vi.fn(), push } });
    const r = res();
    await handler(post({ op: "resume_request", key: "kyc.aws_out", reason: "key rotated and tested" }), r);
    expect(r.code).toBe(200);
    expect(push).not.toHaveBeenCalled();
    expect(deps.kick).not.toHaveBeenCalled();
  });

  it("approving sends the resumed policy; the database refuses your own request", async () => {
    const policy = { channel: "kyc.aws_out", state: "enabled", version: 2 };
    const command = { op: "api_channel.resume", command_id: ID, maker_sub: ID, args: policy };
    const push = vi.fn();
    const { handler, deps } = setup({ product: { read: vi.fn(), push } }, { "api.traffic_view": { v: VIEW }, "api.traffic_resume_approve": { v: { request: { status: "approved" }, policy, command } } });
    const r = res();
    await handler(post({ op: "approve", id: ID, version: 1, note: "new key confirmed" }), r);
    expect(r.code).toBe(200);
    expect(push).toHaveBeenCalledWith(command, "tok");
    expect(deps.kick).not.toHaveBeenCalled();

    const e = Object.assign(new Error("four-eyes: you cannot approve your own request"), { code: "42501" });
    const own = setup({ withAdmin: fakeAdmin({}, { match: "api.traffic_resume_approve", err: e }).withAdmin, product: { read: vi.fn(), push } });
    const r2 = res();
    await own.handler(post({ op: "approve", id: ID, version: 1 }), r2);
    expect(r2.code).toBe(403);
    expect(r2.body.error).toMatch(/four-eyes/);
  });

  it("an expired request approves nothing and sends nothing", async () => {
    const push = vi.fn();
    const { handler } = setup({ product: { read: vi.fn(), push } }, { "api.traffic_view": { v: VIEW }, "api.traffic_resume_approve": { v: { request: { status: "expired" }, policy: null, command: null } } });
    const r = res();
    await handler(post({ op: "approve", id: ID, version: 1 }), r);
    expect(r.code).toBe(200);
    expect(push).not.toHaveBeenCalled();
  });

  it("app site: an approval kicks the outbox", async () => {
    const { handler, deps } = setup({}, { "api.traffic_view": { v: VIEW }, "api.traffic_resume_approve": { v: { request: { status: "approved" }, policy: { channel: "kyc.aws_out", state: "enabled", version: 2 } } } });
    const r = res();
    await handler(post({ op: "approve", id: ID, version: 1 }), r);
    expect(deps.kick).toHaveBeenCalledTimes(1);
  });

  it("validates ids, versions and the reason for a rejection", async () => {
    const { handler } = setup();
    for (const body of [
      { op: "approve", id: "nope", version: 1 },
      { op: "approve", id: ID },
      { op: "reject", id: ID, version: 1, note: "no" },
    ]) {
      const r = res(); await handler(post(body), r);
      expect(r.code).toBe(400);
    }
  });

  it("rejects non-JSON bodies and wrong methods", async () => {
    const { handler } = setup();
    const r = res(); await handler({ method: "POST", headers: {}, body: "{nope" }, r);
    expect(r.code).toBe(400);
    const r2 = res(); await handler({ method: "DELETE", headers: {} }, r2);
    expect(r2.code).toBe(405);
  });
});

describe("cleanSnapshot / merge", () => {
  it("keeps only typed, bounded fields and drops unknown or malformed channels", () => {
    const s = cleanSnapshot({
      generated_at: "nonsense",
      channels: [
        { key: "kyc.aws_out", total: "7", ok: -5, p95_ms: "abc", last_error: "x".repeat(1000), hourly_total: [1, 2, 3], extra: "<script>", applied_state: "weird" },
        { key: "BAD KEY", total: 1 },
        null,
      ],
    });
    expect(s.channels).toHaveLength(1);
    const c = s.channels[0];
    expect(c.total).toBe(7);
    expect(c.ok).toBe(0);
    expect(c.p95_ms).toBeNull();
    expect(c.last_error).toHaveLength(300);
    expect(c.hourly_total).toHaveLength(24);
    expect(c.hourly_total.slice(-3)).toEqual([1, 2, 3]);
    expect(c.applied_state).toBeNull();
    expect(JSON.stringify(c)).not.toContain("script");
    expect(Number.isNaN(Date.parse(s.generated_at))).toBe(false);
  });

  it("does not show channels the admin DB has not registered", () => {
    const m = merge(VIEW, snap([stats({ key: "kyc.aws_out" }), stats({ key: "rogue.channel_x" })]));
    expect(m.channels.map((c: any) => c.key)).toEqual(["kyc.aws_out", "admin.channel"]);
  });
});

describe("products", () => {
  it("app: signs the read, asks for traffic, and refuses a non-https URL", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ traffic: { channels: [stats()] } }), { status: 200 }));
    const p = appProduct({ APP_ADMIN_SYNC_URL: "https://app.example/api/internal", APP_ADMIN_SYNC_SIGNING_KEY: "k" }, f as any)!;
    const out = await p.read("tok");
    expect(out.channels[0].key).toBe("kyc.aws_out");
    const [url, init] = f.mock.calls[0] as any;
    expect(String(url)).toBe("https://app.example/api/internal?op=admin-app");
    expect(JSON.parse(init.body)).toEqual({ action: "traffic" });
    expect(init.headers["Ficium-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(p.push).toBeNull();
    const bad = appProduct({ APP_ADMIN_SYNC_URL: "http://app.example/api/internal", APP_ADMIN_SYNC_SIGNING_KEY: "k" }, f as any)!;
    await expect(bad.read("tok")).rejects.toThrow(/https/);
    expect(appProduct({}, f as any)).toBeNull();
  });

  it("app: a refusal from the app is an error, not an empty page", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 }));
    const p = appProduct({ APP_ADMIN_SYNC_URL: "https://app.example/api/internal", APP_ADMIN_SYNC_SIGNING_KEY: "k" }, f as any)!;
    await expect(p.read("tok")).rejects.toThrow(/401/);
  });

  it("portal: reads through the query channel and pushes the command exactly as built", async () => {
    const call = vi.fn(async (path: string) => (path === "query" ? { channels: [stats({ key: "public.v1_in" })] } : { ok: true }));
    const p: Product = portalProduct(call as any);
    expect((await p.read("tok")).channels[0].key).toBe("public.v1_in");
    expect(call).toHaveBeenCalledWith("query", { op: "traffic.overview", args: {} }, "tok");
    const policy = { channel: "public.v1_in", state: "paused" as const, version: 1, reason: "r", changed_at: "t" };
    const command = { op: "api_channel.pause" as const, command_id: ID, maker_sub: ID, args: policy };
    await p.push!(command, "tok");
    expect(call).toHaveBeenLastCalledWith("commands", command, "tok");   // sent exactly as the admin DB built it
  });
});

describe("function file routing", () => {
  it("?module=traffic goes to traffic, anything else is the audit log", () => {
    const audit = vi.fn(), traffic = vi.fn();
    const h = route(audit, traffic);
    const r = res();
    h({ headers: {}, query: { module: "traffic" } } as any, r); h({ headers: {}, query: {} } as any, r); h({ headers: {}, query: { module: "other" } } as any, r);
    expect(traffic).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(2);
  });
});
