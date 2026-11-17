# ficium-admin

Ficium's internal staff app. Not customer-facing. Modules:

- **KYC checks** — turn a verification check on (immediate) or ask to turn it off (a second admin must
  approve; never your own request), with a required reason and a full change history.
- **Offers** — create, approve, publish, re-verify and withdraw the provider offers shown in the borrower
  app's Offers feed. See *Offers* below.
- **App releases** — which versions of the iPhone and Android apps may still run. Per platform: the
  latest version in the store, the minimum version allowed (anything older must update before it can be
  used) and the store link. Every change is four-eyes: one admin asks with a reason, a different admin
  approves. The admin DB refuses a minimum above the latest released version. The page also shows how
  many borrowers used each app version in the last 7 and 30 days (totals read from the borrower app's
  signed API), and how many a new minimum would block, before it is asked for. See *App releases* below.
- **Team** — invite Ficium staff, change their roles, suspend or disable them. An invite is one admin-DB
  transaction (`api.iam_invite`, needs `iam.manage`) that also creates the person's ficium-auth login
  *as the inviter* (`POST /auth/staff/provision`, which itself requires an MFA staff token). New logins get
  the ficium-auth role `ficium_staff` (no bank-portal powers). The set-password link (24 h, single use) is
  emailed to the invitee only — never shown to the inviter — so invites need working email (Resend).
  Nobody can change their own roles or status.

- **Commission** (portal admin) — the rate Ficium charges a bank on each booked deal, per bank, product,
  both, or the platform default. Ask to set a rate from a date (never backwards) or to end an override; a
  second admin approves and portal-api applies it to `billing.commission_rule` (Portal DB). Rules are never
  edited, so what was charged when stays on record. Banks without the deals module are never charged.

## How it's protected

```
browser ──/auth/* (Vercel rewrite)──► ficium-auth: password + TOTP MFA → RS256 access token (amr: mfa)
        ──/api/* + Bearer token──► Vercel functions: verify token (JWKS, public key only) ──► Admin DB (Neon)
                                    platform staff + MFA only      api.begin_session(sub, email, …)
```

- **Identity is ficium-auth** (decision 2026-10-26; Cloudflare Access remains a configuration-only
  alternative). The API accepts a token only if it is RS256-signed by ficium-auth, belongs to the Ficium
  platform institution (`PLATFORM_INSTITUTION_ID`), has a staff role (`STAFF_ROLES`, default
  `super_admin`), a staff email domain (`STAFF_EMAIL_DOMAIN`) and **`amr` contains `mfa`**. A password-only
  session gets `403 MFA_REQUIRED` and the app walks the user through TOTP enrolment.
- **Then the admin DB decides**: the person must be an invited, active admin there, with the permission for
  the action. Bank users can never get in: wrong institution, wrong role, not invited.
- **Same-origin sign-in.** `/auth/*` is proxied to ficium-auth by a Vercel rewrite, so the CSP stays
  `connect-src 'self'`, no CORS is needed, and the HttpOnly refresh cookie is first-party (works on Safari
  and iOS). The access token is kept in memory only. Trade-off: ficium-auth sees Vercel's IP, so its
  per-IP login throttle is shared by all admin users; per-account lockout and MFA still apply per person.
- **Fail closed.** No identity provider configured → 503. No or invalid token → 401.
- **No service key.** CI fails if one appears. The backend's DB role has no table access at all: every
  request is one transaction that starts with `api.begin_session(sub, email, …)`, and the admin DB decides
  who the admin is (invited by email, bound to the token subject on first sign-in) and what they may do.
- **Every change is audited** in the admin DB's append-only, hash-chained `audit.event` (who, before →
  after, reason, request id, IP). KYC changes are also mirrored into the App DB's
  `admin.kyc_settings_change` when they are applied there.

## Two sites, one codebase

The same repo deploys as **two separate Vercel projects**. Nothing is shared at runtime: each has
its own admin database, its own credentials and its own URL.

| | App admin | Portal admin |
|---|---|---|
| `ADMIN_SITE` / `VITE_ADMIN_SITE` | `app` (default) | `portal` |
| Modules | Borrowers, KYC checks, KYC reviews, Offers, App releases, Services, API traffic, Audit, Team | Applications, Banks, Roles, Compliance, Commission, Services, API traffic, Audit, Team |
| Admin DB (`ADMIN_DB_API_URL`) | Neon `app_admin` | Neon `portal_admin` |
| Reaches the product | app `/api/internal?op=admin-sync` over HTTPS (signed) | portal-api `/internal/admin/v1` over HTTPS only |

