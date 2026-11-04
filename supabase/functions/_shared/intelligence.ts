// Context Intelligence, Live Question Generation and Knowledge Continuity engines.
import { config } from "./config.ts";
import { sql } from "./db.ts";
import { chatJSON } from "./model.ts";
import { redact } from "./redact.ts";
import { DEFAULT_CONTEXT } from "./access.ts";

const STOP = new Set("a an the and or of to in on for is are was were be been it this that with as at by from how what which who when where why do does did can could would should will we you they our your their there here into about any all if then than so not no yes i me my its has have had also just more most such per via".split(" "));
export const toks = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
export const jaccard = (a: string, b: string) => { const A = new Set(toks(a)), B = new Set(toks(b)); if (!A.size || !B.size) return 0; let i = 0; A.forEach((x) => B.has(x) && i++); return i / (A.size + B.size - i); };
export const dedupeKey = (s: string) => [...new Set(toks(s))].sort().slice(0, 14).join("-") || "q";
const fmt = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

export async function latestContext(programmeId: string) {
  const r = await sql()`select version, content, created_at from app.context_profiles where programme_id = ${programmeId} order by version desc limit 1`;
  return r[0] ? { version: r[0].version as number, content: r[0].content as Record<string, { text: string; source: "user" | "ai" }[]>, created_at: r[0].created_at } : { version: 0, content: DEFAULT_CONTEXT as never, created_at: null };
}
function contextForPrompt(c: Record<string, { text: string; source: string }[]>) {
  return Object.entries(c).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${k}: ${v.map((x) => `${redact(x.text)}${x.source === "ai" ? " (AI-inferred)" : ""}`).join("; ")}`).join("\n") || "(no context profile yet)";
}

async function emit(sessionId: string, workspaceId: string, type: string, payload: unknown) {
  await sql()`insert into app.events (session_id, workspace_id, type, payload) values (${sessionId}, ${workspaceId}, ${type}, ${sql().json(payload as never)})`;
}

// ---------------------------------------------------------------- Live Question Generation Engine
const CATS = ["strategic", "technical", "clarification", "risk", "decision", "follow_up"] as const;
const PRIS = ["critical", "high", "medium", "low"] as const;

export async function generateQuestions(sessionId: string, actorId: string | null, opts: { final?: boolean } = {}) {
  const final = !!opts.final;
  const db = sql();
  const [s] = await db`select s.*, p.title as programme_title from app.sessions s join app.programmes p on p.id = s.programme_id where s.id = ${sessionId}`;
  if (!s || s.status !== "active") return { added: 0, skipped: "session_not_active" };
  const ctx = await latestContext(s.programme_id);
  const segs = final
    ? (await db`select id, start_ms, end_ms, speaker_label, text from app.transcript_segments where session_id = ${sessionId} order by start_ms, id limit 3000`).reverse()
    : await db`select id, start_ms, end_ms, speaker_label, text from app.transcript_segments where session_id = ${sessionId} order by start_ms desc, id desc limit 70`;
  const vis = await db`select id, timestamp_ms, type, title, extracted_text from app.visual_evidence where session_id = ${sessionId} and coalesce(extracted_text,'') <> '' order by timestamp_ms desc limit ${final ? 60 : 8}`;
  if (!segs.length && !vis.length) return { added: 0, skipped: "no_evidence" };
  const existing = await db`select id, text, state from app.question_suggestions where session_id = ${sessionId} order by created_at`;
  const prior = await db`select artifact_type, content from app.knowledge_artifacts where programme_id = ${s.programme_id} and status = 'current'
                         and artifact_type in ('open_question','gap','contradiction') and (session_id is null or session_id <> ${sessionId}) order by created_at desc limit 15`;
  let transcript = segs.slice().reverse().map((g) => `T${g.id} [${fmt(g.start_ms)}] ${g.speaker_label}: ${redact(g.text)}`).join("\n");
  if (final && transcript.length > 70000) transcript = segs.slice().reverse().map((g) => `T${g.id} [${fmt(g.start_ms)}] ${g.speaker_label}: ${redact(g.text).slice(0, 140)}`).join("\n").slice(-90000);
  const visual = vis.slice().reverse().map((v) => `V${v.id} [${fmt(v.timestamp_ms)}] ${v.type}${v.title ? ` "${redact(v.title)}"` : ""}: ${redact(String(v.extracted_text)).slice(0, 700)}`).join("\n");

  const prompt = `TASK: ${final ? "Suggest questions for the end of the meeting (WRAP-UP). The attendee has the WHOLE meeting below. Propose follow-up questions about unresolved gaps, decisions to confirm, risks, dependencies and items answered only partially — the things worth asking before everyone leaves or in a follow-up email." : "Suggest questions the attendee could ask NOW in this live meeting."}

CONTEXT PROFILE (programme "${s.programme_title}", session "${redact(s.title)}"):
${contextForPrompt(ctx.content)}

OPEN ITEMS FROM EARLIER SESSIONS (knowledge continuity):
${prior.map((p) => `- ${p.artifact_type}: ${redact(JSON.stringify(p.content)).slice(0, 300)}`).join("\n") || "(none)"}

<evidence>
TRANSCRIPT (id [time] speaker: text):
${transcript || "(none)"}
VISUAL EVIDENCE FROM USER-SELECTED SCREEN (id [time] type: text):
${visual || "(none)"}
</evidence>

EXISTING QUESTIONS (never repeat or rephrase): ${JSON.stringify(existing.map((q) => ({ id: q.id, text: q.text, state: q.state })))}

RULES
- Up to ${final ? 6 : 3} new questions. Each must add value, fit the context profile, not be answered already in the evidence, be concise enough to ask aloud (<= 30 words).
- Ground each question in evidence ids (T…/V…). If it is a general check with no direct evidence, use evidence [] and confidence <= 0.5.
- If tools are available, you may look up approved reference material for a sharper question; list the tool in tool_refs. Never present tool content as something said in the meeting.
- Also report existing suggested/saved questions that the evidence has now answered, with a short grounded answer and evidence ids.
Return ONLY JSON:
{"questions":[{"text":"","rationale":"why it matters","category":"strategic|technical|clarification|risk|decision|follow_up","priority":"critical|high|medium|low","confidence":0.0,"evidence":["T1"],"evidence_quote":"short quote","tool_refs":[]}],
 "answered":[{"question_id":"","answer":"","evidence":["T9"]}]}`;

  const { data, meta } = await chatJSON<{ questions?: Record<string, unknown>[]; answered?: Record<string, unknown>[] }>({ workspaceId: s.workspace_id, actorId, prompt, useTools: true, purpose: final ? "questions_final" : "questions", large: final, maxTokens: final ? 4000 : 3000 });
  const segIds = new Set(segs.map((g) => "T" + g.id)); const visIds = new Set(vis.map((v) => "V" + v.id));
  const validRefs = (refs: unknown) => (Array.isArray(refs) ? refs : []).map(String).filter((r) => segIds.has(r) || visIds.has(r)).slice(0, 6);
  let added = 0;
  for (const q of (data.questions || []).slice(0, final ? 6 : 3)) {
    const text = String(q.text || "").trim().slice(0, 400);
    if (text.length < 8) continue;
    if (existing.some((e) => jaccard(e.text, text) >= 0.55)) continue;
    const claimed = (Array.isArray(q.evidence) ? q.evidence : []).length;
    const refs = validRefs(q.evidence);
    if (claimed && !refs.length) continue; // cites evidence that does not exist → fabricated, drop it
    let conf = Math.max(0, Math.min(1, Number(q.confidence) || 0.5)); if (!refs.length) conf = Math.min(conf, 0.5);
    const cat = CATS.includes(q.category as never) ? q.category : "clarification";
    const pri = PRIS.includes(q.priority as never) ? q.priority : "medium";
    const evidenceRefs = refs.map((r) => {
      const g = r.startsWith("T") ? segs.find((x) => "T" + x.id === r) : null; const v = r.startsWith("V") ? vis.find((x) => "V" + x.id === r) : null;
      return g ? { ref: r, kind: "transcript", start_ms: g.start_ms, snippet: String(g.text).slice(0, 200) } : { ref: r, kind: "visual", timestamp_ms: v!.timestamp_ms, snippet: String(v!.title || v!.extracted_text || "").slice(0, 200) };
    });
    const toolRefs = (Array.isArray(q.tool_refs) ? q.tool_refs : []).map(String).filter((t) => meta.toolsUsed.some((u) => u === t || u.endsWith("/" + t.split("/").pop()))).slice(0, 3);
    try {
      const [row] = await db`insert into app.question_suggestions (session_id, workspace_id, text, rationale, category, priority, confidence, evidence_refs, tool_refs, dedupe_key, model_meta)
        values (${sessionId}, ${s.workspace_id}, ${text}, ${String(q.rationale || "").slice(0, 600)}, ${cat as string}, ${pri as string}, ${conf}, ${db.json(evidenceRefs)}, ${db.json(toolRefs)}, ${dedupeKey(text)},
                ${db.json({ model: meta.model, provider: meta.provider, quote: String(q.evidence_quote || "").slice(0, 300), phase: final ? "final" : "live" })})
        on conflict (session_id, dedupe_key) do nothing returning id`;
      if (row) { added++; existing.push({ id: row.id, text, state: "suggested" } as never); await emit(sessionId, s.workspace_id, "QuestionSuggested", { question_id: row.id }); }
    } catch (e) { if (!String((e as Error).message).startsWith("session_not_active")) throw e; return { added, skipped: "session_not_active" }; }
  }
  for (const a of (data.answered || []).slice(0, 5)) {
    const id = String(a.question_id || ""); if (!existing.some((e) => e.id === id)) continue;
    const refs = validRefs(a.evidence); if (!refs.length) continue; // answers must be grounded
    const r = await db`update app.question_suggestions set state = 'answered', answer_text = ${String(a.answer || "").slice(0, 1200)}, answer_refs = ${db.json(refs)}, answer_confirmed = false, updated_at = now()
                       where id = ${id} and session_id = ${sessionId} and state in ('suggested','saved') returning id`;
    if (r.length) await emit(sessionId, s.workspace_id, "QuestionAnswered", { question_id: id });
  }
  return { added };
}

// ---------------------------------------------------------------- Context Intelligence Engine
export async function inferContext(programmeId: string, workspaceId: string, actorId: string, material: string) {
  const ctx = await latestContext(programmeId);
  const prompt = `Build a context profile for a meeting programme from the material below. Keep it factual; mark nothing as certain unless the material says it.
CURRENT PROFILE (user-provided items must be kept exactly):
${JSON.stringify(ctx.content)}
<material>
${redact(material).slice(0, 30000)}
</material>
Return ONLY JSON with arrays of short strings for keys: objectives, domain, technology, audience, terminology, constraints, success_criteria, known_facts, unknowns, entities.`;
  const { data } = await chatJSON<Record<string, string[]>>({ workspaceId, actorId, prompt, purpose: "context_infer" });
  const merged: Record<string, { text: string; source: "user" | "ai" }[]> = {};
  for (const k of Object.keys(DEFAULT_CONTEXT)) {
    const user = ((ctx.content as Record<string, { text: string; source: string }[]>)[k] || []).filter((x) => x.source === "user");
    const ai = (Array.isArray(data[k]) ? data[k] : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 15)
      .filter((t) => !user.some((u) => jaccard(u.text, t) > 0.7)).map((t) => ({ text: t.slice(0, 300), source: "ai" as const }));
    merged[k] = [...user.map((u) => ({ text: u.text, source: "user" as const })), ...ai];
  }
  return merged;
}

// ---------------------------------------------------------------- Knowledge Continuity Engine
export async function generateKnowledge(sessionId: string, actorId: string | null) {
  const db = sql();
  const [s] = await db`select s.*, p.title as programme_title from app.sessions s join app.programmes p on p.id = s.programme_id where s.id = ${sessionId}`;
  if (!s || s.status !== "active") return { ok: false, skipped: "session_not_active" };
  const ctx = await latestContext(s.programme_id);
  const segs = await db`select id, start_ms, speaker_label, text from app.transcript_segments where session_id = ${sessionId} order by start_ms, id`;
  const vis = await db`select id, timestamp_ms, type, title, extracted_text from app.visual_evidence where session_id = ${sessionId} and coalesce(extracted_text,'') <> '' order by timestamp_ms limit 60`;
  const qs = await db`select text, state, answer_text, answer_confirmed from app.question_suggestions where session_id = ${sessionId} and state <> 'dismissed'`;
  const prior = await db`select k.artifact_type, k.content, k.session_id, ss.title from app.knowledge_artifacts k left join app.sessions ss on ss.id = k.session_id
                         where k.programme_id = ${s.programme_id} and k.status = 'current' and (k.session_id is null or k.session_id <> ${sessionId})
                         and k.artifact_type in ('topic','decision','open_question','glossary') order by k.created_at desc limit 40`;
  if (!segs.length && !vis.length) return { ok: false, skipped: "no_evidence" };
  let transcript = segs.map((g) => `T${g.id} [${fmt(g.start_ms)}] ${g.speaker_label}: ${redact(g.text)}`).join("\n");
  if (transcript.length > 60000) transcript = transcript.slice(-60000);
  const prompt = `Create the knowledge record for this meeting session. Only include what the evidence supports, cite evidence ids, and assign action owners or due dates ONLY when explicitly stated (else null).
CONTEXT PROFILE: ${contextForPrompt(ctx.content)}
PROGRAMME LEDGER FROM EARLIER SESSIONS (for continuity, gaps and contradictions):
${prior.map((p) => `- [${p.title || "programme"}] ${p.artifact_type}: ${redact(JSON.stringify(p.content)).slice(0, 250)}`).join("\n") || "(none)"}
<evidence>
${transcript}
${vis.map((v) => `V${v.id} [${fmt(v.timestamp_ms)}] ${v.type} ${v.title ? `"${redact(v.title)}"` : ""}: ${redact(String(v.extracted_text)).slice(0, 500)}`).join("\n")}
</evidence>
QUESTIONS RAISED: ${JSON.stringify(qs.map((q) => ({ q: q.text, state: q.state, answer: q.answer_text, confirmed: q.answer_confirmed })))}
Return ONLY JSON:
{"summary":{"text":"5-8 sentences","refs":["T1"]},
 "topics":[{"title":"","refs":[]}], "decisions":[{"text":"","refs":[]}], "actions":[{"text":"","owner":null,"due":null,"refs":[]}],
 "glossary":[{"term":"","definition":"","refs":[]}], "open_questions":[{"text":"","refs":[]}],
 "contradictions":[{"text":"what conflicts with an earlier session and how","refs":[]}], "gaps":[{"text":"","refs":[]}]}`;
  const { data, meta } = await chatJSON<Record<string, unknown>>({ workspaceId: s.workspace_id, actorId, prompt, large: true, useTools: true, purpose: "knowledge", maxTokens: 4000 });
  const ids = new Set([...segs.map((g) => "T" + g.id), ...vis.map((v) => "V" + v.id)]);
  const refsOf = (x: { refs?: unknown }) => (Array.isArray(x?.refs) ? x.refs : []).map(String).filter((r) => ids.has(r)).slice(0, 8);
  const rows: { type: string; content: Record<string, unknown>; refs: string[] }[] = [];
  const sm = data.summary as { text?: string; refs?: unknown } | undefined;
  if (sm?.text) rows.push({ type: "summary", content: { text: String(sm.text).slice(0, 4000) }, refs: refsOf(sm) });
  const map: [string, string][] = [["topics", "topic"], ["decisions", "decision"], ["actions", "action"], ["glossary", "glossary"], ["open_questions", "open_question"], ["contradictions", "contradiction"], ["gaps", "gap"]];
  for (const [k, type] of map) for (const it of ((data[k] as Record<string, unknown>[]) || []).slice(0, 40)) {
    const c: Record<string, unknown> = {};
    for (const f of ["title", "text", "term", "definition"]) if (it[f]) c[f] = String(it[f]).slice(0, 1500);
    if (type === "action") { c.owner = it.owner ? String(it.owner).slice(0, 120) : null; c.due = it.due ? String(it.due).slice(0, 60) : null; }
    if (Object.keys(c).length) rows.push({ type, content: c, refs: refsOf(it) });
  }
  await db.begin(async (t) => {
    const [{ v }] = await t`select coalesce(max(version),0)+1 as v from app.knowledge_artifacts where session_id = ${sessionId}`;
    await t`update app.knowledge_artifacts set status = 'superseded' where session_id = ${sessionId} and status = 'current'`;
    for (const r of rows) await t`insert into app.knowledge_artifacts (workspace_id, programme_id, session_id, artifact_type, content, provenance_refs, version, model_meta, created_by)
      values (${s.workspace_id}, ${s.programme_id}, ${sessionId}, ${r.type}, ${t.json(r.content as never)}, ${t.json(r.refs)}, ${v}, ${t.json({ model: meta.model, provider: meta.provider, tools: meta.toolsUsed })}, ${actorId})`;
  });
  await emit(sessionId, s.workspace_id, "KnowledgeUpdated", { artifacts: rows.length });
  return { ok: true, artifacts: rows.length };
}

// ---------------------------------------------------------------- Cross-session retrieval & answers
export async function ask(userId: string, workspaceId: string, programmeId: string | null, question: string) {
  const db = sql();
  // Permission filter: sessions the caller may read (owner, admin, or programme shared with workspace)
  const visible = await db`
    select s.id, s.title, s.programme_id from app.sessions s
    join app.programmes p on p.id = s.programme_id
    join app.memberships m on m.workspace_id = s.workspace_id and m.user_id = ${userId} and m.status = 'active'
    where s.workspace_id = ${workspaceId} and s.status not in ('deleted','deletion_pending')
      and (${programmeId}::uuid is null or s.programme_id = ${programmeId}::uuid)
      and (s.owner_id = ${userId} or m.role in ('owner','admin') or p.sharing_policy = 'workspace')`;
  const ids = visible.map((v) => v.id as string);
  const titles = Object.fromEntries(visible.map((v) => [v.id, v.title]));
  if (!ids.length) return { answer: "There are no sessions you can access yet.", citations: [], uncertainty: "high" };
  const q = toks(question).slice(0, 12).join(" | ") || question;
  const seg = await db`select id, session_id, start_ms, speaker_label, text, ts_rank(tsv, to_tsquery('simple', ${q})) r from app.transcript_segments
                       where session_id = any(${ids}) and tsv @@ to_tsquery('simple', ${q}) order by r desc limit 25`;
  const vis = await db`select id, session_id, timestamp_ms, type, title, extracted_text, ts_rank(tsv, to_tsquery('simple', ${q})) r from app.visual_evidence
                       where session_id = any(${ids}) and tsv @@ to_tsquery('simple', ${q}) order by r desc limit 10`;
  const kn = await db`select id, session_id, artifact_type, content, ts_rank(tsv, to_tsquery('simple', ${q})) r from app.knowledge_artifacts
                      where workspace_id = ${workspaceId} and status = 'current' and (session_id = any(${ids}) or (session_id is null and (${programmeId}::uuid is null or programme_id = ${programmeId}::uuid)))
                      and tsv @@ to_tsquery('simple', ${q}) order by r desc limit 15`;
  const docs = await db`select id, title, left(extracted_text, 3000) as text from app.documents where workspace_id = ${workspaceId} and processing_state = 'ready'
                        and (${programmeId}::uuid is null or programme_id = ${programmeId}::uuid) and tsv @@ to_tsquery('simple', ${q}) limit 5`;
  const evidence = [
    ...seg.map((g) => `T${g.id} (session "${titles[g.session_id]}" at ${fmt(g.start_ms)}) ${g.speaker_label}: ${redact(g.text)}`),
    ...vis.map((v) => `V${v.id} (session "${titles[v.session_id]}" at ${fmt(v.timestamp_ms)}, ${v.type}) ${redact(v.title || "")}: ${redact(String(v.extracted_text)).slice(0, 500)}`),
    ...kn.map((k) => `K${k.id} (session "${titles[k.session_id] || "programme"}", ${k.artifact_type}): ${redact(JSON.stringify(k.content)).slice(0, 500)}`),
    ...docs.map((d) => `D${d.id} (document "${d.title}"): ${redact(d.text)}`),
  ];
  if (!evidence.length) return { answer: "I couldn't find anything about that in the sessions and documents you can access.", citations: [], uncertainty: "high" };
  const prompt = `Answer the question using ONLY the evidence. Cite evidence ids inline like [T12]. If the evidence is insufficient or conflicting, say so.
QUESTION: ${redact(question)}
<evidence>
${evidence.join("\n")}
</evidence>
Return ONLY JSON: {"answer":"…with [ids]…","citations":["T12"],"uncertainty":"low|medium|high"}`;
  const { data } = await chatJSON<{ answer: string; citations: string[]; uncertainty: string }>({ workspaceId, actorId: userId, prompt, useTools: true, purpose: "ask" });
  const lookup: Record<string, unknown> = {};
  seg.forEach((g) => (lookup["T" + g.id] = { ref: "T" + g.id, session_id: g.session_id, session_title: titles[g.session_id], timestamp: fmt(g.start_ms), snippet: String(g.text).slice(0, 200) }));
  vis.forEach((v) => (lookup["V" + v.id] = { ref: "V" + v.id, session_id: v.session_id, session_title: titles[v.session_id], timestamp: fmt(v.timestamp_ms), snippet: String(v.title || v.extracted_text).slice(0, 200), kind: v.type }));
  kn.forEach((k) => (lookup["K" + k.id] = { ref: "K" + k.id, session_id: k.session_id, session_title: titles[k.session_id] || "Programme", kind: k.artifact_type, snippet: JSON.stringify(k.content).slice(0, 200) }));
  docs.forEach((d) => (lookup["D" + d.id] = { ref: "D" + d.id, document: d.title, snippet: String(d.text).slice(0, 200) }));
  const cites = (Array.isArray(data.citations) ? data.citations : []).map(String).filter((c) => lookup[c]).map((c) => lookup[c]);
  return { answer: String(data.answer || "").slice(0, 6000), citations: cites, uncertainty: ["low", "medium", "high"].includes(data.uncertainty) ? data.uncertainty : "medium" };
}

export function maskConfig() { return { provider: config.modelProvider, model: config.modelName }; }
