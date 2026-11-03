# Blueprint acceptance status (v2.0 build)

Legend: ✅ verified by automated tests · 🟡 implemented, needs manual or real-device verification · ⬜ not in this build

## Functional (blueprint §11)
| ID | Criterion | Status | Evidence |
|---|---|---|---|
| F-01 | Create, view, edit, organise sessions in authorised workspaces | ✅ | api.test: sessions, archive/rename; e2e: create/open |
| F-02 | Owner/admin can disable and re-enable; state persists server-side | ✅ | `app.transition_session`, api.test + e2e |
| F-03 | Disabled sessions reject capture start, media chunks, new jobs | ✅ | DB guard triggers + API checks; api.test |
| F-04 | Disable during capture stops tracks, closes streams, records final event | ✅ server / 🟡 browser | server revokes the token, stops the capture and writes CaptureStopped (tested); the extension stops tracks on disable (needs a real-meeting check) |
| F-05 | Re-enable never auto-starts capture | ✅ | api.test + e2e |
| F-06 | No session count badges or summaries | ✅ | API payloads have no count fields; e2e text check |
| F-07 | Transcript segments include timestamps and provenance | ✅ | start/end ms, source, capture_id |
| F-08 | Visual evidence only from user-selected source | 🟡 | desktopCapture picker only; verify on real devices |
| F-09 | Questions and answers expose evidence and uncertainty | ✅ | evidence refs, confidence, AI-draft vs confirmed; fabricated evidence dropped |
| F-10 | Cross-session retrieval enforces permissions | ✅ | tenant isolation tests; ask() filters visible sessions |
| F-11 | Export, retention, deletion workflows | ✅ export + deletion state / 🟡 purge via cron | purge runs in `/v1/internal/run-jobs` (schedule with cron.example.sql) |
| F-12 | Advertised browser support matches results | 🟡 | Chrome/Chromium tested; Edge expected to be identical; Firefox/Safari not advertised |

## Non-functional
| Area | Status |
|---|---|
| Security | ✅ no secrets in the bundle; JWT verification; default-deny access; token-guarded media; HMAC webhooks; encrypted MCP tokens; prompt-injection guarding; redaction. 🟡 pen-test, SAST/DAST and dependency scanning still to run |
| Reliability | ✅ idempotent media replays, client buffering with back-off, job retries and dead letters. 🟡 load tests |
| Performance | 🟡 measure API p95, live event latency (long-poll), model latency in staging |
| Accessibility | ✅ labels, keyboard focus, status shown as text + icon (not colour only). 🟡 screen-reader audit |
| Privacy | ✅ visible capture state (REC badge), consent recorded per capture, retention, deletion, audited export |
| Recovery | 🟡 enable Supabase PITR; run a timed restore exercise |

## Beyond the blueprint (requested)
| Feature | Status |
|---|---|
| Phone OTP login, any country (Supabase Auth + Twilio Verify) | ✅ flow tested with a local auth stand-in; 🟡 live SMS needs Twilio |
| US$10/month subscription, Razorpay, INR settlement | ✅ webhook and entitlement tested; 🟡 live Razorpay checkout needs your account |
| 2 dummy logins + dummy payment in production | ✅ e2e |
| AI agent with MCP servers (admin allowlist) | ✅ real MCP server over Streamable HTTP in tests |

## Not in this build
⬜ Recording upload with synchronised replay · ⬜ server-side malware scanning of uploads (text-only ingestion with content checks instead) · ⬜ enterprise SSO and multi-member invitations UI · ⬜ Firefox and Safari packages · ⬜ vector (pgvector) semantic retrieval (schema ready; keyword search is used today)
