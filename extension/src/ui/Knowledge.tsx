import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Artifact, Programme, SessionRow } from "../lib/types";
import { ErrorNote, Loading, useToast } from "./common";

const SECTIONS: [string, string][] = [["summary", "Summary"], ["topic", "Topics"], ["decision", "Decisions"], ["action", "Actions"], ["glossary", "Glossary"], ["open_question", "Open questions"], ["contradiction", "Contradictions"], ["gap", "Gaps"]];

export function Knowledge({ s, programme, tick }: { s: SessionRow; programme: Programme; tick: number }) {
  const [scope, setScope] = useState<"session" | "programme">("session");
  const [items, setItems] = useState<Artifact[] | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const load = async () => { try { const r = scope === "session" ? await api(`/v1/sessions/${s.id}/knowledge`) : await api(`/v1/programmes/${programme.id}/knowledge`); setItems(r.artifacts); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { setItems(null); load(); }, [scope, s.id]);
  useEffect(() => { if (tick && scope === "session") load(); }, [tick]);
  const gen = async () => { setBusy(true); setError(null); try { const r = await api(`/v1/sessions/${s.id}/knowledge/generate`, { method: "POST" }); toast(r.ok ? "Knowledge updated" : "Nothing to summarise yet"); load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="card stack">
    <div className="row"><div className="row sp" role="radiogroup" aria-label="Scope">{(["session", "programme"] as const).map((k) => <button key={k} role="radio" aria-checked={scope === k} className={"btn sm " + (scope === k ? "dark" : "")} onClick={() => setScope(k)}>{k === "session" ? "This session" : "Programme ledger"}</button>)}</div>
      {scope === "session" && s.status === "active" && <button className="btn sm pri" disabled={busy} onClick={gen}>{busy ? "Generating…" : items?.length ? "Refresh" : "Generate"}</button>}</div>
    <div className="small">Grounded in evidence ids (T = transcript, V = screen). Owners and due dates appear only when someone stated them. Correct anything that's wrong.</div>
    <ErrorNote error={error} />{!items && <Loading />}
    {items && !items.length && <div className="empty">{scope === "session" ? "No knowledge yet. Generate it once there is transcript or screen evidence." : "Nothing in the programme ledger yet."}</div>}
    {items && SECTIONS.map(([type, label]) => { const list = items.filter((a) => a.artifact_type === type); if (!list.length) return null;
      return <section key={type} className="stack"><h3>{label}</h3>{list.map((a) => <ArtifactRow key={a.id} a={a} showSession={scope === "programme"} onChanged={load} editable={scope === "session" && s.status !== "archived"} />)}</section>; })}
  </div>;
}

function ArtifactRow({ a, showSession, onChanged, editable }: { a: Artifact; showSession: boolean; onChanged: () => void; editable: boolean }) {
  const [edit, setEdit] = useState(false); const c = a.content;
  const main = c.text || c.title || (c.term ? `${c.term} — ${c.definition || ""}` : JSON.stringify(c));
  const [val, setVal] = useState<string>(c.text || c.title || c.definition || "");
  return <div className="ans" style={{ background: "#fff", borderStyle: "solid", borderColor: "var(--line)" }}>
    {!edit ? <>{c.term ? <><b>{c.term}</b> — {c.definition}</> : main}
      {a.artifact_type === "action" && <div className="small">Owner: {c.owner || "not stated"} · Due: {c.due || "not stated"}</div>}
      <div className="small">{a.status === "corrected" && "✎ corrected · "}{showSession && a.session_title ? a.session_title + " · " : ""}{a.provenance_refs?.length ? "Evidence " + a.provenance_refs.join(", ") : "No direct evidence"}</div>
      {editable && <div className="row"><button className="btn ghost sm" onClick={() => setEdit(true)}>Correct</button><button className="btn ghost sm" onClick={async () => { await api(`/v1/knowledge/${a.id}`, { method: "PATCH", body: { status: "archived" } }); onChanged(); }}>Archive</button></div>}</>
      : <div className="stack"><textarea aria-label="Corrected text" value={val} onChange={(e) => setVal(e.target.value)} />
        <div className="row"><button className="btn sm pri" onClick={async () => { const key = c.term ? "definition" : c.text !== undefined ? "text" : "title"; await api(`/v1/knowledge/${a.id}`, { method: "PATCH", body: { content: { ...c, [key]: val } } }); setEdit(false); onChanged(); }}>Save correction</button><button className="btn sm" onClick={() => setEdit(false)}>Cancel</button></div></div>}
  </div>;
}
