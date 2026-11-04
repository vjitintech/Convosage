// CONVOSAGE AI — API edge function (Supabase). Base URL: https://<project>.supabase.co/functions/v1/api
// Implements the /v1 API of the Production Deployment Blueprint with server-authoritative session state.
import { config, aiConfigured, asrConfigured } from "../_shared/config.ts";
import { sql } from "../_shared/db.ts";
import { authenticate, type AuthUser } from "../_shared/auth.ts";
import { background, bad, corsHeaders, errorResponse, forbidden, HttpError, json, oneOf, randomToken, rateLimit, readBytes, readJson, Router, sha256Hex, str, text, uuid } from "../_shared/http.ts";
import { bootstrapUser, checkAiBudget, DEFAULT_CONTEXT, entitlement, requireEntitlement, requireProgramme, requireSession, requireWorkspace } from "../_shared/access.ts";
import { cancelSubscription, completeMockPayment, createSubscription, providerFor } from "../_shared/billing.ts";
import { connectMcp, encryptSecret, isEnglish, looksEnglish, readFrame, transcribe, translateToEnglish } from "../_shared/model.ts";
import { ask, generateKnowledge, generateQuestions, inferContext, jaccard, latestContext } from "../_shared/intelligence.ts";
import { redact } from "../_shared/redact.ts";

const r = new Router();
const db = () => sql();
const fmt = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
async function me(req: Request): Promise<AuthUser> { const u = await authenticate(req); rateLimit("u:" + u.id); return u; }
async function auditLog(ws: string | null, actor: string | null, type: string, target: string, action: string, meta: Record<string, unknown> = {}) {
  await db()`select app.audit(${ws}, ${actor}, ${type}, ${target}, ${action}, ${db().json(meta as never)})`;
}
async function emit(sessionId: string, ws: string, type: string, payload: Record<string, unknown>) {
  await db()`insert into app.events (session_id, workspace_id, type, payload) values (${sessionId}, ${ws}, ${type}, ${db().json(payload as never)})`;
}
function sessionView(s: Record<string, unknown>) {
  // No session counts in user-facing payloads (blueprint §3.3).
  return { id: s.id, workspace_id: s.workspace_id, programme_id: s.programme_id, title: s.title, platform: s.platform, status: s.status, version: s.version,
    owner_id: s.owner_id, started_at: s.started_at, ended_at: s.ended_at, disabled_at: s.disabled_at, created_at: s.created_at, updated_at: s.updated_at, legal_hold: s.legal_hold };
}

// ---------------------------------------------------------------- health & identity
r.add("GET", "/v1/health", async ({ req }) => {
  let dbOk = false; try { await db()`select 1`; dbOk = true; } catch { /* ignore */ }
  return json(req, { ok: dbOk, ai: aiConfigured(), asr: asrConfigured(), billing: config.billingProvider, version: "2.0.0" });
});

r.add("GET", "/v1/me", async ({ req }) => {
  const u = await me(req);
  await bootstrapUser(u);
  const ws = await db()`select w.id, w.name, w.retention_days, w.keep_raw_media, m.role from app.memberships m join app.workspaces w on w.id = m.workspace_id
                        where m.user_id = ${u.id} and m.status = 'active' order by w.created_at`;
  const ent = await entitlement(u.id);
  return json(req, { user: { id: u.id, phone: u.phone }, workspaces: ws, entitlement: { active: ent.active, provider: ent.subscription?.provider || providerFor(u.phone), status: ent.subscription?.status || null, current_period_end: ent.subscription?.current_period_end || null }, plan: config.planLabel, features: { ai: aiConfigured(), asr: asrConfigured() } });
});

// ---------------------------------------------------------------- billing
r.add("GET", "/v1/billing/status", async ({ req }) => {
  const u = await me(req); const e = await entitlement(u.id);
  return json(req, { active: e.active, provider: e.subscription?.provider || providerFor(u.phone), status: e.subscription?.status || "none", current_period_end: e.subscription?.current_period_end || null, plan: config.planLabel });
});
r.add("POST", "/v1/billing/subscribe", async ({ req }) => {
  const u = await me(req); await bootstrapUser(u);
  const e = await entitlement(u.id); if (e.active) return json(req, { already_active: true });
  const [w] = await db()`select workspace_id from app.memberships where user_id = ${u.id} and role = 'owner' and status = 'active' limit 1`;
  return json(req, await createSubscription(u.id, u.phone, w.workspace_id));
});
r.add("POST", "/v1/billing/cancel", async ({ req }) => json(req, await cancelSubscription((await me(req)).id)));
r.add("POST", "/v1/billing/mock-pay", async ({ req }) => {
  const u = await me(req); const b = await readJson<{ s: string; t: string; card: string }>(req);
  return json(req, await completeMockPayment(u.id, str(b.s, "s", 80), str(b.t, "t", 128), str(b.card, "card", 30)));
});

