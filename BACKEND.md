# LahLahLearn backend

## Live setup (November 2026)

| Piece | Where |
|---|---|
| Supabase project | `lahlahlearn`, ref `vuhvvzmmnndrgxoywfem`, region Singapore (`ap-southeast-1`). Supabase has no Malaysia region, and Singapore is the closest. |
| Database | Migrations from `supabase/migrations/` are applied, with row-level security on every table. |
| Edge functions | `billing`, `stripe-webhook`, `invite`, `checkup`, `weekly-report`, `pip-chat`, `admin-stats`, `delete-account` are deployed. |
| Server settings | In Supabase Vault as `app.<NAME>`: Stripe keys, webhook secret, cron secret, site URL, allowed origins, admin emails. A function secret with the same name overrides one. |
| Weekly reports | pg_cron job `lll-weekly-report` runs every day at 01:00 UTC (09:00 Malaysia) and calls `weekly-report`. |
| Stripe (test mode) | Products "LahLahLearn Family · 1/2/3 children", each with a monthly and a yearly MYR price (lookup keys `family_<n>_<month|year>`). The webhook points at `stripe-webhook`. The customer portal lets families switch plans or cancel at the end of the period. |
| App config | `assets/config.js` points at the project with the publishable key. |

### Care Circle emails
Invites, check-up emails and weekly reports go out through Gmail (SMTP, port 465):
- `app.SMTP_USER` and `app.EMAIL_FROM` are stored in Vault.
- The Gmail app password goes in the Edge Function secret `SMTP_PASS` (Supabase → Edge Functions → Secrets).
- A `RESEND_API_KEY`, if set, takes priority.

### Still to do in dashboards (needs your logins)
1. **Supabase → Authentication → URL Configuration.**
   - Set Site URL to `https://lahlahlearn.netlify.app/`.
   - Add these Redirect URLs: `https://lahlahlearn.netlify.app/**` and `https://tza-za.github.io/LahLahLearn/**`.
2. **Supabase → Authentication → Emails (templates).**
   - In **Magic link** and **Confirm signup**, add `{{ .Token }}` so people get a 6-digit code.
   - The link in the email also works on its own.
3. **Email sending.**
   - Supabase's built-in mailer only sends a few emails an hour, which is too few for 20 pilot families.
   - In Authentication → SMTP, connect Resend: host `smtp.resend.com`, port 465, user `resend`, password = your Resend API key.
   - Add `RESEND_API_KEY` and `EMAIL_FROM` as Edge Function secrets so invites, check-ups and reports send.
4. **Pip's AI.** Add `ANTHROPIC_API_KEY` as an Edge Function secret. Until then Pip uses its built-in practice answers.
5. **Google sign-in.**
   - Create an OAuth client (Web) in Google Cloud Console.
   - Use `https://vuhvvzmmnndrgxoywfem.supabase.co/auth/v1/callback` as the redirect URI.
   - Paste the client ID and secret into Supabase → Authentication → Sign In / Providers → Google.
   - The button appears in the app by itself once Google is enabled.
6. **Apple sign-in.**
   - This needs a paid Apple Developer account. Create a Services ID and a key, using the same callback URL as Google.
   - Enter them under Providers → Apple. The button appears by itself once Apple is enabled.
7. **Going live with payments.**
   - Activate the Stripe account and recreate the products in live mode, or copy them over.
   - Replace `app.STRIPE_SECRET_KEY` and `app.STRIPE_WEBHOOK_SECRET` in Vault with the live values. You can do this from the SQL editor:
     ```sql
     select vault.update_secret((select id from vault.secrets where name='app.STRIPE_SECRET_KEY'), 'sk_live_...');
     ```


The app works on its own with no backend: everything stays on the device. When
`assets/config.js` has a Supabase URL and key, it switches on:

- **Accounts.** Sign in with a 6-digit email code. Google is optional.
- **Cloud save.** Children, progress and settings follow the family to any device.
- **Care Circle.** Parents invite teachers and therapists by email. Each person signs in with their own email.
- **Check-ups.** Booking and cancelling email everyone with a calendar file.
- **Weekly reports.** Sent by email on the day each family picks.
- **Family plan.** Stripe Checkout, a 7-day free trial and a billing portal.
- **Pip.** Answers come from Claude through the server, with a daily limit per family.
- **Admin page.** `admin.html` shows the numbers for the team.

## What is where

