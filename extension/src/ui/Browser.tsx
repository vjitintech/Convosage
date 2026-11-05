import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Programme, SessionRow, Workspace } from "../lib/types";
import { ErrorNote, InfoTip, Loading, Modal, StatusBadge, useAsync, useToast } from "./common";
import { ContextEditor } from "./Context";
import { Docs } from "./Docs";

export const CONTEXT_INFO = <>
  <b>Context profile</b> tells CONVOSAGE what this programme (a single meeting or a series) is about: objectives, domains, technology stack, audience,
  key terms, constraints and what is still unknown. The AI reads it before every live question, answer and summary, so its questions fit your domain.
  Type domains and stack as free text separated by semicolons (e.g. <i>US healthcare claims; finance</i> · <i>COBOL; DB2; AWS</i>), or let AI draft it from an agenda.
  <b> You</b> marks your facts, <b>AI</b> marks suggestions to check. Every save is kept as a version.
</>;
export const SHARING_INFO = <>
  <b>Shared with my workspace</b>: everyone in your workspace can open this programme — its sessions, transcripts, questions, knowledge and documents — and Ask across them.<br />
  <b>Private</b> (not ticked): only you can see it. Workspace owners and admins can still see it, because they are responsible for governance (audit, retention, legal hold). Other members cannot.
</>;
const DOCS_INFO = <>Documents added to a programme are used by <b>every session in it</b>. For a series of meetings, keep one programme and add each session to it — earlier
  sessions' questions, answers, gaps and documents carry forward automatically. For a one-time meeting, create a programme just for that meeting.</>;

// Session lists intentionally show no numeric counts or count summaries (blueprint §3.3).
export function Browser({ ws, onOpen }: { ws: Workspace; onOpen: (s: SessionRow, p: Programme) => void }) {
  const progs = useAsync(() => api<{ programmes: Programme[] }>(`/v1/programmes?workspace_id=${ws.id}`), [ws.id]);
  const [progId, setProgId] = useState<string>(""); const [showArchived, setShowArchived] = useState(false);
  const [newProg, setNewProg] = useState(false); const [ctxOpen, setCtxOpen] = useState(false); const [firstSetup, setFirstSetup] = useState(false);
  const list = (progs.data?.programmes || []).filter((p) => showArchived || !p.archived_at);
  const programme = list.find((p) => p.id === progId) || list.find((p) => !p.archived_at);
  const sessions = useAsync(() => programme ? api<{ sessions: SessionRow[] }>(`/v1/sessions?programme_id=${programme.id}`) : Promise.resolve({ sessions: [] }), [programme?.id]);
  const [ctxVersion, setCtxVersion] = useState<number | null>(null);
  useEffect(() => { setCtxVersion(null); if (programme) api(`/v1/programmes/${programme.id}/context`).then((r) => setCtxVersion(r.version)).catch(() => setCtxVersion(0)); }, [programme?.id, ctxOpen]);
  const [platform, setPlatform] = useState("Zoom"); const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const create = async () => {
    if (!programme) return; setError(null);
    // The session is named after the programme (already titled there) plus the date and time; rename it any time inside the session.
    const when = new Date().toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    try { const s = await api<SessionRow>("/v1/sessions", { body: { programme_id: programme.id, title: `${programme.title} — ${when}`, platform } }); toast("Session created"); onOpen(s, programme); }
    catch (e) { setError((e as Error).message); }
  };
  if (progs.loading && !progs.data) return <Loading />;
  const needsContext = ctxVersion === 0;
  return <>
    <div className="card stack">
      <div className="row"><h2 className="sp">Programme</h2><button className="btn sm pri" onClick={() => setNewProg(true)}>+ New programme</button></div>
      {!list.length && <div className="empty">Create a programme for your meeting or meeting series, then enter its context.</div>}
      {list.length > 0 && <select aria-label="Programme" value={programme?.id || ""} onChange={(e) => setProgId(e.target.value)}>
        {list.map((p) => <option key={p.id} value={p.id}>{p.title}{p.archived_at ? " (archived)" : ""}{p.sharing_policy === "workspace" ? " · shared" : " · private"}</option>)}</select>}
      {programme && <div className="row"><span className="small sp">{programme.description || "Meeting or multi-session series"}</span>
        <button className="btn sm" onClick={() => setCtxOpen(true)}>Context profile</button><InfoTip hint="What the AI knows about this programme — click for details">{CONTEXT_INFO}</InfoTip></div>}
      {(progs.data?.programmes || []).some((p) => p.archived_at) && <label className="chk small"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Show earlier (archived) programmes</label>}
    </div>
    {programme && <div className="card stack">
      <h2>New session</h2>
      {needsContext ? <div className="notice warn">Enter this programme's <b>context profile</b> first — it tells the AI what the meeting is about. <button className="btn sm pri" onClick={() => { setFirstSetup(true); setCtxOpen(true); }}>Enter context</button></div> : <>
        <div className="small">The session is named “{programme.title} — date, time”. You can rename it inside the session.</div>
        <div className="row"><div className="sp"><label className="f" htmlFor="pf">Meeting platform</label><select id="pf" value={platform} onChange={(e) => setPlatform(e.target.value)}>{["Zoom", "Google Meet", "Microsoft Teams", "Webex", "Recorded video", "Other web meeting", "In person"].map((x) => <option key={x}>{x}</option>)}</select></div>
          <button className="btn pri" style={{ alignSelf: "flex-end" }} disabled={ctxVersion === null} onClick={create}>Create session</button></div></>}
      <ErrorNote error={error} />
    </div>}
    {programme && <div className="card stack">
      <h2>Sessions</h2>
      {sessions.loading && !sessions.data && <Loading />}<ErrorNote error={sessions.error} />
      {sessions.data && !sessions.data.sessions.length && <div className="empty">No sessions yet. Create one above before your meeting starts.</div>}
      <div className="list">{sessions.data?.sessions.map((s) => <button key={s.id} className="item" onClick={() => onOpen(s, programme)}>
        <span className="sp"><b>{s.title}</b><br /><span className="small">{s.platform || "Meeting"} · {new Date(s.created_at).toLocaleDateString()}</span></span><StatusBadge status={s.status} /></button>)}</div>
    </div>}
    {newProg && <NewProgramme ws={ws} current={programme} onClose={() => setNewProg(false)} onCreated={async (p, archiveCurrent) => {
      if (archiveCurrent && programme) await api(`/v1/programmes/${programme.id}`, { method: "PATCH", body: { archived: true } }).catch(() => {});
      await progs.reload(); setProgId(p.id); setNewProg(false); setFirstSetup(true); setCtxOpen(true); }} />}
    {ctxOpen && programme && <Modal title={"Context profile — " + programme.title} info={<InfoTip hint="What the AI knows about this programme — click for details">{CONTEXT_INFO}</InfoTip>} onClose={() => { setCtxOpen(false); setFirstSetup(false); }}>
      {firstSetup && <div className="notice">Step 2 of 2 — enter the context for <b>{programme.title}</b>, then press <b>Save new version</b>. Add documents for this programme below.</div>}
      <ContextEditor programme={programme} onSaved={(v) => setCtxVersion(v)} />
      <div className="stack"><h3 className="row" style={{ gap: 6 }}>Programme documents <InfoTip hint="Where documents go for a series or a one-time meeting">{DOCS_INFO}</InfoTip></h3>
        <Docs programme={programme} /></div>
    </Modal>}
  </>;
}