// ---------------------------------------------------------------- workspaces & admin
r.add("PATCH", "/v1/workspaces/:id", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id); await requireWorkspace(u.id, id, "admin");
  const b = await readJson<{ name?: string; retention_days?: number; keep_raw_media?: boolean }>(req);
  const name = b.name !== undefined ? str(b.name, "name", 120) : null;
  const ret = b.retention_days !== undefined ? Math.round(Number(b.retention_days)) : null;
  if (ret !== null && !(ret >= 1 && ret <= 3650)) throw bad("retention_days must be 1–3650.");
  const [w] = await db()`update app.workspaces set name = coalesce(${name}, name), retention_days = coalesce(${ret}, retention_days),
                         keep_raw_media = coalesce(${typeof b.keep_raw_media === "boolean" ? b.keep_raw_media : null}, keep_raw_media) where id = ${id} returning *`;
  await auditLog(id, u.id, "workspace", id, "workspace.updated", { name, retention_days: ret, keep_raw_media: b.keep_raw_media });
  return json(req, w);
});
r.add("GET", "/v1/workspaces/:id/audit", async ({ req, params, url }) => {
  const u = await me(req); const id = uuid(params.id); await requireWorkspace(u.id, id, "admin");
  const before = Number(url.searchParams.get("before") || 0) || null;
  const rows = await db()`select id, actor_id, target_type, target_id, action, metadata, occurred_at, hash from app.audit_events
                          where workspace_id = ${id} and (${before}::bigint is null or id < ${before}::bigint) order by id desc limit 100`;
  return json(req, { events: rows });
});
r.add("GET", "/v1/workspaces/:id/mcp", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id); await requireWorkspace(u.id, id, "admin");
  const rows = await db()`select id, name, url, enabled, tool_allowlist, (auth_secret_enc is not null) as has_auth, created_at from app.mcp_servers where workspace_id = ${id} order by created_at`;
  return json(req, { servers: rows });
});
r.add("POST", "/v1/workspaces/:id/mcp", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id); await requireWorkspace(u.id, id, "admin");
  const b = await readJson<{ name: string; url: string; token?: string; tool_allowlist?: string[]; enabled?: boolean; server_id?: string }>(req);
  const name = str(b.name, "name", 80); const url = str(b.url, "url", 500);
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw bad("MCP server URL must use https://");
  const allow = (Array.isArray(b.tool_allowlist) ? b.tool_allowlist : []).map((t) => String(t).slice(0, 100)).slice(0, 100);
  const secret = b.token ? await encryptSecret(String(b.token)) : null;
  let row;
  if (b.server_id) {
    [row] = await db()`update app.mcp_servers set name = ${name}, url = ${url}, tool_allowlist = ${allow}, enabled = ${b.enabled !== false},
                       auth_secret_enc = coalesce(${secret}, auth_secret_enc) where id = ${uuid(b.server_id)} and workspace_id = ${id} returning id`;
    if (!row) throw new HttpError(404, "not_found", "MCP server not found.");
  } else {
    [row] = await db()`insert into app.mcp_servers (workspace_id, name, url, auth_secret_enc, tool_allowlist, enabled, created_by)
                       values (${id}, ${name}, ${url}, ${secret}, ${allow}, ${b.enabled !== false}, ${u.id}) returning id`;
  }
  await auditLog(id, u.id, "mcp_server", row.id, "mcp.saved", { name, url, tools: allow });
  return json(req, { id: row.id });
});
r.add("POST", "/v1/workspaces/:id/mcp/:sid/test", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id); await requireWorkspace(u.id, id, "admin");
  const [s] = await db()`select id, name, url, auth_secret_enc from app.mcp_servers where id = ${uuid(params.sid)} and workspace_id = ${id}`;
  if (!s) throw new HttpError(404, "not_found", "MCP server not found.");
  try { const { client, tools } = await connectMcp(s as never); await client.close(); return json(req, { ok: true, tools: tools.map((t) => ({ name: t.name, description: (t.description || "").slice(0, 300) })) }); }
  catch (e) { return json(req, { ok: false, error: String((e as Error).message).slice(0, 300) }); }
});
r.add("DELETE", "/v1/workspaces/:id/mcp/:sid", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id); await requireWorkspace(u.id, id, "admin");
  await db()`delete from app.mcp_servers where id = ${uuid(params.sid)} and workspace_id = ${id}`;
  await auditLog(id, u.id, "mcp_server", params.sid, "mcp.deleted");
  return json(req, { ok: true });
});

// ---------------------------------------------------------------- programmes & context
r.add("GET", "/v1/programmes", async ({ req, url }) => {
  const u = await me(req); const ws = uuid(url.searchParams.get("workspace_id"), "workspace_id"); const role = await requireWorkspace(u.id, ws);
  const rows = await db()`select id, title, description, sharing_policy, created_by, created_at, archived_at from app.programmes
    where workspace_id = ${ws} and (sharing_policy = 'workspace' or created_by = ${u.id} or ${role} in ('owner','admin')) order by archived_at nulls first, created_at desc`;
  return json(req, { programmes: rows });
});
r.add("POST", "/v1/programmes", async ({ req }) => {
  const u = await me(req); const b = await readJson<{ workspace_id: string; title: string; description?: string; sharing_policy?: string }>(req);
  const ws = uuid(b.workspace_id, "workspace_id"); await requireWorkspace(u.id, ws);
  const sharing = b.sharing_policy ? oneOf(b.sharing_policy, ["private", "workspace"] as const, "sharing_policy") : "private";
  const p = await db().begin(async (t) => {
    const [p] = await t`insert into app.programmes (workspace_id, title, description, sharing_policy, created_by) values (${ws}, ${str(b.title, "title", 200)}, ${str(b.description, "description", 2000, false) || null}, ${sharing}, ${u.id}) returning *`;
    await t`insert into app.context_profiles (workspace_id, programme_id, version, content, created_by) values (${ws}, ${p.id}, 1, ${t.json(DEFAULT_CONTEXT)}, ${u.id})`;
    return p;
  });
  await auditLog(ws, u.id, "programme", p.id, "programme.created");
  return json(req, p, 201);
});
r.add("PATCH", "/v1/programmes/:id", async ({ req, params }) => {
  const u = await me(req); const p = await requireProgramme(u.id, uuid(params.id), true);
  const b = await readJson<{ title?: string; description?: string; sharing_policy?: string; archived?: boolean }>(req);
  const [row] = await db()`update app.programmes set title = coalesce(${b.title !== undefined ? str(b.title, "title", 200) : null}, title),
      description = coalesce(${b.description !== undefined ? str(b.description, "description", 2000, false) : null}, description),
      sharing_policy = coalesce(${b.sharing_policy ? oneOf(b.sharing_policy, ["private", "workspace"] as const, "sharing_policy") : null}, sharing_policy),
      archived_at = case when ${b.archived === true} then now() when ${b.archived === false} then null else archived_at end
    where id = ${p.id} returning *`;
  await auditLog(p.workspace_id, u.id, "programme", p.id, "programme.updated", b as Record<string, unknown>);
  return json(req, row);
});
r.add("GET", "/v1/programmes/:id/context", async ({ req, params }) => {
  const u = await me(req); const p = await requireProgramme(u.id, uuid(params.id));
  const versions = await db()`select version, created_at, created_by from app.context_profiles where programme_id = ${p.id} order by version desc limit 20`;
  return json(req, { ...(await latestContext(p.id)), versions });
});
r.add("PUT", "/v1/programmes/:id/context", async ({ req, params }) => {
  const u = await me(req); const p = await requireProgramme(u.id, uuid(params.id), true);
  const b = await readJson<{ content: Record<string, { text: string; source?: string }[]>; base_version?: number }>(req, 200_000);
  const content: Record<string, { text: string; source: "user" | "ai" }[]> = {};
  for (const k of Object.keys(DEFAULT_CONTEXT)) content[k] = (Array.isArray(b.content?.[k]) ? b.content[k] : []).slice(0, 50)
    .map((x) => ({ text: String(x?.text || "").trim().slice(0, 400), source: x?.source === "ai" ? "ai" as const : "user" as const })).filter((x) => x.text);
  const row = await db().begin(async (t) => {
    const [{ v }] = await t`select coalesce(max(version),0) v from app.context_profiles where programme_id = ${p.id}`;
    if (b.base_version !== undefined && Number(b.base_version) !== Number(v)) throw new HttpError(409, "version_conflict", "The context was changed elsewhere. Reload and re-apply your edit.");
    const [row] = await t`insert into app.context_profiles (workspace_id, programme_id, version, content, created_by) values (${p.workspace_id}, ${p.id}, ${Number(v) + 1}, ${t.json(content)}, ${u.id}) returning version, content, created_at`;
    return row;
  });
  await auditLog(p.workspace_id, u.id, "context_profile", p.id, "context.updated", { version: row.version });
  return json(req, row);
});
r.add("POST", "/v1/programmes/:id/context/infer", async ({ req, params }) => {
  const u = await me(req); const p = await requireProgramme(u.id, uuid(params.id), true); await requireEntitlement(u.id); await checkAiBudget(p.workspace_id, config.aiDailyCallLimit);
  const b = await readJson<{ material: string }>(req, 400_000);
  const material = str(b.material, "material", 200_000);
  return json(req, { proposed: await inferContext(p.id, p.workspace_id, u.id, material), note: "Review and save to create a new version. AI-inferred items are marked." });
});
r.add("GET", "/v1/programmes/:id/knowledge", async ({ req, params }) => {
  const u = await me(req); const p = await requireProgramme(u.id, uuid(params.id));
  const rows = await db()`select k.id, k.session_id, s.title as session_title, k.artifact_type, k.content, k.provenance_refs, k.version, k.status, k.created_at
    from app.knowledge_artifacts k left join app.sessions s on s.id = k.session_id
    where k.programme_id = ${p.id} and k.status in ('current','corrected') and (k.session_id is null or s.status not in ('deleted','deletion_pending'))
      and (k.session_id is null or s.owner_id = ${u.id} or ${p.role} in ('owner','admin') or ${String(p.sharing_policy)} = 'workspace')
    order by k.artifact_type, k.created_at desc limit 500`;
  return json(req, { artifacts: rows });
});

