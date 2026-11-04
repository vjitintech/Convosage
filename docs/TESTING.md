# Testing the production build with dummy accounts and dummy payments

## Dummy login IDs (no SMS sent)
| Account | Country / phone | OTP |
|---|---|---|
| Dummy user 1 | +91 99999 00001 | 123456 |
| Dummy user 2 | +1 555 010 0002 | 654321 |

On the sign-in screen, under **Test accounts**, click **Use**, then **Send code**, then enter the OTP.

## Dummy payment
The paywall shows **Subscribe — US$10/month**, which opens the in-extension test checkout (no money moves):

| Card | Result |
|---|---|
| 4111 1111 1111 1111 (any expiry and CVV) | payment succeeds; subscription active for 30 days |
| 4000 0000 0000 0002 | declined |

Real customers' numbers go to Razorpay's hosted checkout instead. While you still use `rzp_test_` keys, use Razorpay's own test cards there.

## Suggested manual test script (≈15 min)
1. Sign in as dummy user 1. Confirm the paywall shows, then pay with the decline card, then the success card. The header changes to **Pro**.
2. **Settings → AI agent tools:** add an approved MCP server, click **Save & discover tools**, and allow a read-only tool.
3. Create a programme. Open **Context profile**, paste an agenda, click **Draft with AI**, review the suggestions and save.
4. Create a session. In a Zoom, Meet or Teams **web** meeting tab, click the CONVOSAGE toolbar icon, then **Start capture**. Choose *Meeting tab audio* (and optionally *Shared screen*), tick consent, and start.
   - **REC** should appear on the icon.
   - The transcript should appear about every 10 s.
   - Questions should appear with evidence.
5. Click **Disable session** during capture. Capture should stop, REC disappear, and Start capture be blocked. **Enable session**: capture must *not* restart by itself.
6. Run **Knowledge → Generate**, then **Ask** (citations), then **Export** (Markdown/PDF, redacted).
7. Sign out, then sign in as dummy user 2. You should not see user 1's sessions.

## Automated tests
- **Backend:** run `tests/run-backend-tests.sh`. It needs local Postgres 16 + pgvector, Deno 2 and Node 20. It runs 16 integration tests against the real API code and database:
  - authentication and tenant isolation
  - paywall and dummy payment
  - Razorpay webhook signature checks and idempotency
  - consent and capture-token guards
  - audio/frame/caption ingest
  - grounded, deduplicated and MCP-informed questions, with fabricated evidence dropped
  - knowledge with no invented owners
  - cross-session ask with citations
  - disable during capture: stops, revokes and blocks; re-enable never resumes
  - archive and deletion lifecycle
  - redacted export
  - the hash-chained, append-only audit log
- **Extension end to end:**
  1. Run `node tests/mock-gotrue.mjs`, `node tests/mock-ai.mjs` and `node tests/mcp-http-server.mjs`, plus `tests/run-api-local.sh`.
  2. Run `xvfb-run node tests/e2e-extension.mjs`.

  This loads the built extension in Chromium and walks through 20 checks: setup notice, OTP login (wrong and correct), paywall, declined and successful dummy payment, MCP setup, session create, no counts in the UI, transcript import, live questions via events, answer capture, knowledge, ask, Markdown and PDF export, disable/enable, the capture consent gate, and second-user isolation.

Not covered by automation (needs real accounts and devices): live Twilio SMS, live Razorpay charges and payouts, and real tab/screen capture inside a meeting.

## Full local end-to-end (real extension, real tab capture)
```bash
cd extension && npm run build && cd ..
bash tests/run-e2e.sh            # both suites; or: bash tests/run-e2e.sh tests/e2e-capture.mjs
```
`e2e-capture.mjs` opens a "meeting" tab that plays audio and shows a slide, starts capture on that tab (audio + what is shown, no microphone), and checks: tab audio is transcribed, the screen is read, live questions appear with group counts, stopping adds wrap-up questions, and **Delete permanently** erases everything at once.

Run the capture test the way production is configured with Gemini (OpenAI-compatible endpoint), and with a rejected key:
```bash
AI_MODE=openai bash tests/run-e2e.sh tests/e2e-capture.mjs
AI_MODE=openai KEY=bad-key EXPECT_BAD_KEY=1 bash tests/run-e2e.sh tests/e2e-capture.mjs
```
In the app, **Settings → Check AI setup** tests the text model, screen reading and speech-to-text against your real keys.
