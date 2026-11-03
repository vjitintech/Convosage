import { useState } from "react";
import { CONFIG } from "../config";
import { normalizePhone, sendOtp, verifyOtp } from "../lib/auth";
import { ErrorNote } from "./common";

const COUNTRIES = [["+91", "India"], ["+1", "USA / Canada"], ["+44", "United Kingdom"], ["+971", "UAE"], ["+65", "Singapore"], ["+61", "Australia"], ["+49", "Germany"], ["+33", "France"], ["+81", "Japan"], ["+27", "South Africa"]];

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [country, setCountry] = useState("+91"); const [custom, setCustom] = useState("");
  const [phone, setPhone] = useState(""); const [code, setCode] = useState(""); const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const cc = country === "other" ? custom : country;
  const send = async () => { setError(null); setBusy(true); try { const p = normalizePhone(cc, phone); await sendOtp(p); setSentTo(p); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const verify = async () => { setError(null); setBusy(true); try { await verifyOtp(sentTo!, code.trim()); onSignedIn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="main">
    <div className="card stack">
      <h2>Sign in</h2>
      <div className="small">We'll text a one-time code to your mobile number. Works in most countries.</div>
      {!sentTo ? <form className="stack" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <div style={{ width: 130 }}><label className="f" htmlFor="cc">Country</label>
            <select id="cc" value={country} onChange={(e) => setCountry(e.target.value)}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{c} {n}</option>)}<option value="other">Other…</option></select></div>
          {country === "other" && <div style={{ width: 80 }}><label className="f" htmlFor="ccx">Code</label><input id="ccx" type="text" inputMode="tel" placeholder="+234" value={custom} onChange={(e) => setCustom(e.target.value)} /></div>}
          <div style={{ flex: 1 }}><label className="f" htmlFor="ph">Mobile number</label><input id="ph" type="tel" autoComplete="tel-national" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" /></div>
        </div>
        <button className="btn pri" disabled={busy || !phone}>{busy ? "Sending…" : "Send code"}</button>
      </form> : <form className="stack" onSubmit={(e) => { e.preventDefault(); verify(); }}>
        <div className="small">Code sent to <b>{sentTo}</b>. <button type="button" className="btn ghost sm" onClick={() => { setSentTo(null); setCode(""); }}>Change number</button></div>
        <div><label className="f" htmlFor="otp">6-digit code</label><input id="otp" className="otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus /></div>
        <div className="row"><button className="btn pri" disabled={busy || code.length < 4}>{busy ? "Verifying…" : "Verify & sign in"}</button><button type="button" className="btn ghost" disabled={busy} onClick={send}>Resend code</button></div>
      </form>}
      <ErrorNote error={error} />
    </div>
    {CONFIG.SHOW_TEST_ACCOUNTS && <div className="card stack">
      <h3>Test accounts (no SMS is sent)</h3>
      {CONFIG.TEST_ACCOUNTS.map((a) => <div key={a.phone} className="row"><div className="sp small"><b>{a.label}</b><br />{a.country} {a.phone} · code <span className="mono">{a.otp}</span></div>
        <button className="btn sm" onClick={() => { const known = COUNTRIES.some(([c]) => c === a.country); setCountry(known ? a.country : "other"); setCustom(a.country); setPhone(a.phone); setSentTo(null); setCode(""); }}>Use</button></div>)}
      <div className="small">These numbers use dummy payments. Remove them before public launch (config.ts and Supabase test numbers).</div>
    </div>}
    <div className="small" style={{ textAlign: "center" }}>By signing in you agree to use CONVOSAGE only with meeting content you're authorised to capture.</div>
  </div>;
}