// ---------------------------------------------------------------- sessions
r.add("GET", "/v1/sessions", async ({ req, url }) => {
  const u = await me(req); const prog = await requireProgramme(u.id, uuid(url.searchParams.get("programme_id"), "programme_id"));
  const rows = await db()`select * from app.sessions where programme_id = ${prog.id} and status not in ('deleted')
                          and (owner_id = ${u.id} or ${prog.role} in ('owner','admin') or ${String(prog.sharing_policy)} = 'workspace') order by created_at desc limit 200`;
  return json(req, { sessions: rows.map(sessionView) });
});
r.add("POST", "/v1/sessions", async ({ req }) => {
  const u = await me(req); const b = await readJson<{ programme_id: string; title: string; platform?: string }>(req);
  const prog = await requireProgramme(u.id, uuid(b.programme_id, "programme_id"));
  const [s] = await db()`insert into app.sessions (workspace_id, programme_id, owner_id, title, platform, status) values (${prog.workspace_id}, ${prog.id}, ${u.id}, ${str(b.title, "title", 200)}, ${str(b.platform, "platform", 60, false) || null}, 'active') returning *`;
  await auditLog(prog.workspace_id, u.id, "session", s.id, "session.created", { title: s.title });
  return json(req, sessionView(s), 201);
});
r.add("GET", "/v1/sessions/:id", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const caps = await db()`select id, source_types, status, started_at, stopped_at, stop_reason from app.captures where session_id = ${s.id} order by started_at desc limit 5`;
  return json(req, { ...sessionView(s), captures: caps, can_manage: s.owner_id === u.id || ["owner", "admin"].includes(s.role) });
});
r.add("PATCH", "/v1/sessions/:id", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  const b = await readJson<{ title?: string; platform?: string }>(req);
  if (["archived", "deletion_pending"].includes(s.status)) throw new HttpError(409, "read_only", "Archived sessions are read-only.");
  const [row] = await db()`update app.sessions set title = coalesce(${b.title !== undefined ? str(b.title, "title", 200) : null}, title), platform = coalesce(${b.platform !== undefined ? str(b.platform, "platform", 60, false) : null}, platform), updated_at = now() where id = ${s.id} returning *`;
  await auditLog(s.workspace_id, u.id, "session", s.id, "session.renamed", { title: row.title });
  return json(req, sessionView(row));
});
r.add("PATCH", "/v1/sessions/:id/status", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  const b = await readJson<{ status: string; reason_code?: string; expected_version?: number }>(req);
  const to = oneOf(b.status, ["active", "disabled", "archived"] as const, "status");
  const reason = b.reason_code ? str(b.reason_code, "reason_code", 60) : "user_requested";
  const [row] = await db()`select app.transition_session(${s.id}, ${u.id}, ${to}, ${reason}, ${b.expected_version ?? null}) as s`;
  const ns = row.s as Record<string, unknown>;
  return json(req, { session_id: ns.id, status: ns.status, updated_at: ns.updated_at, updated_by: u.id, session_version: ns.version });
});
/** Permanently erase a session's content and mark it Deleted (legal hold respected). */
async function purgeSession(sessionId: string, actor: string | null, reason: string) {
  await db().begin(async (t) => {
    const [s] = await t`select status, legal_hold, workspace_id from app.sessions where id = ${sessionId} for update`;
    if (!s) return;
    if (s.legal_hold) throw new HttpError(409, "legal_hold", "This session is under legal hold and cannot be deleted.");
    if (s.status !== "deletion_pending") await t`select app.transition_session(${sessionId}, ${actor}, 'deletion_pending', ${reason})`;
    await t`delete from app.transcript_segments where session_id = ${sessionId}`; await t`delete from app.visual_evidence where session_id = ${sessionId}`;
    await t`delete from app.question_suggestions where session_id = ${sessionId}`; await t`delete from app.knowledge_artifacts where session_id = ${sessionId}`;
    await t`delete from app.documents where session_id = ${sessionId}`; await t`delete from app.consents where session_id = ${sessionId}`;
    await t`delete from app.jobs where session_id = ${sessionId}`; await t`delete from app.events where session_id = ${sessionId}`;
    await t`select app.transition_session(${sessionId}, ${actor}, 'deleted', ${reason})`;
    await t`select app.audit(${s.workspace_id}, ${actor}, 'session', ${sessionId}::text, 'session.purged', ${t.json({ reason })})`;
  });
}
r.add("DELETE", "/v1/sessions/:id", async ({ req, params, url }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  // Delete means delete: erase now. A grace period is only used when explicitly asked for (?mode=scheduled).
  const mode = url.searchParams.get("mode") === "scheduled" ? "scheduled" : "now";
  if (mode === "now") { await purgeSession(s.id, u.id, "user_requested"); return json(req, { session_id: s.id, status: "deleted", purged: true }); }
  const [row] = await db()`select app.transition_session(${s.id}, ${u.id}, 'deletion_pending', 'user_requested') as s`;
  return json(req, { session_id: s.id, status: (row.s as Record<string, unknown>).status, purge_after_days: config.deletionGraceDays || 7 });
});
r.add("POST", "/v1/sessions/:id/restore", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  const [row] = await db()`select app.transition_session(${s.id}, ${u.id}, 'archived', 'deletion_cancelled') as s`;
  return json(req, { session_id: s.id, status: (row.s as Record<string, unknown>).status });
});

