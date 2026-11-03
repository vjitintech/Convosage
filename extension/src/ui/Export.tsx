import { useState } from "react";
import { api } from "../lib/api";
import { markdownToPdf } from "../lib/pdf";
import type { SessionRow } from "../lib/types";
import { copy, download, ErrorNote, useToast } from "./common";

export function ExportPanel({ s }: { s: SessionRow }) {
  const [redact, setRedact] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const toast = useToast();
  const base = s.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "session";
  const get = async (format: string) => api<string>(`/v1/sessions/${s.id}/export?format=${format}&redact=${redact ? 1 : 0}`, { asText: true });
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="card stack">
    <h3>Export</h3>
    <div className="small">Includes summary, decisions, actions, glossary, questions with evidence and answers (confirmed vs AI draft), and the transcript. Exports are logged in the audit trail.</div>
    <label className="chk"><input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />Redact emails, phone numbers, IDs and keys (recommended — never perfect, review before sharing)</label>
    <div className="row">
      <button className="btn" disabled={busy} onClick={() => run(async () => download(base + ".md", await get("md"), "text/markdown"))}>Markdown</button>
      <button className="btn" disabled={busy} onClick={() => run(async () => download(base + ".pdf", await markdownToPdf(await get("md")), "application/pdf"))}>PDF</button>
      <button className="btn" disabled={busy} onClick={() => run(async () => download(base + "-questions.csv", await get("csv"), "text/csv"))}>CSV (questions)</button>
      <button className="btn" disabled={busy} onClick={() => run(async () => download(base + ".json", await get("json"), "application/json"))}>JSON</button>
      <button className="btn ghost" disabled={busy} onClick={() => run(async () => copy(await get("md"), toast))}>Copy</button>
    </div>
    <ErrorNote error={error} />
  </div>;
}
