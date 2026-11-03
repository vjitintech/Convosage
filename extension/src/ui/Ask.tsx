import { useState } from "react";
import { api } from "../lib/api";
import type { Programme, Workspace } from "../lib/types";
import { copy, ErrorNote, useToast } from "./common";

export function Ask({ ws, programme, entitled }: { ws: Workspace; programme: Programme; entitled: boolean }) {
  const [q, setQ] = useState(""); const [scope, setScope] = useState<"programme" | "workspace">("programme");
  const [busy, setBusy] = useState(false); const [res, setRes] = useState<any>(null); const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return <div className="card stack">
    <h3>Ask across sessions</h3>
    <div className="small">Answers use only sessions and documents you're allowed to see, with citations to the session and timestamp.</div>
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); setRes(null); try { setRes(await api("/v1/ask", { body: { workspace_id: ws.id, programme_id: scope === "programme" ? programme.id : undefined, question: q } })); } catch (er) { setError((er as Error).message); } finally { setBusy(false); } }}>
      <textarea aria-label="Your question" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. What did we decide about restarting the nightly batch?" rows={3} />
      <div className="row"><select aria-label="Scope" style={{ width: "auto" }} value={scope} onChange={(e) => setScope(e.target.value as never)}><option value="programme">This programme</option><option value="workspace">Whole workspace</option></select>
        <button className="btn pri" disabled={busy || q.trim().length < 3 || !entitled}>{busy ? "Searching…" : "Ask"}</button>{!entitled && <span className="small">Needs a subscription</span>}</div>
    </form>
    <ErrorNote error={error} />
    {res && <div className="stack">
      <div className={"notice " + (res.uncertainty === "high" ? "warn" : "")}><div style={{ whiteSpace: "pre-wrap" }}>{res.answer}</div><div className="small" style={{ marginTop: 4 }}>Uncertainty: {res.uncertainty}</div></div>
      {res.citations?.length > 0 && <div className="stack"><h3>Sources</h3>{res.citations.map((c: any) => <div key={c.ref} className="small"><span className="mono">{c.ref}</span> · {c.document ? `Document “${c.document}”` : `${c.session_title}${c.timestamp ? " @ " + c.timestamp : ""}`} — “{c.snippet}”</div>)}</div>}
      <button className="btn sm" onClick={() => copy(res.answer, toast)}>Copy answer</button>
    </div>}
  </div>;
}