// ---------------------------------------------------------------- capture lifecycle (server-side guard)
r.add("POST", "/v1/sessions/:id/capture/start", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  await requireEntitlement(u.id);
  const b = await readJson<{ source_types: string[]; consent?: { accepted: boolean; statement: string }; browser_info?: Record<string, unknown>; permission_state?: Record<string, unknown> }>(req);
  if (s.status !== "active") throw new HttpError(409, "session_not_active", "This session is not Active. Enable it, then start a new capture.");
  const sources = (Array.isArray(b.source_types) ? b.source_types : []).filter((x) => ["tab_audio", "microphone", "display", "captions", "manual"].includes(x));
  if (!sources.length) throw bad("Choose at least one capture source.");
  if (!b.consent?.accepted || !b.consent.statement) throw new HttpError(412, "consent_required", "Confirm the capture notice before starting.");
  const token = randomToken(32); const hash = await sha256Hex(token);
  const expires = new Date(Date.now() + config.captureTokenTtlSec * 1000);
  const cap = await db().begin(async (t) => {
    await t`update app.captures set status = 'stopped', stopped_at = now(), stop_reason = 'superseded', token_hash = null where session_id = ${s.id} and user_id = ${u.id} and status <> 'stopped'`;
    await t`insert into app.consents (session_id, workspace_id, user_id, statement) values (${s.id}, ${s.workspace_id}, ${u.id}, ${str(b.consent!.statement, "statement", 2000)})`;
    const [c] = await t`insert into app.captures (session_id, workspace_id, user_id, source_types, permission_state, browser_info, token_hash, token_expires_at)
                        values (${s.id}, ${s.workspace_id}, ${u.id}, ${sources}, ${t.json((b.permission_state || {}) as never)}, ${t.json((b.browser_info || {}) as never)}, ${hash}, ${expires}) returning id, started_at`;
    await t`update app.sessions set started_at = coalesce(started_at, now()), updated_at = now() where id = ${s.id}`;
    return c;
  });
  await emit(s.id, s.workspace_id, "CaptureStarted", { event_id: crypto.randomUUID(), session_id: s.id, capture_id: cap.id, source_types: sources, started_at: cap.started_at, browser_info: b.browser_info || {} });
  await auditLog(s.workspace_id, u.id, "capture", cap.id, "capture.started", { sources });
  return json(req, { capture_id: cap.id, capture_token: token, expires_at: expires.toISOString(), session_version: s.version });
});
r.add("POST", "/v1/sessions/:id/capture/refresh", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  const b = await readJson<{ capture_id: string }>(req); const capId = uuid(b.capture_id, "capture_id");
  if (s.status !== "active") throw new HttpError(409, "session_not_active", "This session is not Active.");
  await requireEntitlement(u.id);
  const token = randomToken(32); const expires = new Date(Date.now() + config.captureTokenTtlSec * 1000);
  const rows = await db()`update app.captures set status = 'active', token_hash = ${await sha256Hex(token)}, token_expires_at = ${expires} where id = ${capId} and session_id = ${s.id} and user_id = ${u.id} and status <> 'stopped' returning id`;
  if (!rows.length) throw new HttpError(409, "capture_stopped", "This capture has stopped. Start a new capture.");
  return json(req, { capture_token: token, expires_at: expires.toISOString() });
});
r.add("POST", "/v1/sessions/:id/capture/stop", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const b = await readJson<{ capture_id: string; reason?: string; paused?: boolean }>(req); const capId = uuid(b.capture_id, "capture_id");
  const status = b.paused ? "paused" : "stopped";
  const rows = await db()`update app.captures set status = ${status}, stopped_at = case when ${status} = 'stopped' then now() else stopped_at end,
      stop_reason = ${str(b.reason, "reason", 60, false) || "user_stopped"}, token_hash = case when ${status} = 'stopped' then null else token_hash end
    where id = ${capId} and session_id = ${s.id} and user_id = ${u.id} returning id, last_sequence, stopped_at`;
  if (!rows.length) throw new HttpError(404, "not_found", "Capture not found.");
  if (status === "stopped") {
    try { await emit(s.id, s.workspace_id, "CaptureStopped", { event_id: crypto.randomUUID(), session_id: s.id, capture_id: capId, stopped_at: rows[0].stopped_at, stop_reason: b.reason || "user_stopped", last_sequence: rows[0].last_sequence }); } catch { /* ignore */ }
    await auditLog(s.workspace_id, u.id, "capture", capId, "capture.stopped", { reason: b.reason || "user_stopped" });
    // Whole-meeting wrap-up questions once the attendee stops capture (not when a session is disabled)
    if (s.status === "active" && aiConfigured() && !String(b.reason || "").startsWith("session_") && (await entitlement(u.id)).active) {
      try {
        const [job] = await db()`insert into app.jobs (workspace_id, session_id, kind, payload, state) values (${s.workspace_id}, ${s.id}, 'questions', ${db().json({ actor: u.id, final: true })}, 'queued') returning *`;
        background(runJob(job));
      } catch { /* ignore */ }
    }
  }
  return json(req, { ok: true, status, wrap_up: status === "stopped" });
});

async function validateCapture(req: Request, u: AuthUser, sessionId: string) {
  const s = await requireSession(u.id, sessionId, "owner_or_admin");
  if (s.status !== "active") throw new HttpError(409, "session_not_active", "Session is not Active. Capture stopped.");
  const token = req.headers.get("x-capture-token") || ""; const capId = uuid(req.headers.get("x-capture-id") || "", "capture id");
  if (!token) throw new HttpError(401, "capture_token_required", "Capture authorization missing.");
  const [c] = await db()`select * from app.captures where id = ${capId} and session_id = ${s.id} and user_id = ${u.id}`;
  if (!c || c.status !== "active" || !c.token_hash || c.token_hash !== await sha256Hex(token)) throw new HttpError(409, "capture_stopped", "This capture is no longer authorized. Start a new capture.");
  if (new Date(c.token_expires_at).getTime() < Date.now()) throw new HttpError(401, "capture_token_expired", "Capture authorization expired. Refreshing…");
  return { s, c };
}
async function maybeQueueQuestions(sessionId: string, ws: string, actor: string) {
  if (!aiConfigured()) return;
  const recent = await db()`select 1 from app.jobs where session_id = ${sessionId} and kind = 'questions' and created_at > now() - interval '15 seconds' limit 1`;
  if (recent.length) return;
  try {
    const [job] = await db()`insert into app.jobs (workspace_id, session_id, kind, payload, state) values (${ws}, ${sessionId}, 'questions', ${db().json({ actor })}, 'queued') returning *`;
    background(runJob(job));
  } catch { /* session no longer active */ }
}

