/**
 * Outbox dispatcher: moves admin-DB changes (Neon, app_admin) into the App DB.
 *
 *   claim (lease, SKIP LOCKED) -> apply via admin.sync_apply -> ack
 *                                         \-> on error: nack (backoff, dead-letter after 12)
 *
 * Safe to run concurrently and to retry: claims are leased, and the App DB
 * applies each event only if its aggregate version is newer than what it has
 * (older/equal => 'stale', redelivered => 'duplicate', both acked).
 */
export type Outcome = "applied" | "stale" | "duplicate";

export type OutboxEvent = {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string; // bigint, kept as text end to end
  payload: unknown;
  attempts: number;
};

export type DispatchDeps = {
  claim(limit: number, leaseSeconds: number): Promise<OutboxEvent[]>;
  apply(e: OutboxEvent): Promise<Outcome>;
  ack(id: string): Promise<void>;
  nack(id: string, error: string): Promise<void>;
  now(): number;
};

export type DispatchOptions = { batch: number; leaseSeconds: number; budgetMs: number };
export const DEFAULTS: DispatchOptions = { batch: 25, leaseSeconds: 60, budgetMs: 20_000 };

export type Stats = Record<Outcome | "claimed" | "failed" | "ackFailed" | "batches", number>;

/** Error text stored in the outbox: code + message only, never payload data. */
export function errorText(e: unknown): string {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" ? `[${err.code}] ` : "";
  const msg = typeof err?.message === "string" ? err.message : String(e);
  return (code + msg).slice(0, 500);
}

/** Apply oldest version first within each aggregate. */
export function order(events: OutboxEvent[]): OutboxEvent[] {
  return [...events].sort((a, b) => {
    const ka = `${a.aggregate_type}\u0000${a.aggregate_id}`;
    const kb = `${b.aggregate_type}\u0000${b.aggregate_id}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    const va = BigInt(a.aggregate_version), vb = BigInt(b.aggregate_version);
    return va < vb ? -1 : va > vb ? 1 : 0;
  });
}

export async function dispatch(deps: DispatchDeps, opts: DispatchOptions = DEFAULTS): Promise<Stats> {
  const stats: Stats = { claimed: 0, applied: 0, stale: 0, duplicate: 0, failed: 0, ackFailed: 0, batches: 0 };
  const start = deps.now();
  const timeLeft = () => opts.budgetMs - (deps.now() - start);

  while (timeLeft() > 0) {
    const events = await deps.claim(opts.batch, opts.leaseSeconds);
    if (events.length === 0) break;
    stats.batches++;
    stats.claimed += events.length;

    for (const e of order(events)) {
      // Out of time: leave the rest; their lease expires and the next run takes them.
      if (timeLeft() <= 0) break;
      let outcome: Outcome;
      try {
        outcome = await deps.apply(e);
      } catch (err) {
        stats.failed++;
        console.error("outbox apply failed", e.id, e.topic, errorText(err));
        await deps.nack(e.id, errorText(err)).catch(() => undefined); // lease expiry is the fallback
        continue;
      }
      stats[outcome]++;
      // If the ack is lost the event is redelivered and the App DB answers 'duplicate'.
      await deps.ack(e.id).catch(() => { stats.ackFailed++; });
    }
    if (events.length < opts.batch) break;
  }
  return stats;
}
