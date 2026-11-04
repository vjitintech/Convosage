import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { endpoints, getLocal, setLocal } from "../lib/storage";
import type { Me, Workspace } from "../lib/types";
import { Confirm, ErrorNote, Loading, useAsync, useToast } from "./common";

export function Settings({ me, ws, onBack, onSignedOut, devOnly }: { me: Me | null; ws?: Workspace; onBack: () => void; onSignedOut: () => void; devOnly?: boolean }) {
  return <>
    {!devOnly && <div className="row"><button className="btn ghost sm" onClick={onBack}>← Back</button></div>}
    {me && <Account me={me} onSignedOut={onSignedOut} />}
    {me && <AiCheck />}
    {me && ws && ["owner", "admin"].includes(ws.role) && <WorkspaceSettings ws={ws} />}
    {me && ws && ["owner", "admin"].includes(ws.role) && <McpServers ws={ws} />}
    {me && ws && ["owner", "admin"].includes(ws.role) && <AuditLog ws={ws} />}
    <DevEndpoints />
    <div className="small" style={{ textAlign: "center" }}>CONVOSAGE AI v{chrome.runtime.getManifest().version} · AI output can be wrong — check the evidence.</div>
  </>;
}

function AiCheck() {
  const [busy, setBusy] = useState(false); const [res, setRes] = useState<{ ok: boolean; checks: Record<string, { ok: boolean; detail: string }> } | null>(null); const [err, setErr] = useState<string | null>(null);
  const names: Record<string, string> = { text_model: "Questions & answers (text model)", large_model: "Wrap-up & knowledge (large model)", screen_reading: "Reading the screen (vision)", speech_to_text: "Speech-to-text" };
  return <div className="card stack">
    <div className="row"><h2 className="sp">AI setup</h2><button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); setErr(null); setRes(null); try { setRes(await api("/v1/diagnostics")); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Checking…" : "Check AI setup"}</button></div>
    <ErrorNote error={err} />
    {res && Object.entries(res.checks).map(([k, c]) => <div key={k} className={"notice " + (c.ok ? "" : "bad")}>{c.ok ? "✓" : "✗"} <b>{names[k] || k}</b> — {c.detail}</div>)}
  </div>;
}