// Media ingest: audio chunk (→ASR), screen frame (→OCR/vision) or caption text. Body = raw bytes (or UTF-8 text for captions).
r.add("POST", "/v1/sessions/:id/media", async ({ req, params }) => {
  const u = await me(req); const { s, c } = await validateCapture(req, u, uuid(params.id));
  await requireEntitlement(u.id);
  const kind = oneOf(req.headers.get("x-kind") || "", ["audio", "frame", "captions"] as const, "x-kind");
  const seq = Math.max(0, Math.round(Number(req.headers.get("x-seq") || 0)));
  const startMs = Math.max(0, Math.round(Number(req.headers.get("x-start-ms") || 0)));
  const endMs = Math.max(startMs, Math.round(Number(req.headers.get("x-end-ms") || startMs)));
  const source = req.headers.get("x-source") === "microphone" ? "microphone" : kind === "captions" ? "captions" : "tab_audio";
  // Idempotency: ignore replays of already-processed sequence numbers for this capture.
  const dup = await db()`select 1 from app.events where session_id = ${s.id} and type = 'MediaProcessed' and payload->>'capture_id' = ${c.id} and (payload->>'seq')::int = ${seq} and payload->>'kind' = ${kind} limit 1`;
  if (dup.length) return json(req, { ok: true, duplicate: true });
  await checkAiBudget(s.workspace_id, config.aiDailyCallLimit);
  const [job] = await db()`insert into app.jobs (workspace_id, session_id, kind, payload, state, attempts) values (${s.workspace_id}, ${s.id}, ${kind === "frame" ? "ocr" : "asr"}, ${db().json({ capture_id: c.id, seq, start_ms: startMs })}, 'running', 1) returning id`;
  let inserted = 0;
  try {
    if (kind === "audio") {
      if (!asrConfigured()) throw new HttpError(503, "asr_unconfigured", "Speech-to-text is not configured on the server yet.");
      const bytes = await readBytes(req, config.maxAudioChunkBytes);
      const asr = await transcribe(bytes, req.headers.get("content-type") || "audio/webm");
      const english = isEnglish(asr.language) || asr.segments.every((g) => looksEnglish(g.text));
      const texts = english ? asr.segments.map((g) => g.text) : await translateToEnglish(asr.segments.map((g) => g.text), s.workspace_id, u.id, asr.language);
      for (let i = 0; i < asr.segments.length; i++) {
        const g = asr.segments[i]; const text = texts[i].trim(); if (!text) continue;
        await db()`insert into app.transcript_segments (session_id, workspace_id, capture_id, seq, start_ms, end_ms, text, speaker_label, confidence, source, language, original_text)
                   values (${s.id}, ${s.workspace_id}, ${c.id}, ${seq}, ${startMs + Math.round(g.start * 1000)}, ${startMs + Math.round(Math.max(g.end, g.start) * 1000)}, ${text.slice(0, 4000)}, ${source === "microphone" ? "You (microphone)" : "Unknown speaker"}, ${g.confidence}, ${source},
                           ${english ? "en" : asr.language || null}, ${english || text === g.text ? null : g.text.slice(0, 4000)})`;
        inserted++;
      }
    } else if (kind === "captions") {
      let txt = new TextDecoder().decode(await readBytes(req, 20_000)).trim();
      const orig = txt; if (txt && !looksEnglish(txt)) txt = (await translateToEnglish([txt], s.workspace_id, u.id))[0].trim();
      if (txt) { await db()`insert into app.transcript_segments (session_id, workspace_id, capture_id, seq, start_ms, end_ms, text, speaker_label, confidence, source) values (${s.id}, ${s.workspace_id}, ${c.id}, ${seq}, ${startMs}, ${endMs}, ${txt.slice(0, 4000)}, ${str(req.headers.get("x-speaker"), "speaker", 80, false) || "Unknown speaker"}, null, 'captions')`;
        if (orig !== txt) await db()`update app.transcript_segments set original_text = ${orig.slice(0, 4000)}, language = 'auto' where id = (select max(id) from app.transcript_segments where session_id = ${s.id})`;
        inserted++; }
    } else {
      if (!aiConfigured()) throw new HttpError(503, "ai_unconfigured", "AI is not configured on the server yet.");
      const bytes = await readBytes(req, config.maxFrameBytes);
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw bad("Frames must be JPEG.");
      const v = await readFrame(bytes, s.workspace_id, u.id);
      const last = await db()`select title, extracted_text from app.visual_evidence where session_id = ${s.id} order by timestamp_ms desc limit 1`;
      const transition = !last.length || jaccard(String(last[0].title || "") + " " + String(last[0].extracted_text || ""), v.title + " " + v.text) < 0.6;
      if (v.text || v.title) { await db()`insert into app.visual_evidence (session_id, workspace_id, capture_id, timestamp_ms, extracted_text, type, title, is_transition, confidence, language) values (${s.id}, ${s.workspace_id}, ${c.id}, ${startMs}, ${v.text}, ${v.type}, ${v.title || null}, ${transition}, ${v.confidence}, ${v.language || null})`; inserted++; }
    }
    await db()`update app.jobs set state = 'done', updated_at = now() where id = ${job.id}`;
    await db()`update app.captures set last_sequence = greatest(last_sequence, ${seq}) where id = ${c.id}`;
    await emit(s.id, s.workspace_id, "MediaProcessed", { capture_id: c.id, seq, kind, inserted });
  } catch (e) {
    await db()`update app.jobs set state = 'failed', last_error = ${String((e as Error).message).slice(0, 300)}, updated_at = now() where id = ${job.id}`;
    try { await emit(s.id, s.workspace_id, "MediaFailed", { capture_id: c.id, seq, kind, error: (e as HttpError).code || "processing_failed" }); } catch { /* session may have been disabled */ }
    if (e instanceof HttpError) throw e;
    const raw = String((e as Error).message || "").slice(0, 240);
    if (kind === "audio") throw new HttpError(502, "asr_failed", "Speech-to-text failed (" + raw + "). Check ASR_BASE_URL / ASR_API_KEY / ASR_MODEL and the provider's credit.");
    throw new HttpError(502, "vision_failed", "Reading the screen failed (" + raw + "). Check MODEL_* / VISION_MODEL settings.");
  }
  if (inserted) await maybeQueueQuestions(s.id, s.workspace_id, u.id);
  return json(req, { ok: true, inserted });
});

