import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { currentSession, signOut } from "../lib/auth";
import { endpoints, isConfigured } from "../lib/storage";
import type { Me, Programme, SessionRow } from "../lib/types";
import { ErrorNote, Loading } from "./common";
import { Login } from "./Login";
import { Paywall } from "./Billing";
import { Browser } from "./Browser";
import { SessionView } from "./Session";
import { Settings } from "./Settings";

type View = { name: "home" } | { name: "session"; session: SessionRow; programme: Programme } | { name: "settings" };

export function App() {
  const [phase, setPhase] = useState<"loading" | "unconfigured" | "signin" | "ready">("loading");
  const [me, setMe] = useState<Me | null>(null); const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: "home" }); const [wsId, setWsId] = useState<string>("");
  const loadMe = useCallback(async () => {
    try { const m = await api<Me>("/v1/me"); setMe(m); setWsId((w) => (m.workspaces.some((x) => x.id === w) ? w : m.workspaces[0]?.id || "")); setPhase("ready"); setError(null); }
    catch (e) { const st = (e as { status?: number }).status; if (st === 401) { setPhase("signin"); } else setError((e as Error).message); }
  }, []);
  useEffect(() => { (async () => {
    if (!isConfigured(await endpoints())) return setPhase("unconfigured");
    if (!(await currentSession())) return setPhase("signin");
    await loadMe();
  })(); const h = () => { setMe(null); setWsId(""); setPhase("signin"); }; window.addEventListener("convosage:signed-out", h); return () => window.removeEventListener("convosage:signed-out", h); }, []);

  const ws = me?.workspaces.find((w) => w.id === wsId);
  return <div className="app">
    <header className="top">
      <div className="brand"><img src="icons/32.png" alt="" />CONVOSAGE AI</div><span className="sp" />
      {phase === "ready" && me && <>
        {me.entitlement.active ? <span className="status active" title={"Plan: " + me.plan}>Pro</span> : <span className="status disabled">Free</span>}
        <button className="btn ghost sm" aria-label="Settings" onClick={() => setView({ name: "settings" })}>⚙ Settings</button>
      </>}
    </header>
    {phase === "loading" && <div className="main"><Loading /></div>}
    {phase === "unconfigured" && <div className="main"><div className="notice warn">This build isn't connected to a CONVOSAGE backend yet. Set SUPABASE_URL and the publishable key in <span className="mono">src/config.ts</span> and rebuild, or set developer endpoints below.</div><Settings me={null} ws={undefined} onBack={() => location.reload()} onSignedOut={() => location.reload()} devOnly /></div>}
    {phase === "signin" && <Login onSignedIn={() => { setPhase("loading"); loadMe(); }} />}
    {phase === "ready" && me && <div className="main">
      <ErrorNote error={error} />
      {view.name === "home" && <>
        {me.workspaces.length > 1 && <div><label className="f" htmlFor="ws">Workspace</label><select id="ws" value={wsId} onChange={(e) => setWsId(e.target.value)}>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}</select></div>}
        {!me.entitlement.active && <Paywall me={me} onActive={loadMe} />}
        {ws && <Browser ws={ws} onOpen={(session, programme) => setView({ name: "session", session, programme })} />}
      </>}
      {view.name === "session" && ws && <SessionView me={me} ws={ws} initial={view.session} programme={view.programme} onBack={() => setView({ name: "home" })} onEntitlementChange={loadMe} />}
      {view.name === "settings" && <Settings me={me} ws={ws} onBack={() => { setView({ name: "home" }); loadMe(); }} onSignedOut={async () => { await signOut(); setMe(null); setWsId(""); setPhase("signin"); setView({ name: "home" }); }} />}
    </div>}
  </div>;
}
