import { describe, it, expect } from "vitest";
import { health, failRate, percent, millis } from "./health";
import type { Channel, Stats } from "./api";

const stats = (o: Partial<Stats> = {}): Stats => ({
  key: "k.k_k", total: 100, ok: 100, client_errors: 0, server_errors: 0, network_errors: 0, blocked: 0, p50_ms: 1, p95_ms: 2,
  last_ok_at: null, last_error_at: null, last_error: null, applied_state: "enabled", applied_version: 0, hourly_total: [], hourly_errors: [], ...o,
});
const ch = (o: Partial<Pick<Channel, "state" | "version" | "applied" | "stats">> = {}) =>
  ({ state: "enabled", version: 0, applied: { state: "enabled", version: 0 }, stats: stats(), ...o }) as Pick<Channel, "state" | "version" | "applied" | "stats">;

describe("health", () => {
  it("healthy, degraded, failing by failure rate (server errors and no answer, not 4xx)", () => {
    expect(health(ch()).text).toBe("Healthy");
    expect(health(ch({ stats: stats({ server_errors: 3 }) })).text).toBe("Degraded");
    expect(health(ch({ stats: stats({ server_errors: 6, network_errors: 6 }) })).text).toBe("Failing");
    expect(health(ch({ stats: stats({ client_errors: 90 }) })).text).toBe("Healthy");   // refusals are the caller's doing
  });
  it("does not call a channel failing on a handful of calls", () => {
    expect(health(ch({ stats: stats({ total: 4, server_errors: 3 }) })).text).toBe("Few calls, some failed");
    expect(health(ch({ stats: stats({ total: 0 }) })).text).toBe("No traffic");
    expect(health(ch({ stats: null })).text).toBe("No numbers");
  });
  it("paused is paused, but says when the product has not heard yet", () => {
    expect(health(ch({ state: "paused", version: 1, applied: { state: "paused", version: 1 } }))).toEqual({ text: "Paused", pill: "danger" });
    expect(health(ch({ state: "paused", version: 1, applied: { state: "enabled", version: 0 } })).text).toBe("Paused, not yet in force");
    expect(health(ch({ state: "paused", version: 1, applied: null })).text).toBe("Paused, not yet in force");
  });
  it("a resumed channel the product has not heard about is flagged", () => {
    expect(health(ch({ state: "enabled", version: 2, applied: { state: "paused", version: 1 } })).text).toBe("Resuming, not yet in force");
  });
});
describe("format", () => {
  it("rates and times", () => {
    expect(failRate({ total: 0, server_errors: 0, network_errors: 0 })).toBe(0);
    expect(percent(0.025)).toBe("2.5%");
    expect(millis(null)).toBe("—");
    expect(millis(950)).toBe("950 ms");
    expect(millis(2500)).toBe("2.5 s");
  });
});
