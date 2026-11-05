import { useState } from "react";
import { api } from "../lib/api";
import { extractText, parseTranscript, sha256 } from "../lib/extract";
import type { Programme, SessionRow } from "../lib/types";
import { ErrorNote, InfoTip, Loading, useAsync, useToast } from "./common";

// With a session: documents are tagged to it (and still shared with the whole programme). Without: programme-level documents.
export function Docs({ s, programme }: { s?: SessionRow; programme: Programme }) {
  const docs = useAsync(() => api(`/v1/programmes/${programme.id}/documents`), [programme.id]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const toast = useToast();
  const upload = async (file: File, asTranscript: boolean) => {
    setBusy(true); setError(null);
    try {
      const { text, mime } = await extractText(file);
      if (asTranscript) {
        const segs = parseTranscript(text); if (!segs.length) throw new Error("No transcript lines found in that file.");
        const r = await api(`/v1/sessions/${s!.id}/segments`, { body: { segments: segs, source: "upload" } }); toast(`Imported ${r.inserted} transcript lines`);
      } else {
        await api("/v1/uploads", { body: { programme_id: programme.id, session_id: s?.id, title: file.name, mime_type: mime, size_bytes: file.size, sha256: await sha256(file), text } }); toast("Document added"); docs.reload();
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className={s ? "card stack" : "stack"}>
    {s && <h3 className="row" style={{ gap: 6 }}>Documents &amp; transcripts <InfoTip hint="Where documents go for a series or a one-time meeting"><>Documents you add here belong to the programme <b>{programme.title}</b>, so <b>every session</b> in it — earlier and later — uses them for live questions, answers and Ask. For a meeting series keep one programme; for a one-time meeting create a programme just for it. <b>Import transcript</b> adds an existing transcript (.vtt/.srt/.txt) to <i>this</i> session.</></InfoTip></h3>}
    <div className="small">Programme documents are used by every session of “{programme.title}”. Attach only material you're authorised to share — text is extracted on your computer.</div>
    <div className="row">
      <label className="btn">{busy ? "Processing…" : "Add document"}<input type="file" hidden disabled={busy} accept=".pdf,.pptx,.docx,.txt,.md,.csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f, false); }} /></label>
      {s && <label className={"btn" + (s.status !== "active" ? " disabled" : "")} aria-disabled={s.status !== "active"}>Import transcript (.vtt / .srt / .txt)<input type="file" hidden disabled={busy || s.status !== "active"} accept=".vtt,.srt,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f, true); }} /></label>}
    </div>
    <ErrorNote error={error} />{docs.loading && <Loading />}
    {docs.data && !docs.data.documents.length && <div className="empty">No documents in this programme yet.</div>}
    <div className="list">{docs.data?.documents.map((d: any) => <div key={d.id} className="item" style={{ cursor: "default" }}><span className="sp"><b>{d.title}</b><br /><span className="small">{d.processing_state === "ready" ? "✓ Ready" : d.processing_state === "rejected" ? "✕ Rejected — " + d.error : d.processing_state}</span></span>
      <button className="btn ghost sm" aria-label={"Delete " + d.title} onClick={async () => { await api(`/v1/documents/${d.id}`, { method: "DELETE" }); docs.reload(); }}>Delete</button></div>)}</div>
  </div>;
}
