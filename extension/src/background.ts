// Service worker: opens the side panel, owns the offscreen capture document, shows a persistent
// capture indicator on the toolbar icon, and brokers short-lived access tokens to the offscreen page.
import { accessToken } from "./lib/auth";
import { endpoints } from "./lib/storage";
import type { CaptureStatus } from "./lib/types";

chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); });

let status: CaptureStatus = { state: "idle", sources: [], queued: 0, uploaded: 0, failed: 0, degraded: [] };

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DISPLAY_MEDIA],
    justification: "Capture meeting audio and the user-selected screen only after the user presses Start capture." });
}
async function closeOffscreen() { try { await chrome.offscreen.closeDocument(); } catch { /* none */ } }

function setIndicator(s: CaptureStatus) {
  const text = s.state === "capturing" ? "REC" : s.state === "paused" ? "II" : "";
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: s.state === "capturing" ? "#b42318" : "#a86a12" }).catch(() => {});
  chrome.action.setTitle({ title: s.state === "capturing" ? "CONVOSAGE AI — capturing (open to stop)" : s.state === "paused" ? "CONVOSAGE AI — capture paused" : "Open CONVOSAGE AI" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case "GET_TOKEN": return reply({ token: await accessToken(), endpoints: await endpoints() });
      case "GET_STATUS": return reply(status);
      case "CHOOSE_DESKTOP": {
        chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], (streamId) => reply({ streamId: streamId || null }));
        return;
      }
      case "CAPTURE_START": {
        await ensureOffscreen();
        const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "START", params: msg.params });
        return reply(r);
      }
      case "CAPTURE_STOP": case "CAPTURE_PAUSE": case "CAPTURE_RESUME": {
        const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
        if (!ctx.length) { status = { state: "idle", sources: [], queued: 0, uploaded: 0, failed: 0, degraded: [] }; setIndicator(status); return reply({ ok: true }); }
        const r = await chrome.runtime.sendMessage({ target: "offscreen", type: msg.type.replace("CAPTURE_", ""), reason: msg.reason });
        return reply(r);
      }
      case "OFFSCREEN_STATUS": {
        status = msg.status as CaptureStatus; setIndicator(status);
        await chrome.storage.session.set({ captureStatus: status }).catch(() => {});
        chrome.runtime.sendMessage({ type: "CAPTURE_STATUS", status }).catch(() => {}); // to side panel(s)
        if (status.state === "idle") setTimeout(() => { if (status.state === "idle") closeOffscreen(); }, 1500);
        return reply({ ok: true });
      }
      case "NOTIFY": {
        chrome.notifications.create({ type: "basic", iconUrl: "icons/128.png", title: String(msg.title || "CONVOSAGE AI").slice(0, 80), message: String(msg.message || "").slice(0, 240), priority: 1 });
        return reply({ ok: true });
      }
    }
  })();
  return true;
});
