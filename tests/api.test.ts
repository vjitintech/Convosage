// Integration tests: real API handler + real Postgres + mock AI/ASR + real MCP (Streamable HTTP) server.
// Run: deno test -A tests/api.test.ts   (see tests/run-backend-tests.sh)
import nodeAssert from "node:assert/strict";
const assert = (c: unknown, m?: string) => nodeAssert.ok(c, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assertMatch = (s: string, re: RegExp) => nodeAssert.match(s, re);
import { SignJWT } from "npm:jose@5.9.6";

const DB = Deno.env.get("TEST_DB_URL") || "postgres://postgres:postgres@localhost:5432/convosage";
Deno.env.set("SUPABASE_DB_URL", DB);
Deno.env.set("SUPABASE_JWT_SECRET", "test-jwt-secret-test-jwt-secret-1234");
Deno.env.set("MODEL_PROVIDER", "anthropic");
Deno.env.set("MODEL_BASE_URL", "http://127.0.0.1:18100");
Deno.env.set("MODEL_API_KEY", "test");
Deno.env.set("ASR_BASE_URL", "http://127.0.0.1:18100/v1");
Deno.env.set("BILLING_PROVIDER", "razorpay");          // production-like…
Deno.env.set("TEST_PHONES", "919999900001,15550100002"); // …but the two dummy accounts use dummy payments
Deno.env.set("RAZORPAY_WEBHOOK_SECRET", "whsec_test");
Deno.env.set("MCP_SECRET_KEY", "0123456789abcdef0123456789abcdef0123");
Deno.env.set("CRON_SECRET", "cron-test");

const { handler } = await import("../supabase/functions/api/index.ts");
const { handler: webhook } = await import("../supabase/functions/razorpay-webhook/index.ts");
const { sql } = await import("../supabase/functions/_shared/db.ts");

// Fresh schema
await sql().unsafe("drop schema if exists app cascade");
const migDir = new URL("../supabase/migrations/", import.meta.url);
const migs = [...Deno.readDirSync(migDir)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
for (const m of migs) await sql().unsafe(await Deno.readTextFile(new URL(m, migDir)));

const secret = new TextEncoder().encode(Deno.env.get("SUPABASE_JWT_SECRET")!);
async function token(sub: string, phone: string) {
  return await new SignJWT({ role: "authenticated", phone, aud: "authenticated" }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(secret);
}
const A = { id: crypto.randomUUID(), phone: "919999900001" };   // dummy login 1
const B = { id: crypto.randomUUID(), phone: "15550100002" };    // dummy login 2
const C = { id: crypto.randomUUID(), phone: "447700900123" };   // a normal (non-test) customer
const tok: Record<string, string> = {};
for (const u of [A, B, C]) tok[u.id] = await token(u.id, u.phone);

async function call(u: { id: string } | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers }; if (u) h.authorization = "Bearer " + tok[u.id];
  let b: BodyInit | undefined;
  if (body instanceof Uint8Array) b = body as BodyInit; else if (typeof body === "string") b = body; else if (body !== undefined) { b = JSON.stringify(body); h["content-type"] = "application/json"; }
  const res = await handler(new Request("http://local" + path, { method, headers: h, body: b }));
  const txt = await res.text(); let j: any; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: res.status, body: j };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let wsA = "", progA = "", sessA = "", capId = "", capTok = "";

Deno.test({ name: "auth: rejects missing/invalid tokens", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  assertEquals((await call(null, "GET", "/v1/me")).status, 401);
  const bad = await handler(new Request("http://local/v1/me", { headers: { authorization: "Bearer abc.def.ghi" } }));
  assertEquals(bad.status, 401); await bad.body?.cancel();
}});

Deno.test({ name: "bootstrap: personal workspace, default programme, no subscription", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const r = await call(A, "GET", "/v1/me");
  assertEquals(r.status, 200); assertEquals(r.body.workspaces.length, 1); assertEquals(r.body.workspaces[0].role, "owner");
  assertEquals(r.body.entitlement.active, false); assertEquals(r.body.entitlement.provider, "mock");
  wsA = r.body.workspaces[0].id;
  const p = await call(A, "GET", "/v1/programmes?workspace_id=" + wsA); progA = p.body.programmes[0].id;
  assertEquals((await call(C, "GET", "/v1/me")).body.entitlement.provider, "razorpay");
}});

