// Offscreen capture engine (Manifest V3). Runs only after an explicit Start capture action.
// - Tab audio (meeting) via tabCapture stream id; audio is also played back so the user still hears the meeting.
// - Optional microphone (permission granted once via permission.html).
// - Optional user-selected screen/window/tab via desktopCapture; frames sampled around visible changes.
// Media is chunked, sent with a short-lived capture token, retried with back-off and never written to disk.
import { CONFIG } from "./config";
import type { CaptureStatus } from "./lib/types";

interface StartParams { sessionId: string; captureId: string; captureToken: string; expiresAt: string; baseMs: number; tabStreamId?: string | null; desktopStreamId?: string | null; mic?: boolean }
type Item = { kind: "audio" | "frame"; source: string; seq: number; startMs: number; endMs: number; blob: Blob; tries: number };

let P: StartParams | null = null;
let st: CaptureStatus = { state: "idle", sources: [], queued: 0, uploaded: 0, failed: 0, degraded: [] };
const streams: MediaStream[] = [];
const audioSources = new Map<MediaStream, string>();
const recorders: { rec: MediaRecorder | null; stopLoop: boolean; source: string }[] = [];
let audioCtx: AudioContext | null = null, frameTimer: number | null = null, refreshTimer: number | null = null;
let seq = 0, t0 = 0, paused = false;
const queue: Item[] = []; let pumping = false;

function push(patch: Partial<CaptureStatus>) { st = { ...st, ...patch, queued: queue.length }; chrome.runtime.sendMessage({ type: "OFFSCREEN_STATUS", status: st }).catch(() => {}); }
const now = () => (P ? P.baseMs : 0) + (Date.now() - t0);
async function token() { const r = await chrome.runtime.sendMessage({ type: "GET_TOKEN" }); return r as { token: string | null; endpoints: { apiUrl: string; publishableKey: string } }; }

async function apiCall(path: string, body: unknown) {
  const { token: tk, endpoints: e } = await token();
  const r = await fetch(e.apiUrl + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tk, apikey: e.publishableKey }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j?.error?.message || "error"), { status: r.status, code: j?.error?.code });
  return j;
}
async function refreshCaptureToken() {
  if (!P) return;
  try { const j = await apiCall(`/v1/sessions/${P.sessionId}/capture/refresh`, { capture_id: P.captureId }); P.captureToken = j.capture_token; P.expiresAt = j.expires_at; scheduleRefresh(); }
  catch (e) { const c = (e as { code?: string }).code; if (c === "session_not_active" || c === "capture_stopped" || c === "subscription_required") await stop("server_" + c, false); else setTimeout(refreshCaptureToken, 15000); }
}
function scheduleRefresh() { if (refreshTimer) clearTimeout(refreshTimer); if (!P) return; const ms = Math.max(30_000, (new Date(P.expiresAt).getTime() - Date.now()) * 0.8); refreshTimer = setTimeout(refreshCaptureToken, ms) as unknown as number; }

