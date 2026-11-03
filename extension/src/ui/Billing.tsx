import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Me } from "../lib/types";
import { ErrorNote, useToast } from "./common";

export function Paywall({ me, onActive, compact }: { me: Me; onActive: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false); const [waiting, setWaiting] = useState(false); const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (!waiting) return; let n = 0;
    const t = setInterval(async () => {
      n++; try { const s = await api("/v1/billing/status"); if (s.active) { clearInterval(t); setWaiting(false); toast("Subscription active — welcome to CONVOSAGE Pro"); onActive(); } } catch { /* keep polling */ }
      if (n > 120) { clearInterval(t); setWaiting(false); }
    }, 3000);
    return () => clearInterval(t);
  }, [waiting]);
  const subscribe = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api("/v1/billing/subscribe", { method: "POST" });
      if (r.already_active) { onActive(); return; }
      const url = /^https:\/\//.test(r.checkout_url) ? r.checkout_url : chrome.runtime.getURL(r.checkout_url);
      await chrome.tabs.create({ url }); setWaiting(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className={compact ? "notice warn stack" : "card stack"}>
    {!compact && <h2>Upgrade to CONVOSAGE Pro</h2>}
    <div>{compact ? <b>Live capture and AI features need a subscription.</b> : <>{me.plan}. Live capture, grounded questions, knowledge continuity and cross-session answers.</>}</div>
    {me.entitlement.provider === "mock" && <div className="small">This is a test account: checkout uses a <b>dummy payment</b> (no real money). Use card 4111 1111 1111 1111.</div>}
    <div className="row"><button className="btn pri" onClick={subscribe} disabled={busy || waiting}>{waiting ? "Waiting for payment…" : busy ? "Opening checkout…" : "Subscribe — US$10 / month"}</button>
      {waiting && <button className="btn ghost sm" onClick={() => setWaiting(false)}>Cancel</button>}</div>
    {waiting && <div className="small" role="status">Complete payment in the new tab. This updates automatically.</div>}
    <ErrorNote error={error} />
  </div>;
}