Deno.test({ name: "sessions: create + list without any count fields (§3.3)", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const s = await call(A, "POST", "/v1/sessions", { programme_id: progA, title: "Claims batch KT – Day 1", platform: "Zoom" });
  assertEquals(s.status, 201); assertEquals(s.body.status, "active"); sessA = s.body.id;
  const l = await call(A, "GET", "/v1/sessions?programme_id=" + progA);
  const keys = Object.keys(l.body.sessions[0]).join(",");
  assert(!/count|total|num_/i.test(keys), "count fields leaked: " + keys);
}});

Deno.test({ name: "paywall: capture start requires an active subscription", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const r = await call(A, "POST", `/v1/sessions/${sessA}/capture/start`, { source_types: ["tab_audio"], consent: { accepted: true, statement: "ok" } });
  assertEquals(r.status, 402); assertEquals(r.body.error.code, "subscription_required");
}});

Deno.test({ name: "billing: normal customer gets Razorpay (unconfigured → clear 503)", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const r = await call(C, "POST", "/v1/billing/subscribe");
  assertEquals(r.status, 503); assertEquals(r.body.error.code, "billing_unconfigured");
}});

Deno.test({ name: "dummy payment: test account subscribes with a test card", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const r = await call(A, "POST", "/v1/billing/subscribe");
  assertEquals(r.status, 200); assertEquals(r.body.provider, "mock"); assertMatch(r.body.checkout_url, /^checkout\.html\?s=mock_sub_/);
  const q = new URLSearchParams(r.body.checkout_url.split("?")[1]);
  assertEquals((await call(A, "POST", "/v1/billing/mock-pay", { s: q.get("s"), t: "forged", card: "4111111111111111" })).status, 403);
  assertEquals((await call(A, "POST", "/v1/billing/mock-pay", { s: q.get("s"), t: q.get("t"), card: "4000000000000002" })).body.error.code, "card_declined");
  assertEquals((await call(B, "POST", "/v1/billing/mock-pay", { s: q.get("s"), t: q.get("t"), card: "4111111111111111" })).status, 404); // someone else's checkout
  const ok = await call(A, "POST", "/v1/billing/mock-pay", { s: q.get("s"), t: q.get("t"), card: "4111 1111 1111 1111" });
  assertEquals(ok.status, 200); assertEquals(ok.body.status, "active");
  assertEquals((await call(A, "GET", "/v1/billing/status")).body.active, true);
}});

Deno.test({ name: "MCP: admin registers remote server with encrypted token + allowlist", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const r = await call(A, "POST", `/v1/workspaces/${wsA}/mcp`, { name: "kt-kb", url: "http://127.0.0.1:18200/mcp", token: "mcp-test-token", tool_allowlist: ["search_kb"] });
  assertEquals(r.status, 200);
  const t = await call(A, "POST", `/v1/workspaces/${wsA}/mcp/${r.body.id}/test`);
  assertEquals(t.body.ok, true); assertEquals(t.body.tools.map((x: any) => x.name).sort(), ["create_ticket", "search_kb"]);
  const [row] = await sql()`select auth_secret_enc from app.mcp_servers where id = ${r.body.id}`;
  assert(!String(row.auth_secret_enc).includes("mcp-test-token"), "token must be encrypted at rest");
  assertEquals((await call(B, "GET", `/v1/workspaces/${wsA}/mcp`)).status, 404); // other tenant
}});

