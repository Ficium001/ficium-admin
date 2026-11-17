import type { Channel } from "./api";

export type Health = { text: string; pill: "" | "ok" | "warn" | "danger" };

/** Calls that failed on our side or the other side's: server errors and no answer. 4xx are refusals, shown apart. */
export const failures = (s: { server_errors: number; network_errors: number }) => s.server_errors + s.network_errors;
export const failRate = (s: { total: number; server_errors: number; network_errors: number }) => (s.total === 0 ? 0 : failures(s) / s.total);

/** One word for how a channel is doing. Paused and "not yet in force" come before traffic, which cannot be judged then. */
export function health(c: Pick<Channel, "state" | "version" | "applied" | "stats">): Health {
  if (c.state === "paused") {
    return c.applied && c.applied.version >= c.version
      ? { text: "Paused", pill: "danger" }
      : { text: "Paused, not yet in force", pill: "warn" };
  }
  if (c.applied && c.applied.version < c.version) return { text: "Resuming, not yet in force", pill: "warn" };
  const s = c.stats;
  if (!s) return { text: "No numbers", pill: "" };
  if (s.total === 0) return { text: "No traffic", pill: "" };
  const r = failRate(s);
  // A handful of calls cannot call a channel failing: three failed calls in four is not an outage.
  if (s.total >= 20 && r >= 0.1) return { text: "Failing", pill: "danger" };
  if (s.total >= 20 && r >= 0.02) return { text: "Degraded", pill: "warn" };
  if (failures(s) > 0 && s.total < 20) return { text: "Few calls, some failed", pill: "warn" };
  return { text: "Healthy", pill: "ok" };
}

export const percent = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.001 ? 2 : 1)}%`;
export const num = (n: number) => n.toLocaleString("en-GB");
export const millis = (n: number | null) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