// Manual notes / pasted transcript (requires Active session; no capture token needed)
r.add("POST", "/v1/sessions/:id/segments", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  if (s.status !== "active") throw new HttpError(409, "session_not_active", "Session is not Active.");
  const b = await readJson<{ segments: { start_ms: number; end_ms?: number; text: string; speaker_label?: string }[]; source?: string }>(req, 2_000_000);
  const source = b.source === "upload" ? "upload" : "manual";
  const segs = (Array.isArray(b.segments) ? b.segments : []).slice(0, 2000);
  let n = 0;
  // Uploaded transcripts in any language are translated to English (original kept) in batches of 40 lines.
  const rows = segs.map((g) => ({ g, t: String(g.text || "").trim() })).filter((x) => x.t);
  const foreign = rows.filter((x) => !looksEnglish(x.t));
  const translated = new Map<number, string>();
  if (foreign.length && aiConfigured()) for (let i = 0; i < foreign.length && i < 800; i += 40) {
    const batch = foreign.slice(i, i + 40); const out = await translateToEnglish(batch.map((x) => x.t), s.workspace_id, u.id);
    batch.forEach((x, k) => translated.set(rows.indexOf(x), out[k]));
  }
  for (let i = 0; i < rows.length; i++) {
    const { g, t } = rows[i]; const en = (translated.get(i) ?? t).trim() || t;
    const st = Math.max(0, Math.round(Number(g.start_ms) || 0));
    await db()`insert into app.transcript_segments (session_id, workspace_id, seq, start_ms, end_ms, text, speaker_label, source, language, original_text) values (${s.id}, ${s.workspace_id}, 0, ${st}, ${Math.max(st, Math.round(Number(g.end_ms) || st))}, ${en.slice(0, 4000)}, ${String(g.speaker_label || "Unknown speaker").slice(0, 80)}, ${source}, ${en !== t ? "auto" : null}, ${en !== t ? t.slice(0, 4000) : null})`;
    n++;
  }
  if (n) { await emit(s.id, s.workspace_id, "TranscriptAdded", { count: n, source }); await auditLog(s.workspace_id, u.id, "session", s.id, "transcript.imported", { segments: n, source }); if (await entitlement(u.id).then((e) => e.active)) await maybeQueueQuestions(s.id, s.workspace_id, u.id); }
  return json(req, { inserted: n });
});

// Live events: long-poll (wait up to 20 s) — p95 delivery < 2 s on a healthy network.
r.add("GET", "/v1/sessions/:id/events", async ({ req, params, url }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const after = Math.max(0, Number(url.searchParams.get("after") || 0));
  const wait = Math.min(20, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  const deadline = Date.now() + wait * 1000;
  while (true) {
    const rows = await db()`select seq, type, payload, created_at from app.events where session_id = ${s.id} and seq > ${after} order by seq limit 200`;
    if (rows.length || Date.now() >= deadline) {
      const [st] = await db()`select status, version from app.sessions where id = ${s.id}`;
      return json(req, { events: rows, session_status: st.status, session_version: st.version, cursor: rows.length ? Number(rows[rows.length - 1].seq) : after });
    }
    await new Promise((res) => setTimeout(res, 700));
  }
});
r.add("GET", "/v1/sessions/:id/transcript", async ({ req, params, url }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const after = Number(url.searchParams.get("after_id") || 0);
  const rows = await db()`select id, start_ms, end_ms, text, speaker_label, confidence, source, capture_id, language, original_text from app.transcript_segments where session_id = ${s.id} and id > ${after} order by start_ms, id limit 2000`;
  return json(req, { segments: rows });
});
r.add("GET", "/v1/sessions/:id/visual", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const rows = await db()`select id, timestamp_ms, type, title, extracted_text, is_transition, confidence from app.visual_evidence where session_id = ${s.id} order by timestamp_ms limit 500`;
  return json(req, { evidence: rows });
});

// ---------------------------------------------------------------- questions
r.add("GET", "/v1/sessions/:id/questions", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const rows = await db()`select id, text, rationale, category, priority, confidence, evidence_refs, tool_refs, state, answer_text, answer_refs, answer_confirmed, feedback, created_at, updated_at, coalesce(model_meta->>'phase','live') as phase
                          from app.question_suggestions where session_id = ${s.id} order by created_at desc limit 500`;
  return json(req, { questions: rows });
});
r.add("POST", "/v1/sessions/:id/questions/generate", async ({ req, params, url }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  await requireEntitlement(u.id); await checkAiBudget(s.workspace_id, config.aiDailyCallLimit);
  if (s.status !== "active") throw new HttpError(409, "session_not_active", "Session is not Active.");
  return json(req, await generateQuestions(s.id, u.id, { final: url.searchParams.get("final") === "1" }));
});
r.add("PATCH", "/v1/questions/:id", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id);
  const [q] = await db()`select session_id from app.question_suggestions where id = ${id}`; if (!q) throw new HttpError(404, "not_found", "Question not found.");
  const s = await requireSession(u.id, q.session_id);
  const b = await readJson<{ state?: string; feedback?: string | null; answer_text?: string; answer_confirmed?: boolean; text?: string }>(req);
  const state = b.state ? oneOf(b.state, ["suggested", "saved", "dismissed", "answered"] as const, "state") : null;
  const fb = b.feedback === null ? "__clear" : b.feedback ? oneOf(b.feedback, ["up", "down"] as const, "feedback") : null;
  const [row] = await db()`update app.question_suggestions set state = coalesce(${state}, state),
      feedback = case when ${fb} = '__clear' then null else coalesce(${fb}, feedback) end,
      answer_text = coalesce(${b.answer_text !== undefined ? str(b.answer_text, "answer_text", 3000, false) : null}, answer_text),
      answer_confirmed = coalesce(${typeof b.answer_confirmed === "boolean" ? b.answer_confirmed : null}, answer_confirmed),
      text = coalesce(${b.text !== undefined ? str(b.text, "text", 400) : null}, text), updated_at = now()
    where id = ${id} returning *`;
  await auditLog(s.workspace_id, u.id, "question", id, "question.updated", { state, feedback: b.feedback, answer_confirmed: b.answer_confirmed });
  return json(req, row);
});

