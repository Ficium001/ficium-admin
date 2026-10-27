# ficium-admin

Ficium's internal staff app. Not customer-facing. Modules:

- **KYC checks** — turn verification checks on or off, with a required reason and a full change history.
- **Offers** — create, approve, publish, re-verify and withdraw the provider offers shown in the borrower
  app's Offers feed. See *Offers* below.
- **Team** — invite Ficium staff, change their roles, suspend or disable them. An invite is one admin-DB
  transaction (`api.iam_invite`, needs `iam.manage`) that also creates the person's ficium-auth login
  *as the inviter* (`POST /auth/staff/provision`, which itself requires an MFA staff token). New logins get
  the ficium-auth role `ficium_staff` (no bank-portal powers). The set-password link (24 h, single use) is
  emailed to the invitee only — never shown to the inviter — so invites need working email (Resend).
  Nobody can change their own roles or status.

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
