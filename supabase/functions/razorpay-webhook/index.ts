// Razorpay webhook receiver. Configure in Razorpay Dashboard → Webhooks:
//   URL: https://<project>.supabase.co/functions/v1/razorpay-webhook   Secret: RAZORPAY_WEBHOOK_SECRET
//   Events: subscription.authenticated, subscription.activated, subscription.charged, subscription.pending,
//           subscription.halted, subscription.cancelled, subscription.completed, subscription.paused, subscription.resumed
// Deploy with JWT verification OFF for this function (Razorpay cannot send a Supabase token): see supabase/config.toml.
import { applySubscriptionEvent, verifyRazorpaySignature } from "../_shared/billing.ts";

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return new Response("too large", { status: 413 });
  const sig = req.headers.get("x-razorpay-signature") || "";
  if (!(await verifyRazorpaySignature(raw, sig))) return new Response("invalid signature", { status: 401 });
  let body: { event?: string; payload?: { subscription?: { entity?: Record<string, unknown> } } };
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const type = String(body.event || "");
  const entity = body.payload?.subscription?.entity;
  if (!type.startsWith("subscription.") || !entity?.id) return new Response(JSON.stringify({ ignored: true }), { status: 200 });
  const eventId = req.headers.get("x-razorpay-event-id") || `${type}:${entity.id}:${entity.status}:${entity.paid_count ?? ""}:${entity.current_end ?? ""}`;
  const res = await applySubscriptionEvent("razorpay", eventId, type, entity, body);
  return new Response(JSON.stringify({ ok: true, ...res }), { status: 200, headers: { "content-type": "application/json" } });
}
if (import.meta.main) Deno.serve({ port: Number(Deno.env.get("PORT") || 8001) }, handler);
