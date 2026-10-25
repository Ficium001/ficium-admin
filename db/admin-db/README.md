# Ficium admin databases

Two isolated PostgreSQL databases backing the two admin portals:

| Database       | Serves                    | Contents today                                             |
|----------------|---------------------------|------------------------------------------------------------|
| `app_admin`    | Borrower-app admin portal | IAM, audit, outbox, platform settings, KYC policy, offers  |
| `portal_admin` | Institution-portal admin  | IAM, audit, outbox (domain migrations to follow)           |

Hosted on Neon project `Ficium_admin` (`summer-heart-62588363`) for the
working model. Everything is plain PostgreSQL 16+, no extensions and no
vendor features, so moving provider or region is: `pg_dump` → `pg_restore`
→ change one connection string per service.

## Hard rule before go-live

**No real customer, institution or production data in these databases until
the hosting meets: paid plan, ≥ 7 days point-in-time restore (target 30),
IP allowlist restricted to the admin backends, and a documented region /
cross-border transfer basis.** The Neon free tier gives 6 hours of history.

## Design

- **The backend has zero table access.** Its role (`<db>_api`) can only
  EXECUTE `api.*` functions. Each function checks permissions, validates,
  writes the change, writes the audit record and, if other systems need to
  know, writes an outbox event — all in one transaction.
- **Identity stays in ficium-auth.** Admins are invited by email; the
  ficium-auth `sub` is bound on first sign-in. Roles and permissions (RBAC)
  live here. Self-service changes to your own roles or status are refused.
- **Per-request session, bound to the transaction.** Every request runs:
  ```
  BEGIN;
  SELECT api.begin_session(sub, email, request_id, client_ip, user_agent);
  SELECT api.<operation>(...);
  COMMIT;
  ```
  The session row is tied to `txid_current()`, so a forged
  `ficium.session_id` or a value left on a pooled connection is useless.
- **Audit log is append-only and hash-chained.** UPDATE/DELETE/TRUNCATE
  are blocked by trigger; every row carries `sha256(prev_hash | row)`.
  `SELECT * FROM audit.verify_chain();` recomputes the chain and reports the
  first tampered position. Tested: a superuser edit with triggers disabled
  is detected.
- **Maker-checker** on offers while `platform.maker_checker_on` is true:
  the last editor cannot approve. With a single admin, offers cannot be
  approved until a second admin (compliance role) exists. That is intended.
- **Optimistic concurrency** on every mutation (`p_expected_version`):
  two admins editing the same record cannot overwrite each other.
- **Outbox, not dual writes.** Changes the borrower app must see
  (`offer.listing_upserted`, `offer.listing_removed`, `kyc.policy_changed`,
  `config.setting_changed`) are emitted as full-state snapshots with a
  monotonic `aggregate_version`. The dispatcher applies them to the App DB
  idempotently ("apply only if newer"), so retries and reordering are safe.
  Dispatcher: `api.outbox_claim` (SKIP LOCKED leases, horizontally
  scalable) → apply → `api.outbox_ack` / `api.outbox_nack` (exponential
  backoff, dead-letter after 12 attempts).
- **Isolation.** `CONNECT` is revoked from PUBLIC on both databases; the
  app_admin roles cannot connect to portal_admin and vice versa.

## Roles (all NOLOGIN; login users are created with SQL)

| Role                    | Grants                                    | Used by                   |
|-------------------------|-------------------------------------------|---------------------------|
| `<db>_owner`            | owns all objects; nobody logs in as it    | migrations (via SET ROLE) |
| `<db>_api`              | EXECUTE on `api.*` user functions         | admin backend             |
| `<db>_dispatcher`       | EXECUTE on `api.outbox_*` only            | outbox worker             |
| `<db>_readonly`         | SELECT, `audit.verify_chain()`            | support / reporting       |

**Never create service logins with the Neon console "Add role" button, CLI
or API.** Those roles are made members of `neon_superuser`
(`pg_read_all_data`, `pg_write_all_data`, `BYPASSRLS`, `CREATEROLE`), which
bypasses every control above. Create them in the SQL Editor instead:

```sql
CREATE ROLE app_admin_backend LOGIN PASSWORD '<from password manager>'
  CONNECTION LIMIT 20 IN ROLE app_admin_api;
ALTER ROLE app_admin_backend SET statement_timeout = '10s';
ALTER ROLE app_admin_backend SET idle_in_transaction_session_timeout = '30s';
```

Then delete the statement from the SQL Editor history, and store the
connection string (pooled host, `sslmode=require`) only in the secret
manager / Railway variables.

## Migrations

`./migrate.sh cluster|app_admin|portal_admin` with `OPERATOR_URL` set.
Files are immutable once applied (checksum-enforced): fix forward with a new
numbered file. `platform/0001_platform.sql.tmpl` is the source for both
databases' `0001_platform.sql`.

## Not done yet (next steps)

1. ~~Publish path~~ done 2026-10-25: App DB `admin.sync_apply` +
   `/api/outbox-dispatch` (see the root README).
2. Cut the existing ficium-admin code over from the App DB `admin` schema
   (`ficium_admin_app` role, `admin.offer_*`, `admin.set_kyc_check`) to these
   `api.*` functions, then retire that schema.
3. portal_admin domain migrations (commission, institution onboarding).
4. External anchor for the audit head hash (daily write of
   `verify_chain().head_hash` to a separate store) so tail deletion by a
   privileged operator is also detectable.
5. Paid plan, PITR, IP allowlist, region decision (see hard rule).