An endpoint that belongs to the other site answers 404, so a misrouted call cannot touch the
wrong product.

**Rule: services talk through APIs, never through each other's databases.** The portal admin site
has no Portal DB credentials at all. It reads and changes bank data only through portal-api's
`/internal/admin/v1` endpoints. Every call is HMAC-signed with `ADMIN_PORTAL_SIGNING_KEY` (same
`Ficium-Signature` scheme as the integration contract) **and** carries the signed-in staff
member's own ficium-auth token, which portal-api re-verifies (platform staff, MFA). Neither a
leaked key nor a stolen token is enough alone.

Compliance flow: document reviews are decided by one reviewer. Waivers are four-eyes: one admin
asks, a different admin approves, enforced in the admin DB and again by portal-api. For a change,
the admin-DB transaction stays open across the portal call; if the portal refuses or is
unreachable, it rolls back and nothing is recorded as done anywhere. Commands are idempotent by
`command_id`, so a retry never applies twice.

### Services

Both sites. Every service the site depends on, whether it is answering right now, and a **Test** button
per service (`api/_lib/services.ts`, served as `/api/audit?module=services`: the site is at the 12-function cap).

| App site | Portal site | Test |
|---|---|---|
| This admin API | This admin API | answering the request |
| Admin DB (`app_admin`) | Admin DB (`portal_admin`) | `select 1`, timed |
| Sign-in service (ficium-auth) | Sign-in service | `GET /.well-known/jwks.json`, keys present |
| Borrower app | Portal API | `GET /api/keepalive` (also App DB and missing migrations) / `GET /health` |
| Channel to the borrower app | Channel to the portal | the existing signed read (`op=admin-app` stats / query `traffic.overview`) |
| Delivery of changes | — | outbox backlog and dead letters (`api.ops_health_view`, needs `audit.read`) |

- **No address ever comes from the browser.** The page sends a service key; the server looks the test up
  in a fixed registry and refuses any key the site does not list. This is what stops the button from being
  a request-forging tool against anything the deployment can reach.
- **Every test only reads.** No endpoint that writes is in the registry, which is why a test can be run at
  any time. That is also why this is a list of services, not of every endpoint: testing a write endpoint
  (accepting a bid, say) would perform it.
- Gated by `traffic.view` (all roles), checked in the admin DB before anything is probed. No migration.
- The same service is not tested twice within 3 seconds (per instance, best effort).
- The portal API's `/health` does not touch its database; the channel test does. Each row says what its test
  proves and what it does not.

### App releases

```
admin asks ─► release.change_request ─► a different admin approves ─► release.policy (version + 1)
                                                                        └─► outbox: app.release_policy_changed
borrower app: /api/internal?op=admin-sync ─► public.app_release_policy ─► read by every installed app
borrower app: /api/internal?op=admin-app  ◄─ this page reads totals per app version (signed, no personal data)
```

- Migration: `db/admin-db/app_admin/0010_app_release.sql`, applied to `app_admin` on 2026-11-16 (recorded
  in `meta.schema_migration`, so `migrate.sh app_admin` reports it as up to date). The borrower app's
  matching migration (`20261116120000_app_release_policy.sql`) was applied to the App DB the same day.
- Permissions: `release.view` (all roles), `release.request` (super admin, operations),
  `release.approve` (super admin, compliance). Never your own request.
- The API is served by the `api/kyc.ts` function file as `/api/kyc?module=releases`, because the Vercel
  plan allows 12 function files and this site has 12. The handler is `api/_lib/releases.ts`.
- "In force in the apps" on the page means the borrower app has applied the same policy version as the
  admin DB. "Not yet delivered" means the outbox is still retrying (hourly, alert after dead-letter).
- The page also lists the errors the phone apps reported in the last 7 days, per app version, most
  widespread first (read with the usage totals; scrubbed of personal-looking data by the app and by
  its database). Crashes in the native shell itself appear in the store consoles, not here.
- `db/admin-db/tests/app_release.sql` exercises the whole workflow against a scratch database.

### API traffic