function Account({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [cancel, setCancel] = useState(false); const toast = useToast();
  return <div className="card stack">
    <h2>Account</h2>
    <div className="kv"><span className="small">Signed in as</span><span>{me.user.phone ? "+" + me.user.phone.replace(/^\+/, "") : "—"}</span>
      <span className="small">Plan</span><span>{me.entitlement.active ? `Pro — ${me.entitlement.status}` : "No active subscription"}{me.entitlement.provider === "mock" ? " (test account · dummy payments)" : ""}</span>
      {me.entitlement.current_period_end && <><span className="small">Renews / ends</span><span>{new Date(me.entitlement.current_period_end).toLocaleDateString()}</span></>}</div>
    <div className="row">{me.entitlement.active && <button className="btn" onClick={() => setCancel(true)}>Cancel subscription</button>}<button className="btn" onClick={onSignedOut}>Sign out</button></div>
    {cancel && <Confirm title="Cancel subscription?" confirmLabel="Cancel subscription" danger onClose={() => setCancel(false)} onConfirm={async () => { await api("/v1/billing/cancel", { method: "POST" }); toast("Cancellation requested — access continues until the end of the paid period"); }} body={<p>Your subscription will stop renewing. Your sessions and knowledge stay available to view.</p>} />}
  </div>;
}

function WorkspaceSettings({ ws }: { ws: Workspace }) {
  const [name, setName] = useState(ws.name); const [ret, setRet] = useState(ws.retention_days); const [error, setError] = useState<string | null>(null); const toast = useToast();
  return <div className="card stack">
    <h2>Workspace</h2>
    <div><label className="f" htmlFor="wn">Name</label><input id="wn" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
    <div><label className="f" htmlFor="wr">Document retention (days)</label><input id="wr" type="number" min={1} max={3650} value={ret} onChange={(e) => setRet(Number(e.target.value))} /></div>
    <div className="small">Raw audio and frames are never stored; only transcripts, extracted text and knowledge are kept. Deleted sessions are erased immediately (unless under legal hold).</div>
    <button className="btn pri" onClick={async () => { setError(null); try { await api(`/v1/workspaces/${ws.id}`, { method: "PATCH", body: { name, retention_days: ret } }); toast("Workspace saved"); } catch (e) { setError((e as Error).message); } }}>Save</button>
    <ErrorNote error={error} />
  </div>;
}

function McpServers({ ws }: { ws: Workspace }) {
  const list = useAsync(() => api(`/v1/workspaces/${ws.id}/mcp`), [ws.id]);
  const [form, setForm] = useState<{ server_id?: string; name: string; url: string; token: string; tools: string[] }>({ name: "", url: "https://", token: "", tools: [] });
  const [found, setFound] = useState<{ name: string; description: string }[] | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const toast = useToast();
  const save = async (allow: string[]) => { const r = await api(`/v1/workspaces/${ws.id}/mcp`, { body: { server_id: form.server_id, name: form.name, url: form.url, token: form.token || undefined, tool_allowlist: allow } }); return r.id as string; };
  return <div className="card stack">
    <h2>AI agent tools (MCP servers)</h2>
    <div className="small">Connect approved remote MCP servers (knowledge bases, runbooks, ticketing). The agent may call only the tools you allow, during question generation and answers. Tokens are encrypted on the server. Never connect servers that aren't approved to receive meeting context.</div>
    {list.loading && <Loading />}
    {list.data?.servers.map((s: any) => <div key={s.id} className="item" style={{ cursor: "default" }}><span className="sp"><b>{s.name}</b> {s.enabled ? "" : "(off)"}<br /><span className="small">{s.url} · allowed: {s.tool_allowlist.join(", ") || "none"}</span></span>
      <button className="btn ghost sm" onClick={() => { setForm({ server_id: s.id, name: s.name, url: s.url, token: "", tools: s.tool_allowlist }); setFound(null); }}>Edit</button>
      <button className="btn ghost sm" onClick={async () => { await api(`/v1/workspaces/${ws.id}/mcp/${s.id}`, { method: "DELETE" }); list.reload(); }}>Remove</button></div>)}
    <div className="stack">
      <div><label className="f" htmlFor="mn">Name</label><input id="mn" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Confluence KB" /></div>
      <div><label className="f" htmlFor="mu">Server URL (Streamable HTTP)</label><input id="mu" type="text" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></div>
      <div><label className="f" htmlFor="mt">Access token (optional{form.server_id ? "; leave empty to keep" : ""})</label><input id="mt" type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} /></div>
      <div className="row"><button className="btn" disabled={busy || !form.name || !/^https?:\/\//.test(form.url)} onClick={async () => { setBusy(true); setError(null); try { const id = await save(form.tools); setForm({ ...form, server_id: id }); const t = await api(`/v1/workspaces/${ws.id}/mcp/${id}/test`, { method: "POST" }); if (!t.ok) throw new Error("Couldn't connect: " + t.error); setFound(t.tools); list.reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Connecting…" : "Save & discover tools"}</button></div>
      {found && <div className="stack"><h3>Allow tools</h3>{found.map((t) => <label key={t.name} className="chk"><input type="checkbox" checked={form.tools.includes(t.name)} onChange={(e) => setForm({ ...form, tools: e.target.checked ? [...form.tools, t.name] : form.tools.filter((x) => x !== t.name) })} /><span><span className="mono">{t.name}</span><br /><span className="small">{t.description}</span></span></label>)}
        <div className="small">Allow read-only lookups. Avoid tools that create or change data.</div>
        <button className="btn pri" onClick={async () => { await save(form.tools); toast("Tool allowlist saved"); setFound(null); setForm({ name: "", url: "https://", token: "", tools: [] }); list.reload(); }}>Save allowlist</button></div>}
      <ErrorNote error={error} />
    </div>
  </div>;
}

function AuditLog({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState(false); const log = useAsync(() => (open ? api(`/v1/workspaces/${ws.id}/audit`) : Promise.resolve(null)), [open]);
  return <div className="card stack"><details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}><summary><b>Audit trail</b> <span className="small">(tamper-evident)</span></summary>
    {log.loading && open && <Loading />}
    <div className="scroll mono" style={{ marginTop: 6 }}>{log.data?.events.map((e: any) => <div key={e.id}>{new Date(e.occurred_at).toLocaleString()} · {e.action} · {e.target_type}{e.metadata && Object.keys(e.metadata).length ? " · " + JSON.stringify(e.metadata).slice(0, 120) : ""}</div>)}</div></details></div>;
}

function DevEndpoints() {
  const [v, setV] = useState({ supabaseUrl: "", publishableKey: "", apiUrl: "" }); const [cur, setCur] = useState<string>("");
  useEffect(() => { getLocal("devEndpoints", { supabaseUrl: "", publishableKey: "", apiUrl: "" }).then(setV); endpoints().then((e) => setCur(e.apiUrl)); }, []);
  return <div className="card stack"><details><summary><b>Advanced: service endpoints</b></summary>
    <div className="stack" style={{ marginTop: 6 }}>
      <div className="small">For staging or local testing only. Leave empty to use the values built into this extension. Current API: <span className="mono">{cur}</span></div>
      <input type="text" aria-label="Supabase URL" placeholder="Supabase URL" value={v.supabaseUrl} onChange={(e) => setV({ ...v, supabaseUrl: e.target.value })} />
      <input type="text" aria-label="Publishable key" placeholder="Publishable key" value={v.publishableKey} onChange={(e) => setV({ ...v, publishableKey: e.target.value })} />
      <input type="text" aria-label="API URL" placeholder="API URL (optional)" value={v.apiUrl} onChange={(e) => setV({ ...v, apiUrl: e.target.value })} />
      <div className="row"><button className="btn" onClick={async () => { await setLocal("devEndpoints", v); location.reload(); }}>Save & reload</button><button className="btn ghost" onClick={async () => { await setLocal("devEndpoints", {}); location.reload(); }}>Reset</button></div>
    </div></details></div>;
}
