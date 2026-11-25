import { describe, it, expect, vi } from "vitest";
import { appEndpoint, appEndpointProblem, AppEndpointError } from "../_lib/app-endpoint.js";
import { appSyncApply } from "../_lib/app-sync.js";

const env = (url: string) => ({ APP_ADMIN_SYNC_URL: url, APP_ADMIN_SYNC_SIGNING_KEY: "k" });

describe("borrower app endpoint", () => {
  it("sets the operation itself, with or without ?op= in the variable", () => {
    for (const u of ["https://app.example/api/internal", "https://app.example/api/internal?op=admin-sync",
                     "https://app.example/api/internal/", "https://app.example/api/internal?op=admin-kyc"]) {
      expect(String(appEndpoint("admin-sync", env(u)))).toBe("https://app.example/api/internal?op=admin-sync");
      expect(String(appEndpoint("admin-app", env(u)))).toBe("https://app.example/api/internal?op=admin-app");
    }
  });

  it("refuses what it cannot repair, and says what is wrong", () => {
    expect(appEndpointProblem(env("http://app.example/api/internal"))).toMatch(/https/);
    expect(appEndpointProblem(env("https://app.example"))).toMatch(/\/api\/internal/);
    expect(appEndpointProblem(env("https://app.example/api/admin-sync"))).toMatch(/\/api\/internal/);
    expect(appEndpointProblem(env("not a url"))).toMatch(/valid URL/);
    expect(() => appEndpoint("admin-sync", env("https://app.example"))).toThrow(AppEndpointError);
    expect(() => appEndpoint("admin-sync", {})).toThrow(/not set/);
  });

  it("is quiet when unset (reported elsewhere) or fine", () => {
    expect(appEndpointProblem({})).toBeNull();
    expect(appEndpointProblem(env("https://app.example/api/internal"))).toBeNull();
    expect(appEndpointProblem(env("http://localhost:3000/api/internal"))).toBeNull();
  });

  it("2026-11-25: the sync still reaches op=admin-sync when the variable lost its query", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ outcome: "applied" }), { status: 200 }));
    const ev = { id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", topic: "kyc.policy_changed", aggregate_type: "kyc_policy",
      aggregate_id: "global", aggregate_version: "2", payload: {}, attempts: 0 } as any;
    expect(await appSyncApply(env("https://app.example/api/internal"), f as any)(ev)).toBe("applied");
    expect(String((f.mock.calls[0] as any)[0])).toBe("https://app.example/api/internal?op=admin-sync");
  });
});
