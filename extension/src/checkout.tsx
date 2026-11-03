// Dummy-payment checkout for test accounts (no money moves). Real customers are sent to Razorpay's hosted checkout.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import "./ui/styles.css";
import { api } from "./lib/api";

function Checkout() {
  const p = new URLSearchParams(location.search); const s = p.get("s") || "", t = p.get("t") || "";
  const [card, setCard] = useState("4111 1111 1111 1111"); const [busy, setBusy] = useState(false); const [done, setDone] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  return <div className="main" style={{ maxWidth: 440, margin: "40px auto" }}>
    <div className="card stack">
      <div className="brand"><img src="icons/32.png" alt="" />CONVOSAGE AI — Checkout</div>
      <div className="notice warn"><b>TEST MODE — dummy payment.</b> No real card is charged and no money moves.</div>
      <div className="kv"><span className="small">Plan</span><span>CONVOSAGE Pro</span><span className="small">Price</span><span>US$10.00 / month</span></div>
      {!done ? <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { const r = await api("/v1/billing/mock-pay", { body: { s, t, card } }); setDone(r.current_period_end); } catch (er) { setError((er as Error).message); } finally { setBusy(false); } }}>
        <div><label className="f" htmlFor="cn">Test card number</label><input id="cn" type="text" inputMode="numeric" value={card} onChange={(e) => setCard(e.target.value)} /></div>
        <div className="row"><div className="sp"><label className="f" htmlFor="ex">Expiry</label><input id="ex" type="text" defaultValue="12/30" /></div><div className="sp"><label className="f" htmlFor="cv">CVV</label><input id="cv" type="text" defaultValue="123" /></div></div>
        <div className="small">Succeeds: 4111 1111 1111 1111 · Declines: 4000 0000 0000 0002</div>
        <button className="btn pri" disabled={busy}>{busy ? "Processing…" : "Pay US$10.00 (test)"}</button>
        {error && <div className="notice bad" role="alert">{error}</div>}
      </form> : <div className="notice ok" role="status">✓ Payment successful (test). Subscription active until {new Date(done).toLocaleDateString()}. You can close this tab — CONVOSAGE updates automatically.</div>}
    </div></div>;
}
createRoot(document.getElementById("root")!).render(<Checkout />);
