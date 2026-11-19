/**
 * Expiry alerts from the register of keys and tokens (api.credential_alerts, app_admin 0013 /
 * portal_admin 0012). Names and dates only: the register never holds a secret value.
 *
 * Used by the Services page, the Audit health banner and the hourly dispatcher's log. Expired
 * entries make health red; entries due within 14 days are warnings (amber).
 */
type Run = (sql: string) => Promise<{ rows: any[] }>;

export type Due = { label: string; due_on: string };
export type CredentialAlerts = { today: string; expired: Due[]; due_soon: Due[]; no_date: number; tracked: number };

const UNDEFINED_FUNCTION = "42883";

/** null when the register's database change is not applied yet: the drift alarm reports that. */
export async function readCredentialAlerts(run: Run, inTransaction: boolean): Promise<CredentialAlerts | null> {
  if (inTransaction) await run("savepoint credential_alerts");
  try {
    const v = (await run("select api.credential_alerts() as v")).rows[0]?.v ?? null;
    if (inTransaction) await run("release savepoint credential_alerts");
    return v as CredentialAlerts | null;
  } catch (e: any) {
    if (inTransaction) await run("rollback to savepoint credential_alerts");
    if (e?.code === UNDEFINED_FUNCTION) return null;
    throw e;
  }
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtDay = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

/** "A, B and 2 more": enough to act on without turning a banner into a list. */
export function names(list: Due[], max = 3): string {
  const shown = list.slice(0, max).map((d) => `${d.label} (${fmtDay(d.due_on)})`);
  const more = list.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** alerts: expired (red). warnings: due within 14 days (amber). */
export function credentialLines(a: CredentialAlerts | null): { alerts: string[]; warnings: string[] } {
  if (!a) return { alerts: [], warnings: [] };
  const alerts = a.expired.length
    ? [`${a.expired.length} key${a.expired.length === 1 ? " or token has" : "s or tokens have"} expired: ${names(a.expired)}. Replace ${a.expired.length === 1 ? "it" : "them"} and update Keys and tokens.`]
    : [];
  const warnings = a.due_soon.length
    ? [`Due within 14 days: ${names(a.due_soon)}. Replace before then and update Keys and tokens.`]
    : [];
  return { alerts, warnings };
}
