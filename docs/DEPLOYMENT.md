# Deployment guide (Supabase + Twilio Verify + Razorpay + Chrome/Edge)

Environments, per blueprint §8: **Local** (synthetic data) → **Staging** (production-like, no real meeting data) → **Production**. Use a separate Supabase project for each of staging and production.

## 1. Supabase project
1. Create a project at supabase.com. For Indian customers, pick a region close to them, such as Mumbai `ap-south-1`.
2. Install the Supabase CLI, then run:
   `supabase login` · `supabase link --project-ref <ref>` · `supabase db push`
   This creates schema `app` with every table, the session state machine, guards and the audit chain.
3. Push the auth settings with `supabase config push` (phone OTP, Twilio Verify, test numbers, token rotation). You can also set them in the Dashboard → Authentication → Providers → **Phone**:
   - Enable Phone provider. SMS provider: **Twilio Verify**.
   - **Test phone numbers and OTPs:** `919999900001=123456`, `15550100002=654321`.
4. **Edge Functions:**
   - Copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill it in.
   - Run `supabase secrets set --env-file supabase/functions/.env`.
   - Deploy with `supabase functions deploy api --no-verify-jwt` and `supabase functions deploy razorpay-webhook --no-verify-jwt`.
   - The API verifies user tokens itself. The webhook is verified by its HMAC signature.
5. **Scheduled runner:** open `supabase/cron.example.sql`, put in your project ref and `CRON_SECRET`, then run it in the SQL editor. This handles job retries, deletion purges and retention.
6. **Health check:** `curl https://<ref>.supabase.co/functions/v1/api/v1/health` should return `{"ok":true,"ai":true,"asr":true,…}`.

## 2. Twilio Verify (OTP SMS to most countries)
1. Create a Twilio account → **Verify** → create a Service. Copy the **Account SID**, **Auth Token** and **Verify Service SID**.
2. Paste them into the Supabase phone provider settings (Twilio Verify).
3. **Geo permissions:** in Twilio Console → Verify → Settings, enable the countries you'll serve. Turn on fraud guard (SMS pumping protection).
4. **India:** domestic SMS needs **DLT registration** of your company, sender ID and template, which Twilio files with Indian telecom operators. Start this early: it can take several days.
   - If it blocks launch, Supabase also supports MessageBird, Vonage and Textlocal.
   - Specialised OTP providers such as MessageCentral VerifyNow handle DLT for you, but need a small custom SMS hook. Ask if you want this.
5. Keep Supabase's SMS rate limits (`[auth.rate_limit]`) conservative until you know your volumes.

## 3. Razorpay subscriptions (US$10 / month, international cards, INR settlement)
1. Sign up at razorpay.com as your **Indian company** and complete KYC: PAN, GST, incorporation documents and an Indian **current account** for settlement.
2. Dashboard → **International payments** → activate *International cards*. Use purpose code "software / SaaS services".
3. Dashboard → **Subscriptions → Settings** → enable **Card** for recurring payments.
4. **Create a plan:** Subscriptions → Plans → *New plan* → Monthly, **Currency USD, Amount 10.00**, name "CONVOSAGE Pro". Copy the `plan_…` id into `RAZORPAY_PLAN_ID`.
5. **Create the webhook:**
   - URL: `https://<ref>.supabase.co/functions/v1/razorpay-webhook`
   - Secret: put the same value in `RAZORPAY_WEBHOOK_SECRET`
   - Events: `subscription.authenticated, activated, charged, pending, halted, cancelled, completed, paused, resumed`
6. Settings → API Keys: create **test** keys first (`rzp_test_…`) and test with Razorpay's test cards. Then generate **live** keys and a live-mode plan and webhook.
7. Settlements arrive in INR in your current account on Razorpay's schedule. International card settlements typically take longer than domestic ones.
   - Fees: international cards ~3% + GST, plus the subscriptions add-on. Check your Razorpay rate card.

> Dummy accounts (`TEST_PHONES`) never touch Razorpay. They use the built-in test checkout (`checkout.html`), even in production.

## 4. Build and install the extension
1. Edit `extension/src/config.ts`: set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Set `SHOW_TEST_ACCOUNTS` to false for public builds.
2. Build: `cd extension && npm ci && npm run build`. The output is `extension/dist/`.
3. Install for testing — **Chrome**:
   - Go to `chrome://extensions` → Developer mode → **Load unpacked** → select the `dist` folder (the folder that directly contains `manifest.json`).
   - **Edge:** same steps at `edge://extensions`.
4. Note the extension ID shown, and add it to the `ALLOWED_ORIGINS` secret: `chrome-extension://<id>`.
5. Before publishing, add your own Supabase domain to `host_permissions` in `extension/public/manifest.json`, then remove the localhost entries.
6. **Publish:**
   - **Chrome Web Store:** zip the *contents* of `dist/` and upload it. Fill in the privacy practices for audio, screen and identity data. Justify each permission: `tabCapture`, `desktopCapture`, `offscreen`, `sidePanel`, `storage`, `notifications`.
   - **Microsoft Edge Add-ons:** upload the same package.
   - **Enterprise:** force-install via policy.
7. **Firefox and Safari:** these need separate adapters and packaging (Safari via Xcode). Don't advertise them until certified (blueprint §9).

## 5. Go-live checklist (short)
- [ ] `docs/CREDENTIALS.md` items 3–5 switched off and items 6–15 set to production values
- [ ] Razorpay live keys, live plan and live webhook; one real US$10 payment tested and refunded
- [ ] Twilio geo-permissions, fraud guard and India DLT done; OTP received in target countries
- [ ] Privacy policy and terms published; consent wording approved by legal
- [ ] Blueprint §7 pre-release security work: threat model, SAST, dependency/secret scanning, DAST, penetration test, permission review
- [ ] Backups/PITR enabled on Supabase; restore exercise done (§11)
- [ ] Monitoring: function logs, error rates, the `app.jobs` dead-letter count, capture failures
