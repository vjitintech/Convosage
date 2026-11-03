import { useState } from "react";
import { api } from "../lib/api";
import type { Programme, SessionRow, Workspace } from "../lib/types";
import { ErrorNote, Loading, Modal, StatusBadge, useAsync, useToast } from "./common";
import { ContextEditor } from "./Context";

// Session lists intentionally show no numeric counts or count summaries (blueprint §3.3).
export function Browser({ ws, onOpen }: { ws: Workspace; onOpen: (s: SessionRow, p: Programme) => void }) {
  const progs = useAsync(() => api<{ programmes: Programme[] }>(`/v1/programmes?workspace_id=${ws.id}`), [ws.id]);
  const [progId, setProgId] = useState<string>("");
  const [newProg, setNewProg] = useState(false); const [ctxOpen, setCtxOpen] = useState(false);
  const programme = progs.data?.programmes.find((p) => p.id === progId) || progs.data?.programmes.find((p) => !p.archived_at);
  const sessions = useAsync(() => programme ? api<{ sessions: SessionRow[] }>(`/v1/sessions?programme_id=${programme.id}`) : Promise.resolve({ sessions: [] }), [programme?.id]);
  const [title, setTitle] = useState(""); const [platform, setPlatform] = useState("Zoom"); const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const create = async () => {
    if (!programme || !title.trim()) return; setError(null);
    try { const s = await api<SessionRow>("/v1/sessions", { body: { programme_id: programme.id, title: title.trim(), platform } }); setTitle(""); toast("Session created"); onOpen(s, programme); }
    catch (e) { setError((e as Error).message); }
  };
  if (progs.loading && !progs.data) return <Loading />;
  return <>
    <div className="card stack">
      <div className="row"><h2 className="sp">Programme</h2><button className="btn sm" onClick={() => setNewProg(true)}>+ New programme</button></div>
      {progs.data && <select aria-label="Programme" value={programme?.id || ""} onChange={(e) => setProgId(e.target.value)}>
        {progs.data.programmes.map((p) => <option key={p.id} value={p.id}>{p.title}{p.archived_at ? " (archived)" : ""}{p.sharing_policy === "workspace" ? " · shared" : ""}</option>)}</select>}
      {programme && <div className="row"><span className="small sp">{programme.description || "Multi-day knowledge-transfer track"}</span><button className="btn sm" onClick={() => setCtxOpen(true)}>Context profile</button></div>}
    </div>
    {programme && <div className="card stack">
      <h2>New session</h2>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <div><label className="f" htmlFor="st">Meaningful title</label><input id="st" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Claims batch KT — Day 2 (recovery)" /></div>
        <div className="row"><div className="sp"><label className="f" htmlFor="pf">Meeting platform</label><select id="pf" value={platform} onChange={(e) => setPlatform(e.target.value)}>{["Zoom", "Google Meet", "Microsoft Teams", "Webex", "Other web meeting", "In person"].map((x) => <option key={x}>{x}</option>)}</select></div>
          <button className="btn pri" style={{ alignSelf: "flex-end" }} disabled={!title.trim()}>Create</button></div>
      </form><ErrorNote error={error} />
    </div>}
    {programme && <div className="card stack">
      <h2>Sessions</h2>
      {sessions.loading && !sessions.data && <Loading />}<ErrorNote error={sessions.error} />
      {sessions.data && !sessions.data.sessions.length && <div className="empty">No sessions yet. Create one above before your meeting starts.</div>}
      <div className="list">{sessions.data?.sessions.map((s) => <button key={s.id} className="item" onClick={() => onOpen(s, programme)}>
        <span className="sp"><b>{s.title}</b><br /><span className="small">{s.platform || "Meeting"} · {new Date(s.created_at).toLocaleDateString()}</span></span><StatusBadge status={s.status} /></button>)}</div>
    </div>}
    {newProg && <NewProgramme ws={ws} onClose={() => setNewProg(false)} onCreated={(p) => { progs.reload(); setProgId(p.id); setNewProg(false); setCtxOpen(true); }} />}
    {ctxOpen && programme && <Modal title={"Context — " + programme.title} onClose={() => setCtxOpen(false)}><ContextEditor programme={programme} /></Modal>}
  </>;
}

function NewProgramme({ ws, onClose, onCreated }: { ws: Workspace; onClose: () => void; onCreated: (p: Programme) => void }) {
  const [title, setTitle] = useState(""); const [desc, setDesc] = useState(""); const [shared, setShared] = useState(false); const [error, setError] = useState<string | null>(null);
  return <Modal title="New programme" onClose={onClose}>
    <div><label className="f" htmlFor="pt">Title</label><input id="pt" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Claims platform knowledge transfer (5 days)" autoFocus /></div>
    <div><label className="f" htmlFor="pd">Description (optional)</label><textarea id="pd" value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
    <label className="chk"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Share with my workspace (otherwise private to me and admins)</label>
    <ErrorNote error={error} />
    <div className="row"><button className="btn pri" disabled={!title.trim()} onClick={async () => { try { onCreated(await api<Programme>("/v1/programmes", { body: { workspace_id: ws.id, title, description: desc, sharing_policy: shared ? "workspace" : "private" } })); } catch (e) { setError((e as Error).message); } }}>Create</button><button className="btn" onClick={onClose}>Cancel</button></div>
  </Modal>;
}
