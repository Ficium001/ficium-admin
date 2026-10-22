# ficium-admin

Ficium's internal staff app. Not customer-facing. Modules:

- **KYC checks** — turn verification checks on or off, with a required reason and a full change history.
- **Offers** — create, approve, publish, re-verify and withdraw the provider offers shown in the borrower
  app's Offers feed. See *Offers* below.

## How it's protected

```
browser ──► Cloudflare Access (company login + MFA) ──► Vercel ──► /api/kyc ──► App DB
                                                                   │
                                     verifies the Access JWT on    │  connects as ficium_admin_app:
                                     EVERY request; actor = email  │  read settings + history,
                                     from the token, never the     │  change only via the audited
                                     browser                       │  admin.set_kyc_check
```

- **Fail closed.** No Access config → 503. No or invalid token → 401. Non-`@ficium.net` → 403.
- **The Vercel URL is reachable directly**, bypassing Cloudflare. That's why the API verifies
  the JWT itself; a direct visitor gets a page that can't load any data.
- **No service key.** CI fails if one appears. The DB role cannot write tables directly.
- **Every change is audited** in `admin.kyc_settings_change`: who, old → new, reason, when.

## Deploy

The app **fails closed**: until Cloudflare Access is configured it answers 503 to everything, and a direct
visit to the `*.vercel.app` URL without an Access token gets 401. Deploying first is safe.

### 1. Database role password (you, in Supabase — never paste it into a chat)
Supabase -> project **Ficium** -> SQL editor. Generate ~40 random letters/digits in a password manager
(letters and digits only, so the connection string needs no escaping), then run:

    ALTER ROLE ficium_admin_app LOGIN PASSWORD '<the password>';

The role can read KYC settings and their history and change a check only through the audited
`admin.set_kyc_check`; it cannot write tables, and it is capped at 6 connections.

### 2. Vercel project
Vercel -> Add New -> Project -> import `Ficium001/ficium-admin` (grant the Vercel GitHub app access to this
private repo if asked). Framework preset: **Vite** (auto-detected). Environment variables, **Production only**:

| Name | Value |
|---|---|
| `ADMIN_DATABASE_URL` | Supabase -> Connect -> *Transaction pooler* string; change the user to `ficium_admin_app.<project-ref>`, set the password from step 1 |
| `STAFF_EMAIL_DOMAIN` | `ficium.net` |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | leave unset until step 4 (the app stays closed) |

Settings -> Deployment Protection: keep **Vercel Authentication** on so preview URLs are not public.
Note: Vercel Hobby is non-commercial only; this is part of a commercial product, so use Pro.

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

- Writes only through `admin.offer_save / _approve / _publish / _withdraw / _reverify`; every action is in
  `admin.offer_change` (append-only) with a full snapshot.
- Approval refuses an offer without image + description, source link, provider consent reference, a
  future expiry, and rates verified within 30 days. Self-approval is allowed while Ficium has one staff
  member, and is recorded (`self_approved`) rather than hidden.
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

## Develop

```
npm ci
cp .env.example .env.local   # set ALLOW_DEV_AUTH=1 and DEV_ACTOR; ignored on Vercel
npx vercel dev
```

Check names and descriptions live in `api/_lib/checks.ts`. The keys must match
`public.kyc_settings` and the allowlist in `admin.set_kyc_check`; the DB is the final authority.