// ---------------------------------------------------------------- knowledge
r.add("GET", "/v1/sessions/:id/knowledge", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const rows = await db()`select id, artifact_type, content, provenance_refs, version, status, model_meta, created_at from app.knowledge_artifacts where session_id = ${s.id} and status in ('current','corrected') order by artifact_type, created_at`;
  return json(req, { artifacts: rows, session_status: s.status });
});
r.add("POST", "/v1/sessions/:id/knowledge/generate", async ({ req, params }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id), "owner_or_admin");
  await requireEntitlement(u.id); await checkAiBudget(s.workspace_id, config.aiDailyCallLimit);
  if (s.status !== "active") throw new HttpError(409, "session_not_active", "Session is not Active. Enable it to generate new knowledge.");
  return json(req, await generateKnowledge(s.id, u.id));
});
r.add("PATCH", "/v1/knowledge/:id", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id);
  const [k] = await db()`select * from app.knowledge_artifacts where id = ${id}`; if (!k) throw new HttpError(404, "not_found", "Not found.");
  if (k.session_id) await requireSession(u.id, k.session_id, "owner_or_admin"); else await requireProgramme(u.id, k.programme_id, true);
  const b = await readJson<{ content?: Record<string, unknown>; status?: string }>(req, 100_000);
  const status = b.status ? oneOf(b.status, ["archived", "corrected", "current"] as const, "status") : null;
  const content = b.content && typeof b.content === "object" ? Object.fromEntries(Object.entries(b.content).slice(0, 10).map(([kk, v]) => [kk.slice(0, 40), typeof v === "string" ? v.slice(0, 4000) : v === null ? null : String(v).slice(0, 400)])) : null;
  const [row] = await db()`update app.knowledge_artifacts set content = coalesce(${content ? db().json(content as never) : null}, content), status = coalesce(${status}, case when ${!!content} then 'corrected' else status end) where id = ${id} returning *`;
  await auditLog(k.workspace_id, u.id, "knowledge", id, "knowledge.corrected", { status: row.status });
  return json(req, row);
});
r.add("POST", "/v1/ask", async ({ req }) => {
  const u = await me(req); await requireEntitlement(u.id);
  const b = await readJson<{ workspace_id: string; programme_id?: string; question: string }>(req);
  const ws = uuid(b.workspace_id, "workspace_id"); await requireWorkspace(u.id, ws); await checkAiBudget(ws, config.aiDailyCallLimit);
  const prog = b.programme_id ? (await requireProgramme(u.id, uuid(b.programme_id, "programme_id"))).id : null;
  return json(req, await ask(u.id, ws, prog, str(b.question, "question", 1000)));
});

// ---------------------------------------------------------------- documents (text extracted client-side; validated server-side)
const DOC_TYPES = ["text/plain", "text/markdown", "text/vtt", "application/x-subrip", "text/csv", "application/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
r.add("POST", "/v1/uploads", async ({ req }) => {
  const u = await me(req); const b = await readJson<{ programme_id: string; session_id?: string; title: string; mime_type: string; size_bytes: number; sha256?: string; text: string }>(req, config.maxUploadTextChars * 2 + 10_000);
  const prog = await requireProgramme(u.id, uuid(b.programme_id, "programme_id"), true);
  if (b.session_id) { const s = await requireSession(u.id, uuid(b.session_id, "session_id")); if (s.programme_id !== prog.id) throw bad("Session is not in this programme."); }
  const mime = oneOf(b.mime_type, DOC_TYPES as unknown as readonly string[], "mime_type");
  const size = Number(b.size_bytes); if (!(size > 0 && size <= 50_000_000)) throw bad("File must be under 50 MB.");
  const textBody = String(b.text || ""); if (textBody.length > config.maxUploadTextChars) throw bad("Extracted text is too long.");
  // Content checks (no executable content, NUL bytes, or script payloads stored as documents)
  const rejected = /\u0000/.test(textBody) || /<script[\s>]/i.test(textBody);
  const [ws] = await db()`select retention_days from app.workspaces where id = ${prog.workspace_id}`;
  const [d] = await db()`insert into app.documents (workspace_id, programme_id, session_id, owner_id, title, mime_type, size_bytes, sha256, processing_state, extracted_text, error, retention_until)
     values (${prog.workspace_id}, ${prog.id}, ${b.session_id || null}, ${u.id}, ${str(b.title, "title", 200)}, ${mime}, ${size}, ${b.sha256 ? str(b.sha256, "sha256", 64) : null},
             ${rejected ? "rejected" : "ready"}, ${rejected ? null : textBody}, ${rejected ? "Content failed safety checks" : null}, now() + make_interval(days => ${ws.retention_days}))
     returning id, title, processing_state, error, created_at`;
  await auditLog(prog.workspace_id, u.id, "document", d.id, "document.uploaded", { title: d.title, state: d.processing_state, mime });
  return json(req, d, 201);
});
r.add("GET", "/v1/programmes/:id/documents", async ({ req, params }) => {
  const u = await me(req); const p = await requireProgramme(u.id, uuid(params.id));
  const rows = await db()`select id, title, mime_type, size_bytes, processing_state, error, session_id, created_at from app.documents where programme_id = ${p.id} order by created_at desc limit 200`;
  return json(req, { documents: rows });
});
r.add("DELETE", "/v1/documents/:id", async ({ req, params }) => {
  const u = await me(req); const id = uuid(params.id);
  const [d] = await db()`select * from app.documents where id = ${id}`; if (!d) throw new HttpError(404, "not_found", "Not found.");
  const role = await requireWorkspace(u.id, d.workspace_id); if (d.owner_id !== u.id && !["owner", "admin"].includes(role)) throw forbidden();
  await db()`delete from app.documents where id = ${id}`; await auditLog(d.workspace_id, u.id, "document", id, "document.deleted");
  return json(req, { ok: true });
});

// ---------------------------------------------------------------- export (permission-checked, audited)
r.add("GET", "/v1/sessions/:id/export", async ({ req, params, url }) => {
  const u = await me(req); const s = await requireSession(u.id, uuid(params.id));
  const format = oneOf(url.searchParams.get("format") || "md", ["md", "json", "csv"] as const, "format");
  const R = url.searchParams.get("redact") === "0" ? (x: string) => x : redact;
  const segs = await db()`select id, start_ms, speaker_label, text, source from app.transcript_segments where session_id = ${s.id} order by start_ms, id`;
  const vis = await db()`select id, timestamp_ms, type, title, extracted_text from app.visual_evidence where session_id = ${s.id} order by timestamp_ms`;
  const qs = await db()`select id, text, rationale, category, priority, confidence, state, evidence_refs, answer_text, answer_confirmed from app.question_suggestions where session_id = ${s.id} and state <> 'dismissed' order by created_at`;
  const kn = await db()`select artifact_type, content, provenance_refs from app.knowledge_artifacts where session_id = ${s.id} and status in ('current','corrected') order by artifact_type, created_at`;
  await auditLog(s.workspace_id, u.id, "session", s.id, "session.exported", { format, redacted: R === redact });
  if (format === "json") return json(req, { session: sessionView(s), transcript: segs.map((g) => ({ ...g, text: R(g.text) })), visual_evidence: vis.map((v) => ({ ...v, extracted_text: R(v.extracted_text || "") })), questions: qs.map((q) => ({ ...q, text: R(q.text), answer_text: q.answer_text ? R(q.answer_text) : null })), knowledge: kn });
  if (format === "csv") {
    const c = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["question", "category", "priority", "confidence", "state", "evidence", "answer", "answer_status"], ...qs.map((q) => [R(q.text), q.category, q.priority, q.confidence, q.state, (q.evidence_refs as { ref: string }[]).map((e) => e.ref).join(" "), q.answer_text ? R(q.answer_text) : "", q.answer_text ? (q.answer_confirmed ? "confirmed" : "ai_draft") : ""])];
    return text(req, rows.map((r) => r.map(c).join(",")).join("\r\n"), "text/csv; charset=utf-8");
  }
  const by = (t: string) => kn.filter((k) => k.artifact_type === t);
  const L: string[] = [`# ${R(s.title)}`, `*CONVOSAGE AI export · ${new Date().toISOString()} · status ${s.status}*`, "", "> AI-generated content may be wrong. Items marked AI draft are unverified; evidence ids refer to the transcript (T) and visual evidence (V).", ""];
  const sec = (title: string, items: string[]) => { if (items.length) { L.push(`## ${title}`, ...items, ""); } };
  sec("Summary", by("summary").map((k) => R(String((k.content as { text: string }).text)) + ` (${(k.provenance_refs as string[]).join(", ")})`));
  sec("Decisions", by("decision").map((k) => `- ${R(String((k.content as { text: string }).text))} (${(k.provenance_refs as string[]).join(", ")})`));
  sec("Actions", by("action").map((k) => { const c = k.content as { text: string; owner?: string; due?: string }; return `- ${R(c.text)} — owner: ${c.owner || "not stated"}, due: ${c.due || "not stated"} (${(k.provenance_refs as string[]).join(", ")})`; }));
  sec("Open questions", by("open_question").map((k) => `- ${R(String((k.content as { text: string }).text))}`));
  sec("Contradictions & gaps", [...by("contradiction"), ...by("gap")].map((k) => `- ${R(String((k.content as { text: string }).text))}`));
  sec("Glossary", by("glossary").map((k) => { const c = k.content as { term: string; definition: string }; return `- **${R(c.term)}** — ${R(c.definition || "")}`; }));
  sec("Questions", qs.map((q, i) => `${i + 1}. [${q.priority} · ${q.category} · ${q.state}] ${R(q.text)}\n   - Why: ${R(q.rationale || "")}\n   - Evidence: ${(q.evidence_refs as { ref: string }[]).map((e) => e.ref).join(", ") || "general check"}${q.answer_text ? `\n   - Answer (${q.answer_confirmed ? "confirmed" : "AI draft"}): ${R(q.answer_text)}` : ""}`));
  sec("Visual evidence", vis.map((v) => `- V${v.id} [${fmt(v.timestamp_ms)}] ${v.type}${v.title ? ` — ${R(v.title)}` : ""}`));
  sec("Transcript", segs.map((g) => `- T${g.id} \`${fmt(g.start_ms)}\` **${g.speaker_label}:** ${R(g.text)}`));
  return text(req, L.join("\n"), "text/markdown; charset=utf-8");
});

