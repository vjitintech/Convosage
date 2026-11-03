import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Programme } from "../lib/types";
import { ErrorNote, Loading, useToast } from "./common";

type Item = { text: string; source: "user" | "ai" };
const FIELDS: [string, string][] = [["objectives", "Objectives"], ["domain", "Domain"], ["technology", "Technology"], ["audience", "Audience"], ["terminology", "Terminology"], ["constraints", "Constraints"], ["success_criteria", "Success criteria"], ["known_facts", "Known facts"], ["unknowns", "Unknowns"], ["entities", "Key entities"]];

// Editable profile; shows user-provided vs AI-inferred facts; every save is a new version.
export function ContextEditor({ programme }: { programme: Programme }) {
  const [content, setContent] = useState<Record<string, Item[]> | null>(null); const [version, setVersion] = useState(0);
  const [material, setMaterial] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [dirty, setDirty] = useState(false);
  const toast = useToast();
  const load = async () => { const r = await api(`/v1/programmes/${programme.id}/context`); setContent(r.content); setVersion(r.version); setDirty(false); };
  useEffect(() => { load().catch((e) => setError(e.message)); }, [programme.id]);
  if (!content) return error ? <ErrorNote error={error} /> : <Loading />;
  const setField = (k: string, items: Item[]) => { setContent({ ...content, [k]: items }); setDirty(true); };
  return <div className="stack">
    <div className="small">Version {version}. <span className="prov user">You</span> = you provided · <span className="prov ai">AI</span> = AI-inferred (review it). Corrections shape future questions and answers.</div>
    {FIELDS.map(([k, label]) => <div key={k}>
      <label className="f">{label}</label>
      {(content[k] || []).map((it, i) => <div key={i} className="row" style={{ marginBottom: 4, flexWrap: "nowrap" }}>
        <input type="text" aria-label={label + " item"} value={it.text} onChange={(e) => { const a = [...content[k]]; a[i] = { text: e.target.value, source: "user" }; setField(k, a); }} />
        <span className={"prov " + it.source}>{it.source === "user" ? "You" : "AI"}</span>
        <button className="btn ghost sm" aria-label={"Remove " + it.text} onClick={() => setField(k, content[k].filter((_, j) => j !== i))}>✕</button></div>)}
      <button className="btn ghost sm" onClick={() => setField(k, [...(content[k] || []), { text: "", source: "user" }])}>+ Add</button>
    </div>)}
    <div className="row"><button className="btn pri" disabled={!dirty || busy} onClick={async () => { setBusy(true); setError(null); try { const r = await api(`/v1/programmes/${programme.id}/context`, { method: "PUT", body: { content, base_version: version } }); setVersion(r.version); setDirty(false); toast("Context saved as version " + r.version); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Save new version</button></div>
    <details><summary className="small">Let AI draft the profile from an agenda, brief or notes</summary>
      <div className="stack" style={{ marginTop: 6 }}>
        <textarea value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="Paste the agenda, programme brief or glossary…" rows={5} />
        <button className="btn" disabled={busy || material.trim().length < 20} onClick={async () => { setBusy(true); setError(null); try { const r = await api(`/v1/programmes/${programme.id}/context/infer`, { body: { material } }); setContent(r.proposed); setDirty(true); toast("AI suggestions added — review, then save"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Drafting…" : "Draft with AI"}</button>
      </div></details>
    <ErrorNote error={error} />
  </div>;
}