| Path | What it is |
|---|---|
| `supabase/migrations/` | Tables, row-level security, triggers and database functions |
| `supabase/functions/` | Edge functions: `invite`, `billing`, `stripe-webhook`, `weekly-report`, `checkup`, `pip-chat`, `admin-stats`, `delete-account` |
| `assets/config.js` | The public settings the app reads |
| `admin.html` | Private dashboard for the team |
| `scripts/stripe-setup.mjs` | Creates the Stripe product, prices, webhook and portal |
| `scripts/supabase-configure.mjs` | Sets the sign-in emails and redirect URLs |
| `.github/workflows/supabase.yml` | Deploys on push to `main`, and sends weekly reports every day at 09:00 Malaysia time |
| `supabase/tests/` | Database security tests, function tests and a local test stack |

## Set-up (about 30 minutes)

### 1. Supabase
1. Create a project at supabase.com. Pick the Singapore region and keep the database password.
2. Copy the **Project URL** and **anon public key** from Project Settings → API into `assets/config.js`.
   The anon key is safe to publish. Row-level security protects the data.
3. Create a personal access token at supabase.com/dashboard/account/tokens.

### 2. Email (Resend)
1. Make an account at resend.com and verify your domain.
2. Create an API key. Your sender will look like `LahLahLearn <hello@yourdomain.com>`.

### 3. Stripe
1. In test mode, copy the secret key (`sk_test_...`).
2. Run:
   ```
   STRIPE_SECRET_KEY=sk_test_... SUPABASE_URL=https://<ref>.supabase.co node scripts/stripe-setup.mjs
   ```
   This creates the six MYR prices (RM20, RM35 and RM45 monthly; RM200, RM350 and RM450 yearly),
   the webhook and the customer portal. It prints `STRIPE_WEBHOOK_SECRET`. Keep it.

### 4. Claude (for Pip)
Create an API key at console.anthropic.com.

### 5. GitHub secrets
Add these in the repo under Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | from step 1.3 |
| `SUPABASE_PROJECT_REF` | the `<ref>` part of the project URL |
| `SUPABASE_DB_PASSWORD` | from step 1.1 |
| `SITE_URL` | `https://tza-za.github.io/LahLahLearn/` |
| `CRON_SECRET` | any long random text |
| `RESEND_API_KEY`, `EMAIL_FROM` | from step 2 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | from step 3 |
| `ANTHROPIC_API_KEY` | from step 4 |
| `ADMIN_EMAILS` | emails allowed on `admin.html`, separated by commas |

You can also set these optional ones:

- `ALLOWED_ORIGINS`: other sites allowed to send people to Stripe, such as a Netlify URL.
- `AI_DAILY_LIMIT`: Pip messages per family per day. The default is 80.
- `PIP_MODEL`: which model Pip uses.
- `APP_TIMEZONE`: the timezone for reports. The default is `Asia/Kuala_Lumpur`.

Then go to Actions → Backend → Run workflow, or push to `main`. This creates the tables and deploys the functions.

### 6. Sign-in emails
```
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=<ref> SITE_URL=https://tza-za.github.io/LahLahLearn/ \
RESEND_API_KEY=re_... EMAIL_FROM="LahLahLearn <hello@yourdomain.com>" node scripts/supabase-configure.mjs
```
This makes the sign-in emails contain a 6-digit code, sends them through Resend, and allows your site as a redirect.

### 7. Go live
Push `assets/config.js`. To take real payments, repeat step 3 with the live key and update the two Stripe secrets.

## Testing locally
You need Postgres 16, PostgREST and Deno.

```
python3 supabase/tests/test_rls.py "host=/tmp port=54329 user=postgres"   # 61 database security checks
POSTGREST=postgrest DENO=deno supabase/tests/local/start.sh               # local stack on :54321 (code 123456)
cd supabase/tests && npm i && node functions.test.mjs                      # 47 function checks
```
The local stack fakes sign-in emails: any address works with the code `123456`. It also fakes Stripe, Resend and Claude, and records their calls at `/__calls`.

## Security notes
- **Row-level security.** Every table has it. Parents can read and change only their own family.
- **Teachers and therapists.** They can read the children they were invited to. They can write shared notes, and therapists can manage their own available times and their check-ups.
- **Billing.** Only the Stripe webhook can change billing fields. A trial can be started once per family.
- **Invites.** An invite works only for the email it was sent to, expires after 14 days, and can be used once.
- **Deleting an account.** `delete-account` cancels the subscription first, then removes the family and the sign-in.
