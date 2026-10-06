/**
 * Connects as ficium_admin_app — a role that can only read KYC settings and
 * their change log, and change a check through admin.set_kyc_check. It cannot
 * write tables directly. Never put the Supabase service key in this app.
 */
import pg from "pg";

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error("ADMIN_DATABASE_URL is not set");
  pool ??= new pg.Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
  return pool;
}