// ---------------------------------------------------------------- background jobs (retries, dead letters, retention & deletion)
async function runJob(job: Record<string, unknown>) {
  const id = job.id as string;
  const claimed = await db()`update app.jobs set state = 'running', attempts = attempts + 1, updated_at = now() where id = ${id} and state in ('queued','failed') returning *`;
  if (!claimed.length) return;
  try {
    const p = (job.payload || {}) as { actor?: string; final?: boolean };
    if (job.kind === "questions") await generateQuestions(job.session_id as string, p.actor || null, { final: !!(p as { final?: boolean }).final });
    else if (job.kind === "knowledge") await generateKnowledge(job.session_id as string, p.actor || null);
    await db()`update app.jobs set state = 'done', updated_at = now() where id = ${id} and state = 'running'`;
  } catch (e) {
    const j = claimed[0];
    const dead = Number(j.attempts) >= Number(j.max_attempts);
    await db()`update app.jobs set state = ${dead ? "dead" : "failed"}, last_error = ${String((e as Error).message).slice(0, 400)}, run_after = now() + interval '30 seconds', updated_at = now() where id = ${id} and state = 'running'`;
  }
}
r.add("POST", "/v1/internal/run-jobs", async ({ req }) => {
  if (!config.cronSecret || req.headers.get("authorization") !== "Bearer " + config.cronSecret) throw forbidden();
  const jobs = await db()`select j.* from app.jobs j join app.sessions s on s.id = j.session_id where j.state in ('queued','failed') and j.run_after <= now() and s.status = 'active' and j.kind in ('questions','knowledge') order by j.created_at limit 10`;
  for (const j of jobs) await runJob(j);
  // Deletion: purge sessions pending deletion beyond the grace period (legal hold respected by the state machine)
  const purge = await db()`select id, workspace_id from app.sessions where status = 'deletion_pending' and not legal_hold and deletion_requested_at < now() - make_interval(days => ${config.deletionGraceDays}) limit 20`;
  for (const s of purge) { try { await purgeSession(s.id, null, "retention_purge"); } catch (e) { console.error("purge failed", s.id, e); } }
  // Retention: expire documents past retention
  const expired = await db()`delete from app.documents where retention_until < now() returning id`;
  return json(req, { jobs: jobs.length, purged_sessions: purge.length, expired_documents: expired.length });
});

// ---------------------------------------------------------------- server
export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  const url = new URL(req.url);
  // Accept both /functions/v1/api/v1/... (Supabase) and /v1/... (local)
  const path = url.pathname.replace(/^\/functions\/v1\/api/, "").replace(/^\/api/, "") || "/";
  try { return await r.handle(req, path); } catch (e) { return errorResponse(req, e); }
}
if (import.meta.main) Deno.serve({ port: Number(Deno.env.get("PORT") || 8000) }, handler);