One page on both sites ("API traffic") that shows every API channel the product uses, in and out, and can
pause one. Per channel: calls, failures (5xx and no answer), refused (4xx, the caller's mistake), median and
slow (p95) time, last success, last error, and a 24-hour strip. Shown as the product reports it, so each site
sees only its own product.

```
app site:    page ─► api.traffic_* (admin DB, audited) ─► outbox: api.channel_policy_changed ─► /api/internal?op=admin-sync
             page ◄─ /api/internal?op=admin-app {"action":"traffic"} (signed, totals only)
portal site: page ─► api.traffic_* (admin DB, audited) ─► portal-api /internal/admin/v1/commands (api_channel.pause|resume)
             page ◄─ portal-api /internal/admin/v1/query (traffic.overview)
```

- Migrations: `db/admin-db/app_admin/0011_api_traffic.sql` and `db/admin-db/portal_admin/0010_api_traffic.sql`.
  Product side: `ficium` `20261117090000_api_traffic.sql` and `ficium-portal-api` `db/064_api_traffic.sql`.
  Apply the product migrations first, then these, then deploy the products, then this site.
- Pause is immediate, one person (`traffic.control`: super admin, operations). Resume is four-eyes
  (`traffic.control` asks, a different person with `traffic.approve` approves; 72 h to act). Seeing the page is
  `traffic.view`. Every change is in the hash-chained audit log with its reason.
- The admin channel itself (and, on the portal, bank staff using the portal) can be monitored but never paused;
  the databases on both sides refuse it, so a bug in the page cannot lock everyone out.
- What a pause does: inbound channels answer `503 channel_paused` with `Retry-After` before doing any work;
  outbound event channels stop claiming from the outbox, and a sender that meets a paused receiver holds the
  event without using a retry attempt, so a long pause cannot dead-letter anything. Bid acceptance and document
  sending refuse with "try again shortly" before anything is prepared. Bank webhooks are recorded as held and
  never count toward auto-disabling an endpoint. While the AI steps of KYC are paused they behave exactly as
  when the provider is down (the AI review is skipped; ID reading falls back to typing it in).
- A version number per channel makes a replay or a late delivery harmless: a product applies only a newer one.
  If the product is unreachable the page says so and still shows the admin side's state.
- The API is served by `api/audit.ts` as `?module=traffic` (12-function limit). Handler: `api/_lib/api-traffic.ts`.
  Env: the app site reuses `APP_ADMIN_SYNC_URL` and `APP_ADMIN_SYNC_SIGNING_KEY`; the portal site reuses the
  portal-api settings above. Nothing new to configure.
- Counts are monitoring-grade: servers batch in memory and write at most every ~10 s each, so the last seconds
  of a busy server can be missing after it is recycled. Not an audit record; the audit log is.
- Tests: `db/admin-db/tests/api_traffic.sql`, `api_traffic_portal.sql`, `api/_tests/api-traffic.test.ts`.

### Switching the app site's sync to HTTPS

The outbox worker delivers to the borrower app's API when both of these are set on the **app
admin** project (otherwise it still uses the legacy `APP_DB_SYNC_URL` connection and logs a
warning):

| Name | Value |
|---|---|
| `APP_ADMIN_SYNC_URL` | `https://<borrower app host>/api/internal?op=admin-sync` |
| `APP_ADMIN_SYNC_SIGNING_KEY` | new random key; the same value goes in the `ficium` Vercel project as `ADMIN_SYNC_VERIFY_KEYS` |

After one successful sync over HTTPS: delete `APP_DB_SYNC_URL` and `APP_DB_CA_CERT` here, and
remove LOGIN from `ficium_admin_sync` on the App DB. Then no service holds credentials to
another service's database.

### Deploying the portal admin site

1. Vercel -> Add New -> Project -> import `Ficium001/ficium-admin` again, name it e.g.
   `ficium-portal-admin`. Framework preset: Vite.
2. Environment variables (Production only):

| Name | Value |
|---|---|
| `ADMIN_SITE`, `VITE_ADMIN_SITE` | `portal` |
| `ADMIN_DB_API_URL` | Neon pooled host, user `portal_admin_backend`, database `portal_admin` |
| `FICIUM_AUTH_URL`, `PLATFORM_INSTITUTION_ID`, `STAFF_ROLES`, `STAFF_EMAIL_DOMAIN` | same as the app admin site |
| `PORTAL_API_URL` | `https://<portal-api host>` |
| `ADMIN_PORTAL_SIGNING_KEY` | a new random key (`openssl rand -hex 32`); put the same value in portal-api's `ADMIN_COMMAND_VERIFY_KEYS` on Railway |

3. Neon: create the login `portal_admin_backend` (in role `portal_admin_api`) in the SQL editor,
   as for `app_admin_backend`. Never paste its password into a chat.
4. No Vercel cron and no `ADMIN_DB_WORKER_URL` / `APP_DB_*` on this project: the portal site has
   no outbox worker and no App DB access.

Migrations applied to `portal_admin`: `0001_platform`, `0002_portal_compliance`, `0003_change_requests`, `0004_require_permission` (2026-10-27), `0005_ops_health` (2026-10-30). **Pending:** `0006_commission` (needs `migrate.sh portal_admin` before the Commission page works).

**Alerts.** The app admin's hourly dispatcher logs `ALERT ops health …` when the audit chain fails
verification, a sync event is dead-lettered, or a change has waited over 2 hours. Route that log line
to email or Slack with a Vercel log drain; until then it is visible on the Audit page of each site.

`0003` is the one four-eyes workflow for every portal change: each op portal-api accepts is a row in `governance.op` (who may ask, who may approve). New modules add rows there, not new tables.

## Deploy

The app **fails closed**: until Cloudflare Access is configured it answers 503 to everything, and a direct
visit to the `*.vercel.app` URL without an Access token gets 401. Deploying first is safe.

### 1. Database logins (you — never paste passwords into a chat)
Created in the Neon SQL Editor with `neondb` selected (never with the console's *Add role* button, which
grants `neon_superuser`): `app_admin_backend` (in role `app_admin_api`) and `app_admin_worker` (in role
`app_admin_dispatcher`). See [`db/admin-db/README.md`](db/admin-db/README.md). App DB side:
`ALTER ROLE ficium_admin_sync LOGIN PASSWORD '…'` in the Supabase SQL editor. Letters and digits only.

### 2. Vercel project
Vercel -> Add New -> Project -> import `Ficium001/ficium-admin` (grant the Vercel GitHub app access to this
private repo if asked). Framework preset: **Vite** (auto-detected). Environment variables, **Production only**:

| Name | Value |
|---|---|
| `ADMIN_DB_API_URL` | Neon pooled host, user `app_admin_backend`, database `app_admin` (no `?sslmode`) |
| `ADMIN_DB_WORKER_URL`, `APP_DB_SYNC_URL`, `APP_DB_CA_CERT`, `CRON_SECRET` | see *Publish path* below |
| `STAFF_EMAIL_DOMAIN` | `ficium.net` |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | leave unset until step 4 (the app stays closed) |

Settings -> Deployment Protection: keep **Vercel Authentication** on so preview URLs are not public.
Secrets are managed in **Doppler** (`ficium-admin/prd`, synced to Vercel Production); don't edit them in Vercel.
Note: Vercel Hobby is non-commercial only. Staying on Hobby is a deliberate choice for the working model;
move to Pro before real customers.

### 3. Domain
Add the admin address (e.g. `admin.ficium.net`) in Vercel -> Domains, and create the DNS record Vercel shows.
Cloudflare Access can only protect a hostname in a Cloudflare zone, so `ficium.net` DNS must be on Cloudflare
and the record **proxied** (orange cloud).

### 4. Cloudflare Access
Zero Trust -> Access -> Applications -> Add -> Self-hosted:
- Application domain: the admin address.
- Policy: *Allow*, emails ending in `@ficium.net` (or named people only); require MFA.
- Copy the **Application Audience (AUD) tag** and your team domain into `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN`
  in Vercel, then redeploy.

### 5. Verify (from a phone is fine)
1. `https://<project>.vercel.app/api/kyc` -> 401 "Sign in through Ficium Access" (or 503 before step 4). Never 200.
2. `https://<admin address>` -> Cloudflare login, then the KYC checks page with your email top-right.
3. Flip a non-critical check off and on with a reason; the change appears in the history list.

## Offers

```
draft ──approve (reason)──► approved ──publish──► published ──withdraw (reason)──► withdrawn
  ▲                                                   │
  └──────────────── any edit sends it back to draft ──┘   (live version stays until republished)
```

- Writes only through the admin DB's `api.offer_save / _approve / _publish / _withdraw / _reverify`, each
  with the version the admin opened (a stale screen gets 409). Every action is in `audit.event` with a
  before/after snapshot. Publish, re-verify and withdraw reach `public.offer_listing` through the outbox.
- Approval refuses an offer without image + description, source link, provider consent reference, a
  future expiry, and rates verified within 30 days. **Maker-checker is enforced** while
  `platform.maker_checker_on` is true: the last editor cannot approve (decision 2026-10-25), so a second
  admin (e.g. `compliance` role) is needed to approve offers.
- A published offer leaves the borrower feed on its own at expiry or 30 days after the last verification.
  Use *Record re-verification* to keep it live.
- **Images** go to the public Vercel Blob store `ficium-admin-blob` (region `bom1`, path `offers/…`,
  unguessable URLs). Auth is **OIDC**: on Vercel, `@vercel/blob`'s server `put()` uses the short-lived
  per-request OIDC token plus `BLOB_STORE_ID`, so there is **no long-lived blob token**. Keep the store
  connected to **Production only** — Preview deployments also receive OIDC tokens and must not be able to
  write. JPEG/PNG/WebP, 2 MB max, content is checked against the declared type. If an upload ever fails
  with a credentials error, check the connection and `BLOB_STORE_ID` first; adding a read-write token is a
  fallback, not the default.
- The borrower app only renders images from `*.public.blob.vercel-storage.com` and only reads
  `public.offer_listing`. This app never reads borrower tables.

## Admin database (Neon)

Since 2026-10-25 the pages use the admin DB (`app_admin` on Neon project `Ficium_admin`), not the App DB
`admin` schema. Migrations, roles and design: [`db/admin-db/README.md`](db/admin-db/README.md). No real
customer data goes into Neon before the paid-plan / PITR / IP-allowlist gate in that README.

### Publish path (admin DB → App DB)

```
Neon app_admin                         App DB pg_cron (hourly sweep)           App DB
api.* writes change + audit + outbox ─► /api/outbox-dispatch ─► admin.sync_apply ─► offer_listing /
                                        claim (lease) → apply → ack/nack            kyc_settings /
                                                                                     platform_config
```

- **Trigger:** App DB `pg_cron` job `admin-outbox-sweep` (hourly, `admin.trigger_outbox_dispatch()`, migration
  `admin_outbox_trigger_v1`) calls the endpoint. Not Vercel Cron: Hobby allows daily only and fails deploys
  otherwise. Hourly because each call wakes the Neon DB (free tier scales to zero); after the cut-over the
  admin API dispatches right after each write, so the sweep only handles retries.
- `/api/outbox-dispatch` is **not** behind Cloudflare Access (the scheduler calls it directly); it requires
  `Authorization: Bearer $CRON_SECRET` and fails closed (503) without a 32+ character secret.
- Two single-purpose credentials: `app_admin_worker` (Neon, outbox functions only) and
  `ficium_admin_sync` (App DB, `admin.sync_apply` only). See `.env.example`.
- Safe under retries, overlap and reordering: leases + `SKIP LOCKED` on the Neon side, per-aggregate
  version + event-id dedupe on the App DB side. Failures back off exponentially and dead-letter after
  12 attempts (`outbox.event.failed_at`).

Enable it: (1) Supabase SQL editor: `ALTER ROLE ficium_admin_sync LOGIN PASSWORD '<password manager>';`
(2) Doppler `ficium-admin/prd` → Vercel Production: `ADMIN_DB_WORKER_URL`, `APP_DB_SYNC_URL`, `APP_DB_CA_CERT`,
`CRON_SECRET`; redeploy. (3) Supabase SQL editor, same secret value:
`select vault.create_secret('<CRON_SECRET>', 'admin_outbox_cron_secret');` then clear the editor history.
Until (2) the endpoint answers 503; until (3) the sweep does nothing.

## Develop

```
npm ci
cp .env.example .env.local   # set ALLOW_DEV_AUTH=1 and DEV_ACTOR; ignored on Vercel
npx vercel dev
```

Check names and descriptions live in `api/_lib/checks.ts`. The keys must match `kyc.check_setting` in the
admin DB and `public.kyc_settings` / `admin._sync_kyc` in the App DB; the databases are the final authority.
