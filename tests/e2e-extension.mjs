// End-to-end: real extension (unpacked) in Chromium + local API + mock auth/AI + real MCP server.
let pw; try { pw = (await import("playwright")).default; } catch { pw = (await import("/opt/npm-tools/node_modules/playwright/index.js")).default; }
const { chromium } = pw;
import fs from "node:fs";
const EXT = new URL("../extension/dist", import.meta.url).pathname;
const shot = (p, n) => p.screenshot({ path: `/tmp/shots/${n}.png`, fullPage: true });
const log = (...a) => console.log("✔", ...a);
const ctx = await chromium.launchPersistentContext("/tmp/pw-ext-" + Date.now(), { headless: false, viewport: { width: 420, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2]; log("extension loaded", extId);
const errors = [];
const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`chrome-extension://${extId}/sidepanel.html`);
await page.waitForSelector("text=This build isn't connected");
log("unconfigured build shows setup notice");
await page.evaluate(() => chrome.storage.local.set({ devEndpoints: { supabaseUrl: "http://127.0.0.1:18300", publishableKey: "local-test-key", apiUrl: "http://127.0.0.1:8000" } }));
await page.reload(); await page.waitForSelector("text=Sign in");

// --- login with dummy user 1
await page.locator(".card", { hasText: "Test accounts" }).getByRole("button", { name: "Use" }).first().click();
await page.getByRole("button", { name: "Send code" }).click();
await page.getByLabel("6-digit code").fill("000000"); await page.getByRole("button", { name: /Verify/ }).click();
await page.waitForSelector("text=incorrect or has expired"); log("wrong OTP rejected");
await page.getByLabel("6-digit code").fill("123456"); await page.getByRole("button", { name: /Verify/ }).click();
await page.waitForSelector("text=Upgrade to CONVOSAGE Pro"); log("dummy user 1 signed in; paywall shown");
await shot(page, "01-paywall");

// --- dummy payment
const [checkout] = await Promise.all([ctx.waitForEvent("page"), page.getByRole("button", { name: /Subscribe/ }).click()]);
await checkout.waitForLoadState(); await checkout.waitForSelector("text=TEST MODE");
await checkout.getByLabel("Test card number").fill("4000 0000 0000 0002"); await checkout.getByRole("button", { name: /Pay/ }).click();
await checkout.waitForSelector("text=declined"); log("declining test card shows decline");
await checkout.getByLabel("Test card number").fill("4111 1111 1111 1111"); await checkout.getByRole("button", { name: /Pay/ }).click();
await checkout.waitForSelector("text=Payment successful"); await shot(checkout, "02-checkout-success"); await checkout.close();
await page.waitForSelector(".top >> text=Pro", { timeout: 15000 }); log("subscription active after dummy payment");

// --- MCP server (admin)
await page.getByRole("button", { name: /Settings/ }).click();
await page.getByLabel("Name", { exact: true }).last().fill("kt-kb");
await page.getByLabel("Server URL (Streamable HTTP)").fill("http://127.0.0.1:18200/mcp");
await page.getByLabel(/Access token/).fill("mcp-test-token");
await page.getByRole("button", { name: "Save & discover tools" }).click();
await page.waitForSelector("text=search_kb"); await page.getByLabel(/search_kb/).check();
await page.getByRole("button", { name: "Save allowlist" }).click(); await page.waitForSelector("text=allowed: search_kb");
log("MCP server connected; search_kb allowed"); await shot(page, "03-settings-mcp");
await page.getByRole("button", { name: "← Back" }).click();

// --- create session
await page.getByLabel("Meaningful title").fill("Claims batch KT — Day 1"); await page.getByRole("button", { name: "Create" }).click();
await page.waitForSelector("text=Disable session"); log("session created & opened (Active)");
const sessionsHaveCounts = await page.evaluate(() => /\b\d+\s+(questions|segments|slides|participants|documents)\b/i.test(document.body.innerText));
if (sessionsHaveCounts) throw new Error("count text found in session UI"); log("no session counts in UI");

// --- import transcript (.vtt) → live questions via long-poll
await page.getByRole("tab", { name: "Documents" }).click();
fs.writeFileSync("/tmp/kt.vtt", "WEBVTT\n\n00:00:05.000 --> 00:00:12.000\n<v Priya>The nightly claims batch CLMV0200 restarts from the top when it abends.\n\n00:00:12.000 --> 00:00:20.000\n<v Arjun>Support copies production extracts into test, email ops@example.com.\n");
await page.locator('input[type=file][accept=".vtt,.srt,.txt"]').setInputFiles("/tmp/kt.vtt");
await page.waitForSelector("text=Imported 2 transcript lines"); log("transcript imported");
await page.getByRole("tab", { name: "Live" }).click();
await page.waitForSelector("text=checkpoint STEP020", { timeout: 25000 }); log("live question appeared via events (MCP-informed)");
await page.waitForSelector("text=Informed by kt-kb/search_kb");
await shot(page, "04-live-questions");
const card = page.locator("article.q").first();
await card.getByRole("button", { name: "Mark answered" }).click(); await card.getByLabel("Answer").fill("Ops will switch to checkpoint restart from STEP020.");
await card.getByRole("button", { name: "Save answer" }).click(); await page.getByRole("radio", { name: "Answered" }).click();
await page.waitForSelector("text=✓ Confirmed answer"); log("question marked answered with confirmed answer");
await page.getByRole("radio", { name: "To ask" }).click();

// --- knowledge, ask, export
await page.getByRole("tab", { name: "Knowledge" }).click(); await page.getByRole("button", { name: /Generate|Refresh/ }).click();
await page.waitForSelector("text=Restart from checkpoint STEP020"); await page.waitForSelector("text=Owner: not stated"); log("knowledge generated; no fabricated owner");
await shot(page, "05-knowledge");
await page.getByRole("tab", { name: "Ask" }).click(); await page.getByLabel("Your question").fill("How does the claims batch restart?");
await page.getByRole("button", { name: "Ask", exact: true }).click(); await page.waitForSelector("text=Sources"); log("cross-session answer with sources");
await page.getByRole("tab", { name: "Export" }).click();
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Markdown" }).click()]);
const md = fs.readFileSync(await dl.path(), "utf8"); if (md.includes("ops@example.com") || !md.includes("[EMAIL]")) throw new Error("export not redacted");
log("markdown export downloaded and redacted");
const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "PDF" }).click()]);
if (!fs.readFileSync(await dl2.path()).slice(0, 4).toString().startsWith("%PDF")) throw new Error("bad pdf"); log("PDF export works");

