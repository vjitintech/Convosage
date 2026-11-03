# CONVOSAGE AI — Browser Extension (v2.0)

*Turn meetings into lasting, searchable knowledge.* CONVOSAGE AI is an attendee-controlled meeting intelligence extension for **Chrome and Microsoft Edge** (Manifest V3).
- **Live questions:** it understands spoken discussion and the screen you choose to share with it, then suggests grounded questions while the meeting runs.
- **Knowledge continuity:** it keeps summaries, decisions, actions, glossary terms, open questions and contradictions across multi-day programmes.
- **Cross-session answers:** it answers questions across earlier sessions, with citations.

It never joins a meeting, speaks, or records covertly.

Built to the **CONVOSAGE AI Production Deployment Blueprint v1.0 (03 Nov 2026)**, plus:
- phone **OTP login** for any country (Supabase Auth + Twilio Verify)
- a **US$10/month subscription** via Razorpay: international cards, settled in INR to an Indian corporate current account
- an **AI agent connected to MCP servers**, with an admin-controlled tool allowlist
- **two dummy login IDs with dummy payments**, so you can test the production build

## Repository layout
| Path | What it is |
|---|---|
| `extension/` | MV3 extension (React + TypeScript + Vite). **`extension/src/config.ts` is the only file you edit** before building. |
| `supabase/migrations/` | Postgres schema: tenancy, server-authoritative session state machine, guards, append-only hash-chained audit, billing, MCP. |
| `supabase/functions/api/` | The `/v1` API (Supabase Edge Function, Deno): sessions, capture, media → ASR/OCR, questions, knowledge, ask, export, billing, admin. |
| `supabase/functions/razorpay-webhook/` | Signature-verified, idempotent Razorpay subscription webhook. |
| `supabase/functions/_shared/` | Auth (JWKS + HS256), access control, model gateway (Claude / OpenAI-compatible / Ollama, ASR, vision, MCP tools), intelligence engines, billing, redaction. |
| `supabase/config.toml` | Auth (Twilio Verify, test OTP numbers), function settings. |
| `supabase/functions/.env.example` | Every server secret, documented. |
| `tests/` | Backend integration tests (16) and extension end-to-end test (20 checks) with mock AI, a real MCP server and mock auth. |
| `docs/` | Deployment, credentials checklist, testing, user and install guide, acceptance status. |

## Quick start (testing)
1. Follow **docs/DEPLOYMENT.md** to create the Supabase project, push the schema, set secrets and deploy the functions (about 30 minutes).
2. Put your Supabase URL and publishable key in `extension/src/config.ts`, then run `cd extension && npm install && npm run build`.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `extension/dist`.
4. Sign in with a dummy account and pay with the dummy card. Details are in **docs/TESTING.md**:

| Dummy login | Phone | OTP | Payment |
|---|---|---|---|
| Dummy user 1 | +91 99999 00001 | 123456 | dummy checkout · card 4111 1111 1111 1111 |
| Dummy user 2 | +1 555 010 0002 | 654321 | dummy checkout · card 4111 1111 1111 1111 |

When you go live, replace your credentials using **docs/CREDENTIALS.md**. It's one checklist, and no code changes are needed.

## Status
- **What's tested:** everything in the automated tests is verified against real Postgres. It also runs in a real Chromium with the unpacked extension.
- **What needs your accounts and real devices:**
  - live SMS delivery (Twilio)
  - live Razorpay payments and payouts
  - live tab-audio and screen capture inside an actual Zoom, Meet or Teams call
  - Chrome Web Store and Edge Add-ons review
  - Firefox and Safari ports, which are separate builds per the blueprint
  - the pre-release security work listed in the blueprint (§7), such as penetration testing

  See **docs/ACCEPTANCE.md** for the criterion-by-criterion status.