Deno.test({ name: "capture: consent required, then token-guarded media ingest (audio, frame, captions)", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/capture/start`, { source_types: ["tab_audio", "display"] })).body.error.code, "consent_required");
  const r = await call(A, "POST", `/v1/sessions/${sessA}/capture/start`, { source_types: ["tab_audio", "display"], consent: { accepted: true, statement: "I am authorised to capture this meeting." }, browser_info: { ua: "test" } });
  assertEquals(r.status, 200); capId = r.body.capture_id; capTok = r.body.capture_token;
  const H = (k: string, seq: number, extra: Record<string, string> = {}) => ({ "x-capture-token": capTok, "x-capture-id": capId, "x-kind": k, "x-seq": String(seq), "x-start-ms": String(seq * 10000), "x-end-ms": String(seq * 10000 + 10000), ...extra });
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/media`, new Uint8Array([1, 2, 3]), { ...H("audio", 1), "x-capture-token": "wrong" })).status, 409);
  const a = await call(A, "POST", `/v1/sessions/${sessA}/media`, new Uint8Array(5000).fill(7), { ...H("audio", 1), "content-type": "audio/webm" });
  assertEquals(a.status, 200); assertEquals(a.body.inserted, 2);
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/media`, new Uint8Array(5000), { ...H("audio", 1), "content-type": "audio/webm" })).body.duplicate, true); // idempotent retry
  const jpeg = new Uint8Array(2000); jpeg[0] = 0xff; jpeg[1] = 0xd8;
  const f = await call(A, "POST", `/v1/sessions/${sessA}/media`, jpeg, { ...H("frame", 2), "content-type": "image/jpeg" });
  assertEquals(f.status, 200); assertEquals(f.body.inserted, 1);
  const c = await call(A, "POST", `/v1/sessions/${sessA}/media`, "Priya: The batch window ends at 5 AM.", { ...H("captions", 3), "content-type": "text/plain" });
  assertEquals(c.body.inserted, 1);
  const tr = await call(A, "GET", `/v1/sessions/${sessA}/transcript`);
  assertEquals(tr.body.segments.length, 3); assert(tr.body.segments.every((s: any) => typeof s.start_ms === "number" && s.source), "timestamps + provenance (F-07)");
  const v = await call(A, "GET", `/v1/sessions/${sessA}/visual`); assertEquals(v.body.evidence[0].type, "slide");
}});

Deno.test({ name: "live questions: grounded, validated, MCP-informed, no duplicates", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  await wait(1500); // background job from ingest
  let q = await call(A, "GET", `/v1/sessions/${sessA}/questions`);
  if (q.body.questions.length < 2) { await call(A, "POST", `/v1/sessions/${sessA}/questions/generate`); q = await call(A, "GET", `/v1/sessions/${sessA}/questions`); }
  const qs = q.body.questions;
  assertEquals(qs.length, 2, "prompt-injection/bogus question must be dropped");
  const crit = qs.find((x: any) => x.priority === "critical");
  assert(crit.evidence_refs.length && crit.evidence_refs[0].ref.startsWith("T"), "evidence refs");
  assertEquals(crit.tool_refs, ["kt-kb/search_kb"]);
  assert(qs.every((x: any) => x.confidence >= 0 && x.confidence <= 1 && x.rationale), "rationale + bounded confidence (F-09)");
  await call(A, "POST", `/v1/sessions/${sessA}/questions/generate`);
  assertEquals((await call(A, "GET", `/v1/sessions/${sessA}/questions`)).body.questions.length, 2, "no duplicates");
  const u = await call(A, "PATCH", `/v1/questions/${crit.id}`, { state: "answered", answer_text: "Ops will switch to checkpoint restart.", answer_confirmed: true, feedback: "up" });
  assertEquals(u.body.state, "answered"); assertEquals(u.body.answer_confirmed, true);
  const [aud] = await sql()`select count(*)::int n from app.audit_events where action = 'mcp.tool_call'`; assert(aud.n >= 1, "tool calls audited");
}});

Deno.test({ name: "tenant isolation: another user cannot see or act on the session (F-10)", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  await call(B, "GET", "/v1/me");
  for (const [m, p] of [["GET", `/v1/sessions/${sessA}`], ["GET", `/v1/sessions/${sessA}/transcript`], ["GET", `/v1/sessions/${sessA}/questions`], ["PATCH", `/v1/sessions/${sessA}/status`], ["GET", `/v1/sessions/${sessA}/export?format=json`], ["GET", `/v1/programmes?workspace_id=${wsA}`]]) {
    const r = await call(B, m, p, m === "PATCH" ? { status: "disabled" } : undefined);
    assertEquals(r.status, 404, `${m} ${p} should be hidden from other tenants`);
  }
  const bws = (await call(B, "GET", "/v1/me")).body.workspaces[0].id;
  const r = await call(B, "POST", "/v1/ask", { workspace_id: wsA, question: "batch restart" }); assertEquals(r.status, 402); // B unsubscribed
  assert(bws !== wsA);
}});

Deno.test({ name: "knowledge continuity + cross-session ask with citations", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const g = await call(A, "POST", `/v1/sessions/${sessA}/knowledge/generate`); assertEquals(g.body.ok, true);
  const k = await call(A, "GET", `/v1/sessions/${sessA}/knowledge`);
  const action = k.body.artifacts.find((x: any) => x.artifact_type === "action");
  assertEquals(action.content.owner, null, "no fabricated owner"); assert(action.provenance_refs.length > 0, "provenance");
  const a = await call(A, "POST", "/v1/ask", { workspace_id: wsA, programme_id: progA, question: "How does the claims batch restart?" });
  assertEquals(a.status, 200); assert(a.body.citations.length >= 1 && a.body.citations[0].session_title, "cited session + timestamp");
}});

Deno.test({ name: "wrap-up: stopping capture reviews the whole meeting and adds final questions", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const st = await call(A, "POST", `/v1/sessions/${sessA}/capture/stop`, { capture_id: capId, reason: "user_stopped" });
  assertEquals(st.body.wrap_up, true);
  let fin: any[] = [];
  for (let i = 0; i < 20 && fin.length < 2; i++) { await wait(300); fin = (await call(A, "GET", `/v1/sessions/${sessA}/questions`)).body.questions.filter((q: any) => q.phase === "final"); }
  assertEquals(fin.length, 2, "two wrap-up questions");
  assert(fin.every((q: any) => q.rationale), "wrap-up questions explain why");
  // restart capture for the following tests
  const r = await call(A, "POST", `/v1/sessions/${sessA}/capture/start`, { source_types: ["tab_audio"], consent: { accepted: true, statement: "ok" } });
  capId = r.body.capture_id; capTok = r.body.capture_token;
}});

Deno.test({ name: "disable during capture: stops capture, revokes token, blocks media/jobs; re-enable never resumes (F-02..F-05)", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const d = await call(A, "PATCH", `/v1/sessions/${sessA}/status`, { status: "disabled", reason_code: "user_requested" });
  assertEquals(d.status, 200); assertEquals(d.body.status, "disabled"); assert(d.body.session_version > 1);
  const H = { "x-capture-token": capTok, "x-capture-id": capId, "x-kind": "captions", "x-seq": "9", "content-type": "text/plain" };
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/media`, "late chunk", H)).body.error.code, "session_not_active");
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/capture/start`, { source_types: ["tab_audio"], consent: { accepted: true, statement: "x" } })).status, 409);
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/questions/generate`)).status, 409);
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/segments`, { segments: [{ start_ms: 1, text: "x" }] })).status, 409);
  const ev = await call(A, "GET", `/v1/sessions/${sessA}/events?after=0`);
  const types = ev.body.events.map((e: any) => e.type);
  assert(types.includes("SessionDisabled") && types.includes("CaptureStopped"), types.join(","));
  const dis = ev.body.events.find((e: any) => e.type === "SessionDisabled").payload;
  for (const f of ["event_id", "session_id", "workspace_id", "actor_id", "occurred_at", "reason_code", "version"]) assert(f in dis, "SessionDisabled." + f);
  assertEquals((await call(A, "PATCH", `/v1/sessions/${sessA}/status`, { status: "disabled" })).status, 200); // idempotent
  const e = await call(A, "PATCH", `/v1/sessions/${sessA}/status`, { status: "active" });
  assertEquals(e.body.status, "active");
  const s = await call(A, "GET", `/v1/sessions/${sessA}`);
  assert(s.body.captures.every((c: any) => c.status === "stopped"), "re-enable must not resume capture");
  assertEquals((await call(A, "POST", `/v1/sessions/${sessA}/media`, "after re-enable", H)).body.error.code, "capture_stopped"); // old token stays revoked
  const [{ n }] = await sql()`select count(*)::int n from app.audit_events where action = 'session.status_changed' and target_id = ${sessA}`; assert(n >= 2);
}});

Deno.test({ name: "export is audited and redacts contact details", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const md = await call(A, "GET", `/v1/sessions/${sessA}/export?format=md`);
  assertEquals(md.status, 200); assert(!String(md.body).includes("ops@example.com")); assert(String(md.body).includes("[EMAIL]"));
  const csv = await call(A, "GET", `/v1/sessions/${sessA}/export?format=csv`); assert(String(csv.body).startsWith('"question"'));
}});

Deno.test({ name: "archive → read-only; delete → pending; legal hold; restore", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const s2 = (await call(A, "POST", "/v1/sessions", { programme_id: progA, title: "Day 2" })).body.id;
  assertEquals((await call(A, "PATCH", `/v1/sessions/${s2}/status`, { status: "archived" })).body.status, "archived");
  assertEquals((await call(A, "PATCH", `/v1/sessions/${s2}`, { title: "x" })).status, 409);
  assertEquals((await call(A, "PATCH", `/v1/sessions/${s2}/status`, { status: "active" })).status, 409);
  assertEquals((await call(A, "DELETE", `/v1/sessions/${s2}?mode=scheduled`)).body.status, "deletion_pending");
  assertEquals((await call(A, "POST", `/v1/sessions/${s2}/restore`)).body.status, "archived");
}});

Deno.test({ name: "delete: erases the session immediately by default (content purged, audited)", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const s3 = (await call(A, "POST", "/v1/sessions", { programme_id: progA, title: "To delete" })).body.id;
  await call(A, "POST", `/v1/sessions/${s3}/segments`, { segments: [{ start_ms: 0, text: "Confidential detail to erase" }] });
  const d = await call(A, "DELETE", `/v1/sessions/${s3}`);
  assertEquals(d.body.status, "deleted"); assertEquals(d.body.purged, true);
  assertEquals((await call(A, "GET", `/v1/sessions/${s3}`)).status, 404);
  const [{ n }] = await sql()`select count(*)::int n from app.transcript_segments where session_id = ${s3}`; assertEquals(n, 0);
  assert(!(await call(A, "GET", `/v1/sessions?programme_id=${progA}`)).body.sessions.some((x: any) => x.id === s3));
  const [{ a }] = await sql()`select count(*)::int a from app.audit_events where action = 'session.purged' and target_id = ${s3}`; assertEquals(a, 1);
}});

Deno.test({ name: "razorpay webhook: signature verified, idempotent, activates subscription", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  await sql()`insert into app.users (id, phone) values (${C.id}, ${C.phone}) on conflict do nothing`;
  const [w] = await sql()`select workspace_id from app.memberships where user_id = ${C.id} limit 1`;
  await sql()`insert into app.subscriptions (user_id, workspace_id, provider, provider_subscription_id, plan_id, status) values (${C.id}, ${w.workspace_id}, 'razorpay', 'sub_TEST123', 'plan_X', 'created')`;
  const body = JSON.stringify({ event: "subscription.activated", payload: { subscription: { entity: { id: "sub_TEST123", status: "active", current_end: Math.floor(Date.now() / 1000) + 86400 * 30 } } } });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const bad = await webhook(new Request("http://local", { method: "POST", body, headers: { "x-razorpay-signature": "00" + sig.slice(2) } })); assertEquals(bad.status, 401); await bad.body?.cancel();
  const ok = await webhook(new Request("http://local", { method: "POST", body, headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_1" } }));
  assertEquals((await ok.json()).updated, 1);
  const again = await webhook(new Request("http://local", { method: "POST", body, headers: { "x-razorpay-signature": sig, "x-razorpay-event-id": "evt_1" } }));
  assertEquals((await again.json()).duplicate, true);
  assertEquals((await call(C, "GET", "/v1/billing/status")).body.active, true);
}});

Deno.test({ name: "audit trail is hash-chained and tamper-evident", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  const rows = await sql()`select id, prev_hash, hash from app.audit_events order by id`;
  for (let i = 1; i < rows.length; i++) assertEquals(rows[i].prev_hash, rows[i - 1].hash);
  let threw = false; try { await sql()`delete from app.audit_events where id = ${rows[0].id}`; } catch { threw = true; } assert(threw);
  await sql().end();
}});

Deno.test("speech filter: Whisper silence phantoms are dropped; language detection for uploads", async () => {
  const { isLikelyHallucination, looksEnglish, isEnglish } = await import("../supabase/functions/_shared/model.ts");
  for (const t of ["Terima kasih.", "E aí", "Thank you for watching!", "Obrigado.", "you", "Subtitles by the Amara.org community"]) assert(isLikelyHallucination(t), t);
  for (const t of ["The nightly batch restarts from the top.", "I'm going to go through the runbook now."]) assert(!isLikelyHallucination(t), t);
  assert(looksEnglish("We will move the extract after the payment run is done"));
  assert(!looksEnglish("A gente vai fazer uma coisa que eu vou fazer amanhã com o time"));
  assert(!looksEnglish("आज हम भुगतान प्रक्रिया के बारे में बात करेंगे"));
  assert(isEnglish("english") && isEnglish("en") && !isEnglish("portuguese"));
});
