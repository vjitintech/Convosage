// Subscriptions: Razorpay (international cards, settles INR to an Indian current account) + a "mock" provider
// that powers dummy payments for test accounts (TEST_PHONES) — usable even in production.
import { config } from "./config.ts";
import { sql } from "./db.ts";
import { HttpError, randomToken } from "./http.ts";

const enc = new TextEncoder();
async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function providerFor(phone: string | null): "razorpay" | "mock" {
  const p = (phone || "").replace(/^\+/, "");
  if (p && config.testPhones.map((x) => x.replace(/^\+/, "")).includes(p)) return "mock";
  return config.billingProvider;
}

export async function createSubscription(userId: string, phone: string | null, workspaceId: string) {
  const db = sql();
  const provider = providerFor(phone);
  // Reuse a recent pending checkout instead of creating duplicates
  const pending = await db`select * from app.subscriptions where user_id = ${userId} and provider = ${provider} and status = 'created'
                           and created_at > now() - interval '23 hours' order by created_at desc limit 1`;
  if (pending.length && pending[0].checkout_url) return { provider, checkout_url: pending[0].checkout_url as string, subscription_id: pending[0].provider_subscription_id as string };

  if (provider === "mock") {
    const id = "mock_sub_" + randomToken(9);
    const sig = await hmacHex(config.mockSecret, id);
    // The checkout page lives inside the extension (checkout.html); the extension fills in its own origin.
    const checkout = `checkout.html?s=${encodeURIComponent(id)}&t=${sig}`;
    await db`insert into app.subscriptions (user_id, workspace_id, provider, provider_subscription_id, plan_id, status, checkout_url)
             values (${userId}, ${workspaceId}, 'mock', ${id}, 'mock_plan_usd_10', 'created', ${checkout})`;
    await db`select app.audit(${workspaceId}, ${userId}, 'subscription', ${id}, 'billing.checkout_created', ${db.json({ provider: "mock" })})`;
    return { provider, checkout_url: checkout, subscription_id: id };
  }

  if (!config.razorpayKeyId || !config.razorpayKeySecret || !config.razorpayPlanId) throw new HttpError(503, "billing_unconfigured", "Payments are not configured yet.");
  const r = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Basic " + btoa(config.razorpayKeyId + ":" + config.razorpayKeySecret) },
    body: JSON.stringify({ plan_id: config.razorpayPlanId, total_count: 120, quantity: 1, customer_notify: 1, notes: { user_id: userId, workspace_id: workspaceId } }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.id) { console.error("razorpay create failed", r.status, body?.error); throw new HttpError(502, "billing_error", "Couldn't start checkout. Please try again."); }
  await db`insert into app.subscriptions (user_id, workspace_id, provider, provider_subscription_id, plan_id, status, checkout_url, raw)
           values (${userId}, ${workspaceId}, 'razorpay', ${body.id}, ${config.razorpayPlanId}, ${body.status || "created"}, ${body.short_url}, ${db.json(body)})`;
  await db`select app.audit(${workspaceId}, ${userId}, 'subscription', ${body.id}, 'billing.checkout_created', ${db.json({ provider: "razorpay" })})`;
  return { provider, checkout_url: body.short_url as string, subscription_id: body.id as string };
}

export async function cancelSubscription(userId: string) {
  const db = sql();
  const [s] = await db`select * from app.subscriptions where user_id = ${userId} and status in ('active','authenticated','pending') order by updated_at desc limit 1`;
  if (!s) throw new HttpError(404, "not_found", "No active subscription.");
  if (s.provider === "razorpay") {
    const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${s.provider_subscription_id}/cancel`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + btoa(config.razorpayKeyId + ":" + config.razorpayKeySecret) },
      body: JSON.stringify({ cancel_at_cycle_end: 1 }),
    });
    if (!r.ok) throw new HttpError(502, "billing_error", "Couldn't cancel right now. Please try again.");
    await db`update app.subscriptions set raw = raw || '{"cancel_at_cycle_end":true}'::jsonb, updated_at = now() where id = ${s.id}`;
  } else {
    await db`update app.subscriptions set status = 'cancelled', updated_at = now() where id = ${s.id}`;
  }
  await db`select app.audit(${s.workspace_id}, ${userId}, 'subscription', ${s.provider_subscription_id}, 'billing.cancel_requested', '{}'::jsonb)`;
  return { ok: true, provider: s.provider };
}

/** Apply a provider subscription status update idempotently. */
export async function applySubscriptionEvent(provider: string, eventId: string, type: string, entity: Record<string, unknown>, payload: unknown) {
  const db = sql();
  const ins = await db`insert into app.billing_events (provider, event_id, type, payload) values (${provider}, ${eventId}, ${type}, ${db.json(payload as never)})
                       on conflict (provider, event_id) do nothing returning id`;
  if (!ins.length) return { duplicate: true };
  const subId = String(entity.id || "");
  const status = String(entity.status || "").toLowerCase();
  const allowed = ["created", "authenticated", "active", "pending", "halted", "cancelled", "completed", "expired", "paused"];
  const currentEnd = entity.current_end ? new Date(Number(entity.current_end) * 1000) : null;
  const rows = await db`update app.subscriptions set
      status = coalesce(${allowed.includes(status) ? status : null}, status),
      current_period_end = coalesce(${currentEnd}, current_period_end),
      raw = ${db.json(entity as never)}, updated_at = now()
    where provider = ${provider} and provider_subscription_id = ${subId} returning user_id, workspace_id, status`;
  if (rows.length) await db`select app.audit(${rows[0].workspace_id}, ${rows[0].user_id}, 'subscription', ${subId}, ${"billing." + type}, ${db.json({ status: rows[0].status })})`;
  return { updated: rows.length };
}

export async function verifyRazorpaySignature(rawBody: string, signature: string) {
  if (!config.razorpayWebhookSecret) return false;
  return timingSafeEqual(await hmacHex(config.razorpayWebhookSecret, rawBody), signature || "");
}

/** Dummy payment: completes a mock subscription (only for mock_sub_* ids with a valid signature). */
export async function completeMockPayment(userId: string, subId: string, sig: string, card: string) {
  if (!/^mock_sub_[A-Za-z0-9_-]+$/.test(subId)) throw new HttpError(400, "bad_request", "Invalid checkout.");
  if (!timingSafeEqual(await hmacHex(config.mockSecret, subId), sig || "")) throw new HttpError(403, "forbidden", "Invalid checkout link.");
  const digits = String(card || "").replace(/\D/g, "");
  if (digits === "4000000000000002") throw new HttpError(402, "card_declined", "Test card declined (this test card always fails).");
  if (!["4111111111111111", "5555555555554444", "4242424242424242"].includes(digits)) throw new HttpError(400, "invalid_card", "Use a dummy test card: 4111 1111 1111 1111.");
  const db = sql();
  const [s] = await db`select * from app.subscriptions where provider = 'mock' and provider_subscription_id = ${subId} and user_id = ${userId}`;
  if (!s) throw new HttpError(404, "not_found", "Checkout not found.");
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const entity = { id: subId, status: "active", current_end: end, plan_id: "mock_plan_usd_10", amount: 1000, currency: "USD", test: true };
  await applySubscriptionEvent("mock", "evt_" + randomToken(8), "subscription.activated", entity, { mock: true, card_last4: digits.slice(-4) });
  return { ok: true, status: "active", current_period_end: new Date(end * 1000).toISOString() };
}
