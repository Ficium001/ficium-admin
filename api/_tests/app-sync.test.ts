import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { appSyncApply, appSyncConfigured } from "../_lib/app-sync.js";

const ENV = { APP_ADMIN_SYNC_URL: "https://app.example/api/internal?op=admin-sync", APP_ADMIN_SYNC_SIGNING_KEY: "k" };
const ev = { id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", topic: "kyc.policy_changed", aggregate_type: "kyc_policy",
  aggregate_id: "kyc", aggregate_version: "7", payload: { face_match: true }, attempts: 0 } as any;
const ok = (outcome: string) => vi.fn(async () => new Response(JSON.stringify({ outcome }), { status: 200 }));

describe("admin -> app sync over HTTPS", () => {
  it("is only used when both URL and key are set", () => {
    expect(appSyncConfigured({})).toBe(false);
    expect(appSyncConfigured({ APP_ADMIN_SYNC_URL: "https://x" })).toBe(false);
    expect(appSyncConfigured(ENV)).toBe(true);
  });

  it("posts the event signed over the exact body, with the version as a number", async () => {
    const f = ok("applied");
    expect(await appSyncApply(ENV, f as any)(ev)).toBe("applied");
    const [url, init] = f.mock.calls[0] as any;
    expect(String(url)).toBe(ENV.APP_ADMIN_SYNC_URL);
    const body = JSON.parse(init.body);
    expect(body).toEqual({ event_id: ev.id, topic: ev.topic, aggregate_type: "kyc_policy", aggregate_id: "kyc",
      aggregate_version: 7, payload: { face_match: true } });
    const [, t, v1] = init.headers["Ficium-Signature"].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(v1).toBe(createHmac("sha256", "k").update(`${t}.${init.body}`).digest("hex"));
  });

  it("passes stale and duplicate through so the dispatcher acks them", async () => {
    expect(await appSyncApply(ENV, ok("stale") as any)(ev)).toBe("stale");
    expect(await appSyncApply(ENV, ok("duplicate") as any)(ev)).toBe("duplicate");
  });

  it("throws on refusal or an unknown answer, so the event is retried, never acked", async () => {
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "bad_signature" }), { status: 401 }));
    await expect(appSyncApply(ENV, refused as any)(ev)).rejects.toThrow("401 (bad_signature)");
    await expect(appSyncApply(ENV, ok("maybe") as any)(ev)).rejects.toThrow("unknown outcome");
  });

  it("refuses plain http", async () => {
    await expect(appSyncApply({ ...ENV, APP_ADMIN_SYNC_URL: "http://app.example/x" }, ok("applied") as any)(ev))
      .rejects.toThrow("https");
  });
});
