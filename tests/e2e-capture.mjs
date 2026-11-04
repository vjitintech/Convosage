// End-to-end capture test: real extension in Chromium captures a browser tab that is playing a "meeting"
// (audio + a slide), the local API transcribes/reads it, questions appear live, stop → wrap-up, delete → erased.
let pw; try { pw = (await import("/opt/npm-tools/node_modules/playwright/index.js")).default; } catch { pw = (await import("playwright")).default; }
const { chromium } = pw;
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { execFileSync } from "node:child_process";

const EXT = new URL("../extension/dist", import.meta.url).pathname;
const FIX = new URL("./fixtures/", import.meta.url).pathname;
const DB = process.env.TEST_DB_URL || "postgres://postgres:postgres@localhost:5432/convosage";
const q = (sql) => execFileSync("psql", [DB, "-At", "-c", sql]).toString().trim();
const log = (...a) => console.log("✔", ...a);
fs.mkdirSync("/tmp/shots", { recursive: true });
const shot = (p, n) => p.screenshot({ path: `/tmp/shots/${n}.png`, fullPage: true });
const until = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("timed out: " + what); };

// Static server for the fake meeting page
const srv = http.createServer((req, res) => {
  const f = path.join(FIX, path.basename(req.url.split("?")[0]) || "meeting.html");
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "audio/webm" }); fs.createReadStream(f).pipe(res);
}).listen(18400);

const ctx = await chromium.launchPersistentContext("/tmp/pw-cap-" + Date.now(), { headless: false, viewport: { width: 1100, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required",
    "--auto-select-desktop-capture-source=Convosage test meeting", "--auto-accept-this-tab-capture", "--use-fake-ui-for-media-stream"] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
const errors = [];

const meeting = await ctx.newPage(); await meeting.goto("http://127.0.0.1:18400/meeting.html");
await until(() => meeting.evaluate(() => !document.getElementById("a").paused), 10000, "meeting audio playing"); log("meeting tab is playing audio and showing a slide");

const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`chrome-extension://${extId}/sidepanel.html`);
await page.evaluate(() => chrome.storage.local.set({ devEndpoints: { supabaseUrl: "http://127.0.0.1:18300", publishableKey: "local-test-key", apiUrl: "http://127.0.0.1:8000" } }));
await page.reload(); await page.waitForSelector("text=Sign in");
await page.locator(".card", { hasText: "Test accounts" }).getByRole("button", { name: "Use" }).first().click();
await page.getByRole("button", { name: "Send code" }).click(); await page.getByLabel("6-digit code").fill("123456"); await page.getByRole("button", { name: /Verify/ }).click();
await page.locator("text=Upgrade to CONVOSAGE Pro").or(page.locator(".top >> text=Pro")).first().waitFor({ timeout: 15000 });
if (await page.getByRole("button", { name: /Subscribe/ }).count()) {
  const [checkout] = await Promise.all([ctx.waitForEvent("page"), page.getByRole("button", { name: /Subscribe/ }).click()]);
  await checkout.waitForLoadState(); await checkout.getByLabel("Test card number").fill("4111 1111 1111 1111"); await checkout.getByRole("button", { name: /Pay/ }).click();
  await checkout.waitForSelector("text=Payment successful"); await checkout.close();
}
await page.waitForSelector(".top >> text=Pro", { timeout: 15000 }); log("signed in with dummy user 1, subscription active");

const title = "MCP explained — capture test " + Date.now();
await page.getByLabel("Meaningful title").fill(title); await page.getByRole("button", { name: "Create" }).click();
await page.waitForSelector("text=Disable session");
const sid = q(`select id from app.sessions where title = '${title}'`); log("session created", sid);

// Start capture: choose the meeting tab, hear + see, no microphone
await page.getByRole("button", { name: "● Start capture" }).click();
const dlg = page.getByRole("dialog");
await dlg.getByLabel("Meeting tab").selectOption({ label: "🔊 Convosage test meeting" }).catch(async () => dlg.getByLabel("Meeting tab").selectOption({ label: "Convosage test meeting" }));
if (await dlg.getByLabel(/My microphone/).isChecked()) throw new Error("microphone must be off by default");
await dlg.getByLabel(/I have permission/).check();
await shot(page, "c1-start-dialog");
await dlg.getByRole("button", { name: "Start capture" }).click();
await page.bringToFront();
await until(async () => (await dlg.count()) === 0 || !(await dlg.getByRole("button", { name: "Starting…" }).count()), 30000, "capture start");
if (await dlg.count()) { await shot(page, "c1-start-error"); throw new Error("capture failed to start: " + (await dlg.getByRole("alert").innerText())); }
await page.waitForSelector("text=■ Stop capture"); log("capture started");

const srcs = await until(() => { const r = q(`select string_agg(distinct source, ',') from app.transcript_segments where session_id = '${sid}'`); return r || null; }, 45000, "transcript from tab audio");
if (!srcs.includes("tab_audio") || srcs.includes("microphone")) throw new Error("expected tab audio only, got " + srcs);
log("meeting tab audio transcribed (source: " + srcs + ")");
await until(() => Number(q(`select count(*) from app.visual_evidence where session_id = '${sid}'`)) > 0, 45000, "screen read from tab video");
log("what is shown in the tab was read (visual evidence stored)");
await page.waitForSelector("text=Hearing the meeting", { timeout: 20000 }); log("UI shows it is hearing the meeting");
await page.waitForSelector("article.q", { timeout: 30000 }); log("live questions appeared while capturing");
await page.waitForSelector("text=/To ask · \\d+/"); log("question groups shown with counts");
if (await page.locator("text=Dismissed ·").count()) throw new Error("empty Dismissed group should be hidden");
await shot(page, "c2-capturing");

// Stop → wrap-up questions over the whole meeting
await page.getByRole("button", { name: "■ Stop capture" }).click();
await until(() => Number(q(`select count(*) from app.question_suggestions where session_id = '${sid}' and model_meta->>'phase' = 'final'`)) > 0, 30000, "wrap-up questions");
await page.waitForSelector("text=/Wrap-up · \\d+/", { timeout: 20000 }); log("stopping capture added wrap-up questions for the whole meeting");
await shot(page, "c3-wrapup");

// Delete permanently — immediately, no grace period
await page.getByRole("button", { name: /^Delete/ }).first().click();
await page.getByRole("dialog").getByRole("button", { name: "Delete permanently" }).click();
await until(() => q(`select status from app.sessions where id = '${sid}'`) === "deleted", 10000, "session deleted");
const left = q(`select (select count(*) from app.transcript_segments where session_id='${sid}') + (select count(*) from app.visual_evidence where session_id='${sid}') + (select count(*) from app.question_suggestions where session_id='${sid}')`);
if (left !== "0") throw new Error("content left after delete: " + left);
log("delete erased the session immediately (status deleted, 0 rows left, audited)");
await shot(page, "c4-after-delete");

if (errors.length) throw new Error("page errors: " + errors.join(" | "));
console.log("\nCAPTURE E2E PASSED");
await ctx.close(); srv.close();