function NewProgramme({ ws, current, onClose, onCreated }: { ws: Workspace; current?: Programme; onClose: () => void; onCreated: (p: Programme, archiveCurrent: boolean) => void }) {
  const [title, setTitle] = useState(""); const [desc, setDesc] = useState(""); const [shared, setShared] = useState(false); const [error, setError] = useState<string | null>(null);
  const [archive, setArchive] = useState(true); const [busy, setBusy] = useState(false);
  return <Modal title="New programme — step 1 of 2" onClose={onClose}>
    <div className="small">A programme is one meeting or a series of related meetings (for example a 5-day KT). Its sessions share the context, documents and history.</div>
    <div><label className="f" htmlFor="pt">Title</label><input id="pt" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Claims platform knowledge transfer (5 days)" autoFocus /></div>
    <div><label className="f" htmlFor="pd">Description (optional)</label><textarea id="pd" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
    <label className="chk"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /><span>Share with my workspace <InfoTip hint="Who can see this programme">{SHARING_INFO}</InfoTip></span></label>
    <div className="explain">{shared ? "Everyone in your workspace will see this programme and its sessions, questions, knowledge and documents." : "Private: only you — plus workspace owners/admins, who oversee governance — can see this programme."}</div>
    {current && <label className="chk"><input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} /><span>Archive “{current.title}” so only the new programme is listed (nothing is deleted; tick “Show earlier programmes” to reopen it)</span></label>}
    <ErrorNote error={error} />
    <div className="row"><button className="btn pri" disabled={!title.trim() || busy} onClick={async () => { setBusy(true); try { onCreated(await api<Programme>("/v1/programmes", { body: { workspace_id: ws.id, title, description: desc, sharing_policy: shared ? "workspace" : "private" } }), archive); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Next: context profile →</button><button className="btn" onClick={onClose}>Cancel</button></div>
  </Modal>;
}
