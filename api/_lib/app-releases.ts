/**
 * Which mobile app versions are in use, read from the borrower app (its
 * /api/internal?op=admin-app), signed with APP_ADMIN_SYNC_SIGNING_KEY like the admin sync, KYC
 * and borrower reads. Totals per platform and version, and the most widespread errors the apps
 * reported (scrubbed of personal-looking data by the app and by its database): no borrower is identified.
 * The borrower app owns the numbers; this site owns the release policy. Never a database connection.
 */
import { sign } from "./portal-api.js";
import { appEndpoint } from "./app-endpoint.js";

type Env = Record<string, string | undefined>;
export type AppliedPolicy = { platform: string; min_version: string; latest_version: string; store_url: string; version: number; updated_at: string };
export type VersionUsage = { platform: string; app_version: string; active_7d: number; active_30d: number };
export type AppError = { platform: string; app_version: string; fingerprint: string; kind: string; message: string;
  location: string; route: string; borrowers_7d: number; occurrences_7d: number; last_seen_at: string };
export type AppUsage = { generated_at: string; policy: AppliedPolicy[]; versions: VersionUsage[]; errors: AppError[] };
export type AppReleases = { usage: () => Promise<AppUsage> };

export class AppReleasesError extends Error {}

const count = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

/** Keeps only the fields this site shows, typed, so a surprise in the answer cannot reach the page. */
export function cleanUsage(raw: any): AppUsage {
  const policy = Array.isArray(raw?.policy) ? raw.policy : [];
  const versions = Array.isArray(raw?.versions) ? raw.versions : [];
  const errors = Array.isArray(raw?.errors) ? raw.errors.slice(0, 50) : [];
  return {
    generated_at: String(raw?.generated_at ?? ""),
    policy: policy.map((p: any) => ({
      platform: String(p?.platform ?? ""), min_version: String(p?.min_version ?? ""), latest_version: String(p?.latest_version ?? ""),
      store_url: String(p?.store_url ?? ""), version: count(p?.version), updated_at: String(p?.updated_at ?? ""),
    })),
    versions: versions.map((v: any) => ({
      platform: String(v?.platform ?? ""), app_version: String(v?.app_version ?? ""),
      active_7d: count(v?.active_7d), active_30d: count(v?.active_30d),
    })),
    // Text written by borrowers' phones: bounded here, and only ever rendered as text.
    errors: errors.map((e: any) => ({
      platform: String(e?.platform ?? ""), app_version: String(e?.app_version ?? ""), fingerprint: String(e?.fingerprint ?? "").slice(0, 16),
      kind: String(e?.kind ?? "").slice(0, 20), message: String(e?.message ?? "").slice(0, 300),
      location: String(e?.location ?? "").slice(0, 200), route: String(e?.route ?? "").slice(0, 120),
      borrowers_7d: count(e?.borrowers_7d), occurrences_7d: count(e?.occurrences_7d), last_seen_at: String(e?.last_seen_at ?? ""),
    })),
  };
}

export function appReleases(env: Env = process.env, f: typeof fetch = fetch): AppReleases | null {
  const base = env.APP_ADMIN_SYNC_URL?.trim(), key = env.APP_ADMIN_SYNC_SIGNING_KEY?.trim();
  if (!base || !key) return null;
  return {
    usage: async () => {
      let url: URL;
      try { url = appEndpoint("admin-app", env); }
      catch (e) { throw new AppReleasesError((e as Error).message); }
      const raw = JSON.stringify({ action: "stats" });
      const r = await f(url, {
        method: "POST", body: raw, signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", "Ficium-Signature": sign(raw, key) },
      });
      const data = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw new AppReleasesError(`borrower app answered ${r.status}${data?.error ? ` (${data.error})` : ""}`);
      return cleanUsage(data?.stats);
    },
  };
}
