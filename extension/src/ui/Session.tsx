import { useEffect, useRef, useState } from "react";
import { api, fmtTime } from "../lib/api";
import type { CaptureStatus, Me, Programme, Question, Segment, SessionRow, Workspace } from "../lib/types";
import { Confirm, copy, ErrorNote, Loading, Modal, StatusBadge, useToast } from "./common";
import { Paywall } from "./Billing";
import { Knowledge } from "./Knowledge";
import { Ask } from "./Ask";
import { Docs } from "./Docs";
import { ExportPanel } from "./Export";

type Tab = "live" | "knowledge" | "ask" | "docs" | "export";

export function SessionView({ me, ws, initial, programme, onBack, onEntitlementChange }: { me: Me; ws: Workspace; initial: SessionRow; programme: Programme; onBack: () => void; onEntitlementChange: () => void }) {
  const [s, setS] = useState<SessionRow>(initial); const [tab, setTab] = useState<Tab>("live");
  const [tick, setTick] = useState(0); // bumps when live events arrive
  const [confirm, setConfirm] = useState<null | "disable" | "enable" | "archive" | "delete">(null);
  const [cap, setCap] = useState<CaptureStatus>({ state: "idle", sources: [], queued: 0, uploaded: 0, failed: 0, degraded: [] });
  const [error, setError] = useState<string | null>(null); const [rename, setRename] = useState(false);
  const toast = useToast();
  const capturingThis = cap.state !== "idle" && cap.sessionId === s.id;

  const reloadSession = async () => { try { setS(await api<SessionRow>(`/v1/sessions/${s.id}`)); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { reloadSession(); }, [initial.id]);

  // capture status from the service worker
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATUS" }).then((st) => st && setCap(st)).catch(() => {});
    const h = (m: { type: string; status: CaptureStatus }) => { if (m?.type === "CAPTURE_STATUS") { setCap(m.status); if (m.status.state === "idle" && m.status.lastError) setError(m.status.lastError); } };
    chrome.runtime.onMessage.addListener(h); return () => chrome.runtime.onMessage.removeListener(h);
  }, []);

  // live events (long-poll) — server is authoritative for session state
  useEffect(() => {
    let alive = true; let cursor = 0; const ctrl = new AbortController();
    (async () => {
      try { const first = await api(`/v1/sessions/${s.id}/events?after=0&wait=0`, { signal: ctrl.signal }); cursor = first.cursor; } catch { /* ignore */ }
      while (alive) {
        try {
          const r = await api(`/v1/sessions/${s.id}/events?after=${cursor}&wait=20`, { signal: ctrl.signal });
          cursor = r.cursor;
          if (r.events.length) {
            setTick((t) => t + 1);
            const types: string[] = r.events.map((e: { type: string }) => e.type);
            if (types.some((t) => t.startsWith("Session"))) reloadSession();
            if (types.includes("SessionDisabled")) { chrome.runtime.sendMessage({ type: "CAPTURE_STOP", reason: "session_disabled" }).catch(() => {}); }
            if (types.includes("QuestionSuggested") && document.hidden) chrome.runtime.sendMessage({ type: "NOTIFY", title: "New question suggested", message: s.title }).catch(() => {});
          }
        } catch (e) { if (!alive) break; await new Promise((res) => setTimeout(res, 3000)); }
      }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [s.id]);

  const setStatus = async (to: "active" | "disabled" | "archived") => {
    setError(null);
    try {
      if (to !== "active" && capturingThis) await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", reason: "session_" + to });
      const r = await api(`/v1/sessions/${s.id}/status`, { method: "PATCH", body: { status: to, reason_code: "user_requested", expected_version: s.version } });
      toast(to === "disabled" ? "Session disabled — capture stopped and new processing blocked" : to === "active" ? "Session enabled. Start a new capture when ready." : "Session archived");
      setS({ ...s, status: r.status, version: r.session_version });
    } catch (e) { setError((e as Error).message); reloadSession(); }
  };

  const canManage = s.can_manage !== false;
  return <>
    <div className="card stack">
      <div className="row"><button className="btn ghost sm" onClick={onBack}>← Sessions</button><span className="sp" /><StatusBadge status={s.status} /></div>
      <div className="row"><h2 className="sp">{s.title}</h2>{canManage && s.status !== "archived" && s.status !== "deletion_pending" && <button className="btn ghost sm" onClick={() => setRename(true)}>Rename</button>}</div>
      <div className="small">{programme.title} · {s.platform || "Meeting"}</div>
      {canManage && <div className="row">
        {s.status === "active" && <button className="btn" onClick={() => setConfirm("disable")}>Disable session</button>}
        {s.status === "disabled" && <button className="btn pri" onClick={() => setConfirm("enable")}>Enable session</button>}
        {(s.status === "active" || s.status === "disabled") && <button className="btn" onClick={() => setConfirm("archive")}>Archive</button>}
        {s.status === "deletion_pending" ? <><button className="btn danger" onClick={async () => { try { await api(`/v1/sessions/${s.id}?mode=now`, { method: "DELETE" }); toast("Session deleted"); onBack(); } catch (e) { setError((e as Error).message); } }}>Delete now</button><button className="btn" onClick={async () => { await api(`/v1/sessions/${s.id}/restore`, { method: "POST" }); reloadSession(); }}>Cancel deletion</button></>
          : <button className="btn danger" onClick={() => setConfirm("delete")}>Delete…</button>}
      </div>}
      {s.status === "disabled" && <div className="notice warn">Disabled: new capture and processing are blocked. Existing content is kept. Enabling won't restart capture — you'll start a new capture yourself.</div>}
      {s.status === "archived" && <div className="notice">Archived: read-only history. No new capture.</div>}
      {s.status === "deletion_pending" && <div className="notice bad">Scheduled for deletion. Content will be purged after the grace period unless you cancel.</div>}
      <ErrorNote error={error} />
    </div>

    <div className="tabs" role="tablist">{([["live", "Live"], ["knowledge", "Knowledge"], ["ask", "Ask"], ["docs", "Documents"], ["export", "Export"]] as [Tab, string][]).map(([k, l]) =>
      <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>

    {tab === "live" && <Live me={me} s={s} tick={tick} cap={cap} capturingThis={capturingThis} onEntitlementChange={onEntitlementChange} setError={setError} />}
    {tab === "knowledge" && <Knowledge s={s} programme={programme} tick={tick} />}
    {tab === "ask" && <Ask ws={ws} programme={programme} entitled={me.entitlement.active} />}
    {tab === "docs" && <Docs s={s} programme={programme} />}
    {tab === "export" && <ExportPanel s={s} />}

    {confirm === "disable" && <Confirm title="Disable this session?" confirmLabel="Disable session" onClose={() => setConfirm(null)} onConfirm={() => setStatus("disabled")}
      body={<>{capturingThis ? <p><b>Capture is running.</b> It will stop now and the stream will close.</p> : null}<p>New capture and new processing will be blocked on the server. Existing transcript, questions and knowledge are kept.</p></>} />}
    {confirm === "enable" && <Confirm title="Enable this session?" confirmLabel="Enable session" onClose={() => setConfirm(null)} onConfirm={() => setStatus("active")} body={<p>The session becomes Active. Capture does <b>not</b> restart automatically — press Start capture when you're ready.</p>} />}
    {confirm === "archive" && <Confirm title="Archive this session?" confirmLabel="Archive" onClose={() => setConfirm(null)} onConfirm={() => setStatus("archived")} body={<p>Archived sessions are read-only history and cannot capture again.</p>} />}
    {confirm === "delete" && <Confirm danger title="Delete this session permanently?" confirmLabel="Delete permanently" onClose={() => setConfirm(null)}
      onConfirm={async () => { try { if (capturingThis) await chrome.runtime.sendMessage({ type: "CAPTURE_STOP", reason: "session_deleted" }); const r = await api(`/v1/sessions/${s.id}`, { method: "DELETE" });
        if (r.status === "deleted") { toast("Session deleted"); onBack(); } else { toast(`Deletion scheduled (erased after ${r.purge_after_days} days)`); reloadSession(); } } catch (e) { setError((e as Error).message); } }}
      body={<p>The transcript, questions, answers, knowledge and documents of this session are erased <b>now</b>. This can't be undone. (Sessions under legal hold can't be deleted.)</p>} />}
    {rename && <RenameModal s={s} onClose={() => setRename(false)} onDone={(t) => { setS({ ...s, title: t }); setRename(false); }} />}
  </>;
}

function RenameModal({ s, onClose, onDone }: { s: SessionRow; onClose: () => void; onDone: (t: string) => void }) {
  const [t, setT] = useState(s.title); const [err, setErr] = useState<string | null>(null);
  return <Modal title="Rename session" onClose={onClose}><input type="text" aria-label="Session title" value={t} onChange={(e) => setT(e.target.value)} autoFocus /><ErrorNote error={err} />
    <div className="row"><button className="btn pri" disabled={!t.trim()} onClick={async () => { try { await api(`/v1/sessions/${s.id}`, { method: "PATCH", body: { title: t.trim() } }); onDone(t.trim()); } catch (e) { setErr((e as Error).message); } }}>Save</button><button className="btn" onClick={onClose}>Cancel</button></div></Modal>;
}

// ---------------------------------------------------------------- Live tab
const CONSENT = "I have permission to capture this meeting under the organiser's and my organisation's rules, participants have been informed, and I will capture only the sources I select.";

function Live({ me, s, tick, cap, capturingThis, onEntitlementChange, setError }: { me: Me; s: SessionRow; tick: number; cap: CaptureStatus; capturingThis: boolean; onEntitlementChange: () => void; setError: (e: string | null) => void }) {
  const [segs, setSegs] = useState<Segment[]>([]); const [qs, setQs] = useState<Question[]>([]);
  const [filter, setFilter] = useState<"open" | "wrapup" | "answered" | "dismissed" | "all">("open");
  const [startOpen, setStartOpen] = useState(false); const [note, setNote] = useState(""); const [genBusy, setGenBusy] = useState(false);
  const lastId = useRef(0); const toast = useToast(); const boxRef = useRef<HTMLDivElement>(null);
  const loadSegs = async (reset = false) => { if (reset) lastId.current = 0; const r = await api(`/v1/sessions/${s.id}/transcript?after_id=${lastId.current}`); if (r.segments.length) { lastId.current = r.segments[r.segments.length - 1].id; setSegs((old) => { const base = reset ? [] : old; const seen = new Set(base.map((x) => x.id)); return [...base, ...r.segments.filter((x: Segment) => !seen.has(x.id))].sort((a, b) => a.start_ms - b.start_ms || a.id - b.id); }); } else if (reset) setSegs([]); };
  const loadQs = async () => { const r = await api(`/v1/sessions/${s.id}/questions`); setQs(r.questions); };
  useEffect(() => { loadSegs(true).catch(() => {}); loadQs().catch(() => {}); }, [s.id]);
  useEffect(() => { if (tick) { loadSegs().catch(() => {}); loadQs().catch(() => {}); } }, [tick]);
  useEffect(() => { const b = boxRef.current; if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 80) b.scrollTop = b.scrollHeight; }, [segs.length]);

  const patchQ = async (q: Question, body: Record<string, unknown>) => { try { const r = await api<Question>(`/v1/questions/${q.id}`, { method: "PATCH", body }); setQs((a) => a.map((x) => (x.id === q.id ? { ...x, ...r } : x))); } catch (e) { setError((e as Error).message); } };
  const inFilter = (q: Question, f: typeof filter) => f === "all" || (f === "open" ? ["suggested", "saved"].includes(q.state) : f === "wrapup" ? q.phase === "final" && q.state !== "dismissed" : q.state === f);
  const counts = (["open", "wrapup", "answered", "dismissed", "all"] as const).map((f) => [f, qs.filter((q) => inFilter(q, f)).length] as const).filter(([f, n]) => n > 0 && !(f === "all" && n === qs.filter((q) => inFilter(q, "open")).length && qs.every((q) => inFilter(q, "open"))));
  useEffect(() => { if (qs.length && !qs.some((q) => inFilter(q, filter))) setFilter(counts[0]?.[0] || "all"); }, [qs, filter]);
  const visibleSegs = segs.filter((g) => g.confidence == null || g.confidence >= 0.35);
  const shown = qs.filter((q) => inFilter(q, filter))
    .sort((a, b) => (b.state === "saved" ? 1 : 0) - (a.state === "saved" ? 1 : 0) || ({ critical: 4, high: 3, medium: 2, low: 1 }[b.priority] - { critical: 4, high: 3, medium: 2, low: 1 }[a.priority]) || +new Date(b.created_at) - +new Date(a.created_at));
  const active = s.status === "active";
  const otherCapture = cap.state !== "idle" && !capturingThis;

  return <>
    {!me.entitlement.active && active && <Paywall me={me} onActive={onEntitlementChange} compact />}
    <div className="card stack">
      <div className="row"><h3 className="sp">Capture</h3>
        {capturingThis && (cap.state === "paused" ? <span className="rec paused" role="status"><i />Paused</span> : <span className="rec" role="status"><i />Capturing {cap.sources.map((x) => ({ tab_audio: "meeting audio", microphone: "mic", display: "screen" } as Record<string, string>)[x] || x).join(" + ")}</span>)}
      </div>
      {!capturingThis && <div className="row">
        <button className="btn pri" disabled={!active || !me.entitlement.active || otherCapture} onClick={() => setStartOpen(true)}>● Start capture</button>
        {!active && <span className="small">Enable the session to capture.</span>}{otherCapture && <span className="small">Another session is capturing. Stop it first.</span>}
      </div>}
      {capturingThis && <div className="row">
        {cap.state === "paused" ? <button className="btn pri" onClick={() => chrome.runtime.sendMessage({ type: "CAPTURE_RESUME" })}>▶ Resume</button> : <button className="btn" onClick={() => chrome.runtime.sendMessage({ type: "CAPTURE_PAUSE" })}>⏸ Pause</button>}
        <button className="btn danger" onClick={() => { chrome.runtime.sendMessage({ type: "CAPTURE_STOP", reason: "user_stopped" }); toast("Capture stopped — reviewing the whole meeting for wrap-up questions…"); }}>■ Stop capture</button>
        <span className="small">{cap.queued ? `${cap.queued} waiting to upload` : "Up to date"}</span>
      </div>}
      {capturingThis && <div className="row small" aria-live="polite">
        {cap.sources.includes("tab_audio") && <span>{cap.levels?.tab_audio == null ? "🎧 Listening…" : cap.levels.tab_audio > 0.04 ? "🎧 Hearing the meeting" : "🔇 No sound from the meeting — is it playing and unmuted?"}</span>}
        {cap.sources.includes("display") && <span>🖥 Reading the screen{cap.frames ? " ✓" : "…"}</span>}
        {cap.sources.includes("microphone") && <span>🎙 Mic{cap.levels?.microphone ? " ✓" : ""}</span>}
      </div>}
      {capturingThis && cap.host === "panel" && <div className="notice">Keep this side panel open while capturing — closing it stops the capture.</div>}
      {capturingThis && cap.degraded.map((d) => <div key={d} className="notice warn">⚠ {d}</div>)}
      {capturingThis && cap.lastError && <div className="notice warn">{cap.lastError}</div>}
      {active && <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={async (e) => { e.preventDefault(); if (!note.trim()) return; try { await api(`/v1/sessions/${s.id}/segments`, { body: { segments: [{ start_ms: capturingThis && cap.startedAt ? Date.now() - cap.startedAt : 0, text: note.trim(), speaker_label: "Note" }] } }); setNote(""); loadSegs(); } catch (er) { setError((er as Error).message); } }}>
        <input type="text" aria-label="Add a note or caption" placeholder="Add a note or paste live captions…" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn">Add</button></form>}
    </div>

    {(qs.length > 0 || (active && me.entitlement.active)) && <div className="card stack" aria-live="polite">
      <div className="row"><h3 className="sp">Questions</h3>
        {active && me.entitlement.active && <button className="btn sm" disabled={genBusy} onClick={async () => { setGenBusy(true); try { const r = await api(`/v1/sessions/${s.id}/questions/generate`, { method: "POST" }); toast(r.added ? "New questions added" : "Nothing new to ask right now"); loadQs(); } catch (e) { setError((e as Error).message); } finally { setGenBusy(false); } }}>{genBusy ? "Thinking…" : "Suggest now"}</button>}
        {active && me.entitlement.active && segs.length > 0 && <button className="btn sm" disabled={genBusy} onClick={async () => { setGenBusy(true); try { const r = await api(`/v1/sessions/${s.id}/questions/generate?final=1`, { method: "POST" }); toast(r.added ? "Wrap-up questions added" : "No further questions for the whole meeting"); setFilter("wrapup"); loadQs(); } catch (e) { setError((e as Error).message); } finally { setGenBusy(false); } }}>Wrap-up questions</button>}
        <button className="btn sm" onClick={() => copy(shown.map((q, i) => `${i + 1}. ${q.text}`).join("\n"), toast)} disabled={!shown.length}>Copy all</button></div>
      {counts.length > 0 && <div className="row" role="radiogroup" aria-label="Filter questions">{counts.map(([f, n]) => <button key={f} role="radio" aria-checked={filter === f} className={"btn sm " + (filter === f ? "dark" : "")} onClick={() => setFilter(f)}>{{ open: "To ask", wrapup: "Wrap-up", answered: "Answered", dismissed: "Dismissed", all: "All" }[f]} · {n}</button>)}</div>}
      {shown.map((q) => <QuestionCard key={q.id} q={q} patch={(b) => patchQ(q, b)} />)}
    </div>}

    {visibleSegs.length > 0 && <details className="card stack">
      <summary><b>Transcript</b> <span className="small">({visibleSegs.length} lines, in English)</span></summary>
      <div className="scroll" ref={boxRef}>{visibleSegs.map((g) => <div key={g.id} className="seg"><div className="t">{fmtTime(g.start_ms)}<br />T{g.id}</div><div><b>{g.speaker_label}:</b> {g.text}{g.original_text && <span className="small" title={g.original_text}> (translated{g.language && g.language !== "auto" ? ` from ${g.language}` : ""})</span>}</div></div>)}</div>
    </details>}
    {startOpen && <StartCapture s={s} onClose={() => setStartOpen(false)} onError={setError} />}
  </>;
}

function QuestionCard({ q, patch }: { q: Question; patch: (b: Record<string, unknown>) => Promise<void> }) {
  const [ans, setAns] = useState(false); const [answer, setAnswer] = useState(q.answer_text || ""); const toast = useToast();
  return <article className={"q " + q.priority} aria-label={`${q.priority} priority question`}>
    <div className="row" style={{ gap: 5, marginBottom: 4 }}><span className={"tag " + q.priority}>{q.priority}</span><span className="tag">{q.category.replace("_", " ")}</span>
      {q.phase === "final" && <span className="tag" style={{ background: "#e2ebf4", color: "#2a557f" }}>wrap-up</span>}{q.state !== "suggested" && <span className="tag">{q.state}</span>}<span className="sp" /><span className="small" title="Model confidence">confidence {Math.round(q.confidence * 100)}%</span></div>
    <div className="qt">{q.text}</div>
    {q.rationale && <div className="small" style={{ marginTop: 4 }}><b>Why it matters:</b> {q.rationale}</div>}
    {q.evidence_refs.length ? <div className="ev">{q.evidence_refs.map((e) => <div key={e.ref}><span className="mono">{e.ref} · {fmtTime(e.start_ms ?? e.timestamp_ms ?? 0)}</span> “{e.snippet}”</div>)}</div> : <div className="ev small">General check — not tied to a specific moment (lower confidence).</div>}
    {q.tool_refs?.length > 0 && <div className="small" style={{ marginTop: 4 }}>🔧 Informed by {q.tool_refs.join(", ")}</div>}
    {q.answer_text && !ans && <div className="ans"><span className="small">{q.answer_confirmed ? "✓ Confirmed answer" : "AI draft — unverified"}</span><br />{q.answer_text}
      {!q.answer_confirmed && <div className="row" style={{ marginTop: 4 }}><button className="btn sm pri" onClick={() => patch({ answer_confirmed: true })}>Confirm</button><button className="btn sm" onClick={() => setAns(true)}>Correct</button></div>}</div>}
    {ans && <div className="stack" style={{ marginTop: 6 }}><textarea aria-label="Answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="What was the answer?" />
      <div className="row"><button className="btn sm pri" onClick={async () => { await patch({ state: "answered", answer_text: answer, answer_confirmed: true }); setAns(false); }}>Save answer</button><button className="btn sm" onClick={() => setAns(false)}>Cancel</button></div></div>}
    <div className="row" style={{ marginTop: 6 }}>
      {q.state !== "answered" && <button className="btn sm pri" onClick={() => setAns(true)}>Mark answered</button>}
      {q.state === "suggested" && <button className="btn sm" onClick={() => patch({ state: "saved" })}>Save</button>}
      {q.state !== "dismissed" ? <button className="btn sm" onClick={() => patch({ state: "dismissed" })}>Dismiss</button> : <button className="btn sm" onClick={() => patch({ state: "suggested" })}>Restore</button>}
      <span className="sp" />
      <button className="btn ghost sm" aria-label="Copy question" onClick={() => copy(q.text, toast)}>Copy</button>
      <button className="btn ghost sm" aria-pressed={q.feedback === "up"} aria-label="Helpful" onClick={() => patch({ feedback: q.feedback === "up" ? null : "up" })}>{q.feedback === "up" ? "👍✓" : "👍"}</button>
      <button className="btn ghost sm" aria-pressed={q.feedback === "down"} aria-label="Not helpful" onClick={() => patch({ feedback: q.feedback === "down" ? null : "down" })}>{q.feedback === "down" ? "👎✓" : "👎"}</button>
    </div>
  </article>;
}

// Chrome's share window must be opened from a visible extension page (the side panel). Called from the
// background service worker it has no window to attach to and returns "cancelled" immediately.
function chooseShare(prefer: "tab" | "screen", audio: boolean): Promise<{ streamId: string | null; canAudio: boolean }> {
  const base = prefer === "screen" ? ["screen", "window", "tab"] : ["tab", "screen", "window"];
  return new Promise((res) => chrome.desktopCapture.chooseDesktopMedia((audio ? [...base, "audio"] : base) as any,
    (streamId, options) => res({ streamId: streamId || null, canAudio: !!options?.canRequestAudioTrack })));
}

function StartCapture({ s, onClose, onError }: { s: SessionRow; onClose: () => void; onError: (e: string | null) => void }) {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]); const [tabId, setTabId] = useState<number | null>(null);
  const [mode, setMode] = useState<"tab" | "screen">("tab");
  const [hear, setHear] = useState(true); const [see, setSee] = useState(true); const [mic, setMic] = useState(false); const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { (async () => {
    const all = (await chrome.tabs.query({})).filter((t) => t.id && /^https?:/.test(t.url || ""));
    const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const pick = all.find((t) => t.id === act?.id && /^https?:/.test(act?.url || "")) || all.find((t) => t.audible) || all[0];
    setTabs(all); setTabId(pick?.id ?? null);
  })().catch(() => {}); }, []);
  const tab = tabs.find((t) => t.id === tabId);
  const start = async () => {
    setBusy(true); setMsg(null); onError(null);
    try {
      if (mode === "tab" && !tab) throw new Error("Open the meeting or video in a browser tab first, then choose it here.");
      if (mic) {
        const p = await navigator.permissions.query({ name: "microphone" as PermissionName }).catch(() => null);
        if (!p || p.state !== "granted") { await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }); setMsg("Allow the microphone in the tab that just opened, then press Start again."); setBusy(false); return; }
      }
      let tabStreamId: string | null = null, desktopStreamId: string | null = null, desktopAudio = false, desktopVideo = false;
      if (mode === "tab" && (hear || see)) {
        // Direct tab capture works without any prompt when Chrome allows it; otherwise Chrome's share window is used.
        try { tabStreamId = await new Promise<string>((res, rej) => chrome.tabCapture.getMediaStreamId({ targetTabId: tab!.id! }, (id) => (chrome.runtime.lastError || !id ? rej(chrome.runtime.lastError) : res(id)))); } catch { tabStreamId = null; }
        if (!tabStreamId) {
          setMsg(`In Chrome's share window choose the tab “${(tab!.title || "meeting").slice(0, 60)}”${hear ? " and keep “Share tab audio” ON" : ""}, then press Share.`);
          await chrome.tabs.update(tab!.id!, { active: true }).catch(() => {});
          const r = await chooseShare("tab", hear);
          if (!r?.streamId) throw new Error("Sharing was cancelled — nothing is being captured.");
          if (hear && !r.canAudio) throw new Error("“Share tab audio” was off, so the meeting can't be heard. Start again and keep it ON.");
          desktopStreamId = r.streamId; desktopAudio = hear; desktopVideo = see;
        }
      }
      if (mode === "screen") {
        setMsg("In Chrome's share window choose Entire screen (or the app window) and turn ON “Share system audio”.");
        const r = await chooseShare("screen", hear);
        if (!r?.streamId) throw new Error("Sharing was cancelled — nothing is being captured.");
        if (hear && !r.canAudio) throw new Error("“Share system audio” was off, so the meeting can't be heard. Start again and turn it ON (Windows/ChromeOS).");
        desktopStreamId = r.streamId; desktopAudio = hear; desktopVideo = see;
      }
      const sources = [hear && "tab_audio", mic && "microphone", see && "display"].filter(Boolean) as string[];
      if (!sources.length) throw new Error("Choose at least one thing to capture.");
      const cap = await api(`/v1/sessions/${s.id}/capture/start`, { body: { source_types: sources, consent: { accepted: true, statement: CONSENT }, browser_info: { ua: navigator.userAgent, platform: (navigator as any).userAgentData?.platform || navigator.platform }, permission_state: { tab_audio: hear, microphone: mic, display: see } } });
      const baseMs = s.started_at ? Math.max(0, Date.now() - new Date(s.started_at).getTime()) : 0;
      const params = { sessionId: s.id, captureId: cap.capture_id, captureToken: cap.capture_token, expiresAt: cap.expires_at, baseMs, tabStreamId, tabAudio: hear, tabVideo: see, desktopStreamId, desktopAudio, desktopVideo, mic };
      let r: { ok?: boolean; degraded?: string[] } | undefined;
      if (desktopStreamId) {
        // A share-window stream can only be opened by this page, so the capture runs here in the side panel.
        const { installEngine, engine } = await import("../capture-engine"); installEngine("panel");
        r = await engine.start(params);
      } else r = await chrome.runtime.sendMessage({ type: "CAPTURE_START", params });
      if (!r?.ok) { await api(`/v1/sessions/${s.id}/capture/stop`, { body: { capture_id: cap.capture_id, reason: "start_failed" } }).catch(() => {}); throw new Error((r?.degraded || []).join(" ") || "Capture couldn't start."); }
      onClose();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title="Start capture" onClose={onClose}>
    <div className="small">CONVOSAGE listens to the meeting and reads what is shown, then suggests questions live. Nothing is recorded or stored as audio/video.</div>
    <div className="row" role="radiogroup" aria-label="What to capture from">
      <button role="radio" aria-checked={mode === "tab"} className={"btn sm " + (mode === "tab" ? "dark" : "")} onClick={() => setMode("tab")}>A browser tab</button>
      <button role="radio" aria-checked={mode === "screen"} className={"btn sm " + (mode === "screen" ? "dark" : "")} onClick={() => setMode("screen")}>Entire screen / app</button>
    </div>
    {mode === "tab" ? <label>Meeting or video tab
      <select aria-label="Meeting tab" value={tabId ?? ""} onChange={(e) => setTabId(Number(e.target.value))}>
        {!tabs.length && <option value="">No web tabs open</option>}
        {tabs.map((t) => <option key={t.id} value={t.id}>{t.audible ? "🔊 " : ""}{(t.title || t.url || "").slice(0, 70)}</option>)}
      </select></label>
      : <div className="small">For the Zoom / Teams desktop apps. Windows & ChromeOS can share system audio; on macOS use the browser version of the meeting instead.</div>}
    <label className="chk"><input type="checkbox" checked={hear} onChange={(e) => setHear(e.target.checked)} /><span><b>What is said</b> — the {mode === "tab" ? "tab's" : "computer's"} audio, transcribed to English</span></label>
    <label className="chk"><input type="checkbox" checked={see} onChange={(e) => setSee(e.target.checked)} /><span><b>What is shown</b> — slides, documents and screen shares, read when the view changes</span></label>
    <label className="chk"><input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} /><span><b>My microphone</b> — only for in-person rooms. Not needed for online meetings or videos.</span></label>
    <label className="chk"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{CONSENT}</span></label>
    {msg && <div className="notice warn" role="alert">{msg}</div>}
    <div className="row"><button className="btn pri" disabled={busy || !agree || (!hear && !mic && !see)} onClick={start}>{busy ? "Starting…" : "Start capture"}</button><button className="btn" onClick={onClose}>Cancel</button></div>
  </Modal>;
}

export { Loading };
