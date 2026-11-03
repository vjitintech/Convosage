// Client-side text extraction for user-authorised documents (nothing is executed; text only).
import JSZip from "jszip";

async function pdfText(file: File) {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 300); i++) { const p = await doc.getPage(i); const t = await p.getTextContent(); out.push(`[Page ${i}] ` + t.items.map((x: any) => x.str).join(" ")); }
  return out.join("\n");
}
async function ooxmlText(file: File, kind: "pptx" | "docx") {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  if (kind === "docx") { const x = await zip.file("word/document.xml")?.async("string"); return decode((x || "").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")); }
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const n of slides) { const x = await zip.file(n)!.async("string"); out.push(`[Slide ${n.match(/slide(\d+)/)![1]}] ` + decode([...x.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" "))); }
  return out.join("\n");
}
export const MIME: Record<string, string> = { txt: "text/plain", md: "text/markdown", vtt: "text/vtt", srt: "application/x-subrip", csv: "text/csv", pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
export async function extractText(file: File): Promise<{ text: string; mime: string }> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!MIME[ext]) throw new Error("Supported files: PDF, PPTX, DOCX, TXT, MD, VTT, SRT, CSV.");
  if (file.size > 50_000_000) throw new Error("File must be under 50 MB.");
  const text = ext === "pdf" ? await pdfText(file) : ext === "pptx" || ext === "docx" ? await ooxmlText(file, ext) : await file.text();
  return { text: text.slice(0, 2_000_000), mime: MIME[ext] };
}
export async function sha256(file: File) { const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

/** Parse .vtt/.srt/plain "Speaker: text" transcripts into timestamped segments. */
export function parseTranscript(raw: string) {
  const lines = raw.replace(/\r/g, "").split("\n"); const out: { start_ms: number; end_ms: number; text: string; speaker_label: string }[] = [];
  const toMs = (t: string) => { const p = t.replace(",", ".").split(":").map(Number); const [h, m, s] = p.length === 3 ? p : [0, p[0], p[1]]; return Math.round(((h * 60 + m) * 60 + s) * 1000); };
  let cur: { s: number; e: number } | null = null; let last = 0;
  for (const l0 of lines) {
    const l = l0.trim(); if (!l || /^WEBVTT/.test(l) || /^\d+$/.test(l) || /^NOTE\b/.test(l)) continue;
    const cue = l.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/); if (cue) { cur = { s: toMs(cue[1]), e: toMs(cue[2]) }; continue; }
    let text = l, speaker = "Unknown speaker", s = cur ? cur.s : last + 5000, e = cur ? cur.e : s + 5000;
    const ts = text.match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*[-–]?\s*(.*)$/); if (ts && !cur) { s = toMs(ts[1] + ".0"); e = s + 5000; text = ts[2]; }
    const v = text.match(/^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/i); if (v) { speaker = v[1].trim(); text = v[2]; } else { const sp = text.match(/^([A-Z][\w .'()-]{0,32}?):\s+(.+)$/); if (sp) { speaker = sp[1]; text = sp[2]; } }
    text = text.replace(/<[^>]+>/g, "").trim(); if (!text) continue;
    out.push({ start_ms: s, end_ms: e, text, speaker_label: speaker }); last = s; cur = null;
  }
  return out;
}
