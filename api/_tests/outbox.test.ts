import { describe, it, expect, vi } from "vitest";
import { dispatch, order, errorText, type DispatchDeps, type OutboxEvent } from "../_lib/outbox.js";
import { makeHandler, authorised } from "../outbox-dispatch.js";
import { stripSslParams } from "../_lib/sync-db.js";

const ev = (id: string, agg: string, v: number, topic = "offer.listing_upserted"): OutboxEvent => ({
  id, topic, aggregate_type: "offer", aggregate_id: agg, aggregate_version: String(v), payload: { id: agg }, attempts: 1,
});

function deps(batches: OutboxEvent[][], apply: DispatchDeps["apply"] = async () => "applied") {
  let t = 0;
  const d = {
    claim: vi.fn(async () => batches.shift() ?? []),
    apply: vi.fn(apply),
    ack: vi.fn(async () => undefined),
    nack: vi.fn(async () => undefined),
    now: () => t,
    tick: (ms: number) => { t += ms; },
  };
  return d;
}

describe("dispatch", () => {
  it("applies oldest version first per aggregate and acks every outcome", async () => {
    const d = deps([[ev("e3", "A", 3), ev("e1", "A", 1), ev("e2", "B", 7)]]);
    const s = await dispatch(d, { batch: 25, leaseSeconds: 60, budgetMs: 1000 });
    expect(d.apply.mock.calls.map(c => c[0].id)).toEqual(["e1", "e3", "e2"]);
    expect(d.ack).toHaveBeenCalledTimes(3);
    expect(s).toMatchObject({ claimed: 3, applied: 3, failed: 0, batches: 1 });
  });

  it("compares versions as bigints, not strings", () => {
    expect(order([ev("x", "A", 10), ev("y", "A", 9)]).map(e => e.id)).toEqual(["y", "x"]);
    const big = { ...ev("z", "A", 0), aggregate_version: "9007199254740993" };
    expect(order([big, ev("w", "A", 2)]).map(e => e.id)).toEqual(["w", "z"]);
  });

  it("nacks a failed event with code + message only, and carries on", async () => {
    const d = deps([[ev("bad", "A", 1), ev("good", "B", 1)]], async e => {
      if (e.id === "bad") throw Object.assign(new Error("invalid input value for enum"), { code: "22P02" });
      return "applied";
    });
    const s = await dispatch(d, { batch: 25, leaseSeconds: 60, budgetMs: 1000 });
    expect(d.nack).toHaveBeenCalledWith("bad", "[22P02] invalid input value for enum");
    expect(d.ack).toHaveBeenCalledWith("good");
    expect(d.ack).not.toHaveBeenCalledWith("bad");
    expect(s).toMatchObject({ applied: 1, failed: 1 });
  });

  it("counts stale and duplicate deliveries and still acks them", async () => {
    const out = ["stale", "duplicate"] as const;
    let i = 0;
    const d = deps([[ev("a", "A", 1), ev("b", "B", 1)]], async () => out[i++]);
    const s = await dispatch(d, { batch: 25, leaseSeconds: 60, budgetMs: 1000 });
    expect(s).toMatchObject({ stale: 1, duplicate: 1, applied: 0 });
    expect(d.ack).toHaveBeenCalledTimes(2);
  });

  it("does not nack when only the ack fails (redelivery is answered 'duplicate')", async () => {
    const d = deps([[ev("a", "A", 1)]]);
    d.ack.mockRejectedValueOnce(new Error("connection reset"));
    const s = await dispatch(d, { batch: 25, leaseSeconds: 60, budgetMs: 1000 });
    expect(d.nack).not.toHaveBeenCalled();
    expect(s).toMatchObject({ applied: 1, ackFailed: 1 });
  });

  it("keeps claiming full batches and stops on a short one", async () => {
    const d = deps([[ev("a", "A", 1), ev("b", "B", 1)], [ev("c", "C", 1)], [ev("never", "D", 1)]]);
    const s = await dispatch(d, { batch: 2, leaseSeconds: 60, budgetMs: 1000 });
    expect(d.claim).toHaveBeenCalledTimes(2);
    expect(s).toMatchObject({ claimed: 3, batches: 2 });
  });

  it("stops at the time budget and leaves the rest leased for the next run", async () => {
    const d = deps([[ev("a", "A", 1), ev("b", "B", 1), ev("c", "C", 1)]]);
    d.apply.mockImplementation(async () => { d.tick(600); return "applied"; });
    const s = await dispatch(d, { batch: 25, leaseSeconds: 60, budgetMs: 1000 });
    expect(s.applied).toBe(2);
    expect(d.nack).not.toHaveBeenCalled();
  });

  it("never puts payload data into stored errors", () => {
    expect(errorText({ message: "x".repeat(900) })).toHaveLength(500);
    expect(errorText("plain")).toBe("plain");
  });
});

function res() {
  const r: any = { code: 0, body: null, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  return r;
}
const SECRET = "s".repeat(40);

describe("GET /api/outbox-dispatch", () => {
  it("fails closed when CRON_SECRET is missing or short", async () => {
    for (const env of [{}, { CRON_SECRET: "short" }]) {
      const run = vi.fn(); const r = res();
      await makeHandler({ run, env })({ method: "GET", headers: { authorization: "Bearer short" } }, r);
      expect(r.code).toBe(503); expect(run).not.toHaveBeenCalled();
    }
  });
  it("rejects a missing or wrong bearer token without running", async () => {
    for (const authorization of [undefined, "Bearer nope", SECRET, `Basic ${SECRET}`]) {
      const run = vi.fn(); const r = res();
      await makeHandler({ run, env: { CRON_SECRET: SECRET } })({ method: "GET", headers: { authorization } }, r);
      expect(r.code).toBe(401); expect(run).not.toHaveBeenCalled();
    }
  });
  it("only accepts GET", async () => {
    const run = vi.fn(); const r = res();
    await makeHandler({ run, env: { CRON_SECRET: SECRET } })({ method: "POST", headers: { authorization: `Bearer ${SECRET}` } }, r);
    expect(r.code).toBe(405); expect(run).not.toHaveBeenCalled();
  });
  it("runs and returns stats; hides internals on failure", async () => {
    const ok = res();
    await makeHandler({ run: async () => ({ claimed: 1 } as any), env: { CRON_SECRET: SECRET } })(
      { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }, ok);
    expect(ok.code).toBe(200); expect(ok.body).toEqual({ claimed: 1 }); expect(ok.headers["Cache-Control"]).toBe("no-store");
    const bad = res();
    await makeHandler({ run: async () => { throw new Error("password authentication failed for user x"); }, env: { CRON_SECRET: SECRET } })(
      { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }, bad);
    expect(bad.code).toBe(500); expect(JSON.stringify(bad.body)).not.toContain("password");
  });
  it("compares the secret in constant time over equal-length digests", () => {
    expect(authorised(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(authorised(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  });
});

describe("stripSslParams", () => {
  it("removes ssl* and channel_binding so code decides TLS", () => {
    const u = stripSslParams("postgresql://u:p@host/db?sslmode=disable&sslrootcert=x&channel_binding=require&application_name=w");
    expect(u).not.toMatch(/ssl|channel_binding/); expect(u).toContain("application_name=w");
  });
});
