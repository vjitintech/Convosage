// One-time microphone permission for the extension (the offscreen capture page can't show permission prompts).
import { createRoot } from "react-dom/client";
import { useState } from "react";
import "./ui/styles.css";
function Permission() {
  const [state, setState] = useState<"ask" | "ok" | "denied">("ask");
  return <div className="main" style={{ maxWidth: 440, margin: "40px auto" }}><div className="card stack">
    <div className="brand"><img src="icons/32.png" alt="" />CONVOSAGE AI</div>
    <h2>Allow microphone</h2>
    <p>CONVOSAGE uses your microphone only while you're capturing a session and you've ticked “My microphone”. You can revoke this any time in Chrome's site settings.</p>
    {state === "ask" && <button className="btn pri" onClick={async () => { try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); setState("ok"); } catch { setState("denied"); } }}>Allow microphone</button>}
    {state === "ok" && <div className="notice ok" role="status">✓ Microphone allowed. Close this tab and press Start capture again.</div>}
    {state === "denied" && <div className="notice bad" role="alert">Microphone was blocked. Click the camera/microphone icon in the address bar to allow it, then retry.</div>}
  </div></div>;
}
createRoot(document.getElementById("root")!).render(<Permission />);
