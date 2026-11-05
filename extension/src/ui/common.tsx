import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const ToastCtx = createContext<(m: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 2800); return () => clearTimeout(t); }, [msg]);
  return <ToastCtx.Provider value={setMsg}>{children}{msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = { active: ["●", "Active"], disabled: ["⏸", "Disabled"], archived: ["▣", "Archived"], deletion_pending: ["⌫", "Deletion pending"], draft: ["○", "Draft"] };
  const [icon, label] = map[status] || ["?", status];
  return <span className={"status " + status}><span aria-hidden="true">{icon}</span>{label}</span>;
}

// Every pop-up has a visible "← Back" button; clicking outside it or pressing Esc also closes it.
export function Modal({ title, children, onClose, info }: { title: string; children: ReactNode; onClose: () => void; info?: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="card stack"><div className="row"><BackButton onClick={onClose} /></div><h2 className="row" style={{ gap: 6 }}>{title}{info}</h2>{children}</div></div>;
}

export function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return <button type="button" className="btn back" onClick={onClick}>← {label}</button>;
}

// Small ⓘ: hover shows a short hint; click opens an explanation that closes on the next click anywhere (or after 15 s).
export function InfoTip({ hint, children, label = "What is this?" }: { hint: string; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false); const t = setTimeout(close, 15000);
    const id = setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
    return () => { clearTimeout(t); clearTimeout(id); document.removeEventListener("click", close); };
  }, [open]);
  return <span className="info-wrap"><button type="button" className="info" aria-label={label} aria-expanded={open} title={hint} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>i</button>
    {open && <span className="info-pop" role="tooltip">{children}<span className="small" style={{ display: "block", marginTop: 6 }}>Click anywhere to close.</span></span>}</span>;
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose}>
    <div>{body}</div>
    <div className="row"><button className={"btn " + (danger ? "danger" : "pri")} disabled={busy} autoFocus onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); onClose(); } }}>{confirmLabel}</button>
      <button className="btn" onClick={onClose}>Cancel</button></div>
  </Modal>;
}

export function ErrorNote({ error }: { error: string | null }) { return error ? <div className="notice bad" role="alert">{error}</div> : null; }
export function Loading({ label = "Loading…" }: { label?: string }) { return <div className="small" role="status">{label}</div>; }

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => { let on = true; setLoading(true); fn().then((d) => { if (on) { setData(d); setError(null); } }).catch((e) => on && setError(e.message)).finally(() => on && setLoading(false)); return () => { on = false; }; }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}

export async function copy(text: string, toast: (m: string) => void) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Couldn't copy — select and copy manually"); }
}
export function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