async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (queue.length && P && st.state !== "idle") {
      const it = queue[0];
      try {
        const { token: tk, endpoints: e } = await token();
        const r = await fetch(`${e.apiUrl}/v1/sessions/${P.sessionId}/media`, { method: "POST", body: it.blob, headers: {
          authorization: "Bearer " + tk, apikey: e.publishableKey, "content-type": it.blob.type || (it.kind === "frame" ? "image/jpeg" : "audio/webm"),
          "x-capture-token": P.captureToken, "x-capture-id": P.captureId, "x-kind": it.kind, "x-source": it.source, "x-seq": String(it.seq), "x-start-ms": String(it.startMs), "x-end-ms": String(it.endMs) } });
        if (r.ok) { queue.shift(); push({ uploaded: st.uploaded + 1, lastError: undefined }); continue; }
        const j = await r.json().catch(() => ({})); const code = j?.error?.code;
        if (code === "capture_token_expired") { await refreshCaptureToken(); continue; }
        if (["session_not_active", "capture_stopped", "subscription_required"].includes(code)) { await stop("server_" + code, false); break; }
        if (r.status === 413 || r.status === 400) { queue.shift(); push({ failed: st.failed + 1, lastError: j?.error?.message }); continue; }
        throw new Error(j?.error?.message || "upload failed " + r.status);
      } catch (e) {
        it.tries++; push({ lastError: "Connection problem — buffering and retrying (" + queue.length + " waiting)" });
        if (queue.length > 90) { queue.splice(0, queue.length - 90); push({ degraded: [...new Set([...st.degraded, "Oldest buffered media dropped after a long outage"])] }); }
        await new Promise((res) => setTimeout(res, Math.min(30000, 1000 * Math.pow(2, Math.min(it.tries, 5)))));
      }
    }
  } finally { pumping = false; }
}
function enqueue(it: Omit<Item, "tries">) { queue.push({ ...it, tries: 0 }); push({}); pump(); }

function audioLoop(stream: MediaStream, source: string) {
  const slot = { rec: null as MediaRecorder | null, stopLoop: false, source }; recorders.push(slot);
  const mime = ["audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  const one = () => {
    if (slot.stopLoop || paused || !stream.active) return;
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); slot.rec = rec;
    const parts: Blob[] = []; const start = now(); const mySeq = ++seq;
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => { const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" }); if (blob.size > 2500) enqueue({ kind: "audio", source, seq: mySeq, startMs: start, endMs: now(), blob }); if (!slot.stopLoop && !paused) one(); };
    rec.start(); setTimeout(() => rec.state !== "inactive" && rec.stop(), CONFIG.AUDIO_CHUNK_SECONDS * 1000);
  };
  one();
}

function frameLoop(stream: MediaStream) {
  const video = document.createElement("video"); video.muted = true; video.srcObject = stream; video.play().catch(() => {});
  const small = document.createElement("canvas"); small.width = 48; small.height = 27; const sctx = small.getContext("2d", { willReadFrequently: true })!;
  let prev: Uint8ClampedArray | null = null, lastSent = 0;
  const tick = async () => {
    if (paused || !stream.active || !video.videoWidth) return;
    sctx.drawImage(video, 0, 0, small.width, small.height);
    const px = sctx.getImageData(0, 0, small.width, small.height).data;
    let diff = 0; if (prev) { for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prev[i]) + Math.abs(px[i + 1] - prev[i + 1]) + Math.abs(px[i + 2] - prev[i + 2]); diff /= (px.length / 4) * 3 * 255; }
    const changed = !prev || diff > 0.04; prev = px;
    if (!changed && Date.now() - lastSent < CONFIG.FRAME_MAX_INTERVAL_MS) return;
    lastSent = Date.now();
    const scale = Math.min(1, 1280 / video.videoWidth); const c = document.createElement("canvas");
    c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale); c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.72));
    const t = now(); enqueue({ kind: "frame", source: "display", seq: ++seq, startMs: t, endMs: t, blob });
  };
  frameTimer = setInterval(tick, CONFIG.FRAME_SAMPLE_MS) as unknown as number;
}

function watchEnded(stream: MediaStream, label: string) {
  stream.getTracks().forEach((t) => t.addEventListener("ended", () => {
    push({ degraded: [...new Set([...st.degraded, `${label} ended — other sources continue`])] });
    if (streams.every((s) => !s.active)) stop("all_sources_ended");
  }));
}

