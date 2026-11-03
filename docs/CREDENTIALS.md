# Credentials & settings checklist — change these later, no code changes needed

| # | What | Where | Test value now | Production value |
|---|---|---|---|---|
| 1 | Supabase project URL | `extension/src/config.ts` → `SUPABASE_URL` | placeholder | `https://<ref>.supabase.co` |
| 2 | Supabase publishable (anon) key | `extension/src/config.ts` → `SUPABASE_PUBLISHABLE_KEY` | placeholder | Project Settings → API |
| 3 | Show dummy accounts on sign-in | `extension/src/config.ts` → `SHOW_TEST_ACCOUNTS` | `true` | `false` |
| 4 | Dummy OTP numbers | Supabase Dashboard → Auth → Providers → Phone → *Test phone numbers* (or `supabase/config.toml` `[auth.sms.test_otp]`) | 2 numbers | remove |
| 5 | Dummy-payment numbers | secret `TEST_PHONES` | `919999900001,15550100002` | empty |
| 6 | Twilio | Supabase Dashboard → Auth → Phone → Twilio Verify: Account SID, Verify Service SID, Auth Token | — | your Twilio account |
| 7 | AI model | secrets `MODEL_PROVIDER`, `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL_NAME`, `MODEL_NAME_LARGE`, `VISION_MODEL` | — | your approved provider |
| 8 | Speech-to-text | secrets `ASR_BASE_URL`, `ASR_API_KEY`, `ASR_MODEL` | — | your approved provider |
| 9 | Razorpay keys | secrets `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `rzp_test_…` | `rzp_live_…` |
| 10 | Razorpay plan (USD 10/month) | secret `RAZORPAY_PLAN_ID` | test-mode plan id | live-mode plan id |
| 11 | Razorpay webhook secret | secret `RAZORPAY_WEBHOOK_SECRET` + Razorpay → Webhooks | test | live |
| 12 | Settlement bank | Razorpay Dashboard → Account & Settings → Bank account (Indian corporate current account) | — | your account |
| 13 | Encryption & cron secrets | secrets `MCP_SECRET_KEY`, `MOCK_BILLING_SECRET`, `CRON_SECRET` | random | new random values |
| 14 | Allowed extension origins | secret `ALLOWED_ORIGINS` | empty (any extension) | `chrome-extension://<chrome-id>,chrome-extension://<edge-id>` |
| 15 | Plan label shown to users | secret `PLAN_LABEL` | US$10 / month | your price text |

Generate random secrets with `openssl rand -base64 36`. After changing secrets, run `supabase secrets set --env-file supabase/functions/.env`. Functions pick up the new values automatically. After changing `config.ts`, rebuild the extension.
