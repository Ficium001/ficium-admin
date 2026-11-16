import { describe, it, expect } from "vitest";
import { blockedBy, compareVersions, isVersion, statusOf } from "./versions";

const usage = [
  { platform: "ios", app_version: "1.0.0", active_7d: 2, active_30d: 5 },
  { platform: "ios", app_version: "1.9.0", active_7d: 10, active_30d: 20 },
  { platform: "ios", app_version: "1.10.0", active_7d: 30, active_30d: 40 },
  { platform: "ios", app_version: "weird", active_7d: 1, active_30d: 1 },
  { platform: "android", app_version: "1.0.0", active_7d: 7, active_30d: 9 },
];

describe("release versions", () => {
  it("accepts only three numeric parts", () => {
    expect(isVersion("1.4.2")).toBe(true);
    for (const bad of ["1.4", "v1.4.2", "1.4.2-beta", "1..2", "", "1.4.2.1"]) expect(isVersion(bad)).toBe(false);
  });

  it("compares numerically, not as text", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("counts who a minimum would block, per platform", () => {
    expect(blockedBy("1.10.0", "ios", usage)).toEqual({ blocked: 25, active: 66 });
    expect(blockedBy("1.0.0", "ios", usage)).toEqual({ blocked: 0, active: 66 });
    expect(blockedBy("2.0.0", "android", usage)).toEqual({ blocked: 9, active: 9 });
    expect(blockedBy("not a version", "ios", usage)).toEqual({ blocked: 0, active: 66 });
  });

  it("places a version against the policy", () => {
    const p = { min_version: "1.9.0", latest_version: "1.10.0" };
    expect(statusOf("1.0.0", p)).toBe("blocked");
    expect(statusOf("1.9.0", p)).toBe("supported");
    expect(statusOf("1.10.0", p)).toBe("latest");
    expect(statusOf("1.11.0", p)).toBe("ahead");
    expect(statusOf("weird", p)).toBe("supported");
  });
});