async function start(p: StartParams) {
  if (st.state !== "idle") await stop("restart", true);
  P = p; t0 = Date.now(); seq = 0; paused = false; queue.length = 0;
  push({ state: "starting", sessionId: p.sessionId, captureId: p.captureId, sources: [], uploaded: 0, failed: 0, degraded: [], lastError: undefined, startedAt: Date.now() });
  const sources: string[] = []; const degraded: string[] = [];
  if (p.tabStreamId) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: p.tabStreamId } } as any, video: false });
      streams.push(s); audioCtx = new AudioContext(); audioCtx.createMediaStreamSource(s).connect(audioCtx.destination); // keep meeting audible
      audioSources.set(s, "tab_audio"); audioLoop(s, "tab_audio"); watchEnded(s, "Meeting audio"); sources.push("tab_audio");
    } catch { degraded.push("Meeting tab audio unavailable — check the tab is playing audio and try again"); }
  }
  if (p.mic) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); streams.push(s); audioSources.set(s, "microphone"); audioLoop(s, "microphone"); watchEnded(s, "Microphone"); sources.push("microphone"); }
    catch { degraded.push("Microphone blocked — allow it from the capture options"); }
  }
  if (p.desktopStreamId) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: p.desktopStreamId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 5 } } as any }); streams.push(s); frameLoop(s); watchEnded(s, "Screen share"); sources.push("display"); }
    catch { degraded.push("Screen capture was not started"); }
  }
  if (!sources.length) { await stop("no_sources", false); push({ degraded, lastError: "No capture source could be started." }); return { ok: false, degraded }; }
  scheduleRefresh();
  push({ state: "capturing", sources, degraded });
  return { ok: true, sources, degraded };
}

async function stop(reason: string, silent = false) {
  if (!P && st.state === "idle") return { ok: true };
  const p = P; push({ state: "stopping" });
  recorders.forEach((r) => { r.stopLoop = true; try { r.rec?.state !== "inactive" && r.rec?.stop(); } catch { /* ignore */ } });
  if (frameTimer) clearInterval(frameTimer); frameTimer = null; if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = null;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); streams.length = 0; recorders.length = 0; audioSources.clear();
  try { await audioCtx?.close(); } catch { /* ignore */ } audioCtx = null;
  if (!reason.startsWith("server_")) { const until = Date.now() + 6000; while (queue.length && Date.now() < until) { await pump(); await new Promise((r) => setTimeout(r, 300)); } }
  else queue.length = 0; // server refused: drop buffered media
  if (p && !reason.startsWith("server_")) { try { await apiCall(`/v1/sessions/${p.sessionId}/capture/stop`, { capture_id: p.captureId, reason }); } catch { /* best effort */ } }
  P = null; paused = false;
  push({ state: "idle", sources: [], lastError: reason.startsWith("server_") ? (reason === "server_session_not_active" ? "Capture stopped: the session was disabled." : reason === "server_subscription_required" ? "Capture stopped: subscription inactive." : "Capture stopped by the server.") : silent ? undefined : st.lastError });
  return { ok: true };
}
async function pause() {
  if (!P || st.state !== "capturing") return { ok: false };
  paused = true; recorders.forEach((r) => { try { r.rec?.state !== "inactive" && r.rec?.stop(); } catch { /* ignore */ } });
  try { await apiCall(`/v1/sessions/${P.sessionId}/capture/stop`, { capture_id: P.captureId, reason: "user_paused", paused: true }); } catch { /* ignore */ }
  push({ state: "paused" }); return { ok: true };
}
async function resume() {
  if (!P || st.state !== "paused") return { ok: false };
  await refreshCaptureToken(); if (!P) return { ok: false };
  paused = false; recorders.forEach((r) => (r.stopLoop = true)); recorders.length = 0;
  audioSources.forEach((source, s) => { if (s.active) audioLoop(s, source); });
  push({ state: "capturing" }); return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg?.target !== "offscreen") return;
  (async () => {
    if (msg.type === "START") return reply(await start(msg.params));
    if (msg.type === "STOP") return reply(await stop(msg.reason || "user_stopped"));
    if (msg.type === "PAUSE") return reply(await pause());
    if (msg.type === "RESUME") return reply(await resume());
  })();
  return true;
});
