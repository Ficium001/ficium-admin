/**
 * Version arithmetic for the App releases page. The admin database enforces
 * the same rules; these are for showing the effect of a change before asking.
 */
export type VersionUsage = { platform: string; app_version: string; active_7d: number; active_30d: number };

const VERSION = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/;
export const isVersion = (v: string) => VERSION.test(v);

/** Negative when a is older than b. Numeric, so 1.10.0 is newer than 1.9.0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Borrowers active in the last 30 days on one platform, and how many of them a
 * minimum version would block. Versions that cannot be read are counted as
 * active but never as blocked, exactly as the apps treat them.
 */
export function blockedBy(minVersion: string, platform: string, usage: VersionUsage[]): { blocked: number; active: number } {
  let blocked = 0, active = 0;
  for (const u of usage) {
    if (u.platform !== platform) continue;
    active += u.active_30d;
    if (isVersion(u.app_version) && isVersion(minVersion) && compareVersions(u.app_version, minVersion) < 0) blocked += u.active_30d;
  }
  return { blocked, active };
}

export type VersionStatus = "blocked" | "supported" | "latest" | "ahead";

/** Where one version stands against the policy. "ahead" = newer than the recorded latest (a store release not yet recorded). */
export function statusOf(version: string, policy: { min_version: string; latest_version: string }): VersionStatus {
  if (!isVersion(version)) return "supported";
  if (compareVersions(version, policy.min_version) < 0) return "blocked";
  const d = compareVersions(version, policy.latest_version);
  return d > 0 ? "ahead" : d === 0 ? "latest" : "supported";
}