// --- disable / enable
await page.getByRole("tab", { name: "Live" }).click();
await page.getByRole("button", { name: "Disable session" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Disable session" }).click();
await page.waitForSelector("text=new capture and processing are blocked"); 
if (!(await page.getByRole("button", { name: "● Start capture" }).isDisabled())) throw new Error("start capture should be disabled");
log("disabled: capture blocked, notice shown"); await shot(page, "06-disabled");
await page.getByRole("button", { name: "Enable session" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Enable session" }).click();
await page.waitForSelector("text=Disable session"); log("re-enabled (capture not auto-started)");
const rec = await page.locator(".rec").count(); if (rec) throw new Error("capture indicator present after re-enable");

// --- capture start dialog renders consent + sources
await page.getByRole("button", { name: "● Start capture" }).click(); await page.waitForSelector("text=Meeting tab audio");
if (!(await page.getByRole("dialog").getByRole("button", { name: "Start capture" }).isDisabled())) throw new Error("must require consent");
await shot(page, "07-capture-consent"); await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click(); log("capture requires explicit consent");

// --- dummy user 2 is isolated
await page.getByRole("button", { name: /Settings/ }).click(); await page.getByRole("button", { name: "Sign out" }).click();
await page.waitForSelector("text=Sign in");
await page.locator(".card", { hasText: "Test accounts" }).getByRole("button", { name: "Use" }).nth(1).click();
await page.getByRole("button", { name: "Send code" }).click(); await page.getByLabel("6-digit code").fill("654321"); await page.getByRole("button", { name: /Verify/ }).click();
await page.waitForSelector("text=Upgrade to CONVOSAGE Pro");
await page.waitForSelector("text=No sessions yet"); log("dummy user 2 signed in; cannot see user 1's sessions");
await shot(page, "08-user2");
if (errors.length) throw new Error("page errors: " + errors.join(" | "));
console.log("\nALL EXTENSION E2E CHECKS PASSED");
await ctx.close();
