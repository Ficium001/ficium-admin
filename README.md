# ficium-admin

Ficium's internal staff app. Not customer-facing. First module: **KYC checks** — turn
verification checks on or off, with a required reason and a full change history.

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

## Deploy (needs the admin address — not needed to build)

1. **DB role password** — in the App DB SQL editor, with a long random password:
   `ALTER ROLE ficium_admin_app LOGIN PASSWORD '<generate 32+ chars>';`
2. **Vercel** — new project from this repo. Env vars (Production only): see `.env.example`.
   Use the Supabase *transaction pooler* URL with user `ficium_admin_app.<project-ref>`.
3. **Domain** — add the admin address (e.g. `admin.ficium.net`) to the Vercel project.
4. **Cloudflare Access** (Zero Trust → Access → Applications → Add → Self-hosted):
   - Application domain: the admin address.
   - Policy: *Allow*, include emails ending in `@ficium.net` (or named people only); require MFA.
   - Copy the **Application Audience (AUD) tag** → `CF_ACCESS_AUD`; your team domain → `CF_ACCESS_TEAM_DOMAIN`.
5. **Vercel Deployment Protection** on, so preview URLs aren't public.

## Develop

```
npm ci
cp .env.example .env.local   # set ALLOW_DEV_AUTH=1 and DEV_ACTOR; ignored on Vercel
npx vercel dev
```

Check names and descriptions live in `api/_lib/checks.ts`. The keys must match
`public.kyc_settings` and the allowlist in `admin.set_kyc_check`; the DB is the final authority.
