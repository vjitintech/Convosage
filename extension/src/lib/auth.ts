// Phone OTP sign-in via Supabase Auth (SMS through Twilio Verify, configured in Supabase).
// Tokens are short-lived and rotated with the refresh token; no secrets are bundled in the extension.
import { endpoints, getLocal, removeLocal, setLocal } from "./storage";

export interface Session { access_token: string; refresh_token: string; expires_at: number; user: { id: string; phone?: string } }
const KEY = "authSession";

function explain(raw: string, step: "send" | "verify" | "other"): string {
  const m = raw || "Request failed";
  if (/rate limit|too many|security purposes/i.test(m)) return "Too many attempts. Please wait a minute and try again.";
  if (/invalid api key|no api key|apikey/i.test(m)) return "Setup problem: the Supabase URL or publishable key in config.ts is wrong (" + m + ").";
  if (/unsupported phone provider|phone.*(disabled|not enabled)|signups not allowed/i.test(m)) return "Setup problem: phone sign-in isn't enabled in Supabase (Authentication → Providers → Phone). (" + m + ")";
  if (step === "send" && /sending|provider|twilio|sms/i.test(m)) return "Couldn't send the SMS: " + m + ". Check the Twilio Verify settings in Supabase.";
  if (step === "send" && /phone/i.test(m)) return "That mobile number wasn't accepted: " + m;
  if (step === "verify" && /invalid|expired/i.test(m)) return "That code is incorrect or has expired.";
  return m;
}

async function gotrue(path: string, body: unknown, accessToken?: string) {
  const e = await endpoints();
  const res = await fetch(e.supabaseUrl + "/auth/v1" + path, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: e.publishableKey, ...(accessToken ? { authorization: "Bearer " + accessToken } : {}) },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(j.msg || j.error_description || j.message || j.error || `HTTP ${res.status}`);
    throw new Error(explain(msg, path.startsWith("/otp") ? "send" : path.startsWith("/verify") ? "verify" : "other"));
  }
  return j;
}
export function normalizePhone(country: string, phone: string) {
  const c = country.replace(/[^\d]/g, ""); const p = phone.replace(/[^\d]/g, "").replace(/^0+/, "");
  if (!c || p.length < 6 || p.length > 14) throw new Error("Enter a valid mobile number.");
  return "+" + c + p;
}
export async function sendOtp(phone: string) { await gotrue("/otp", { phone, create_user: true }); }
export async function verifyOtp(phone: string, token: string): Promise<Session> {
  if (!/^\d{4,8}$/.test(token)) throw new Error("Enter the code from the SMS.");
  const j = await gotrue("/verify", { type: "sms", phone, token });
  const s: Session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: { id: j.user?.id, phone: j.user?.phone } };
  await setLocal(KEY, s); return s;
}
export async function currentSession(): Promise<Session | null> { return await getLocal<Session | null>(KEY, null); }

let refreshing: Promise<Session | null> | null = null;
export async function accessToken(): Promise<string | null> {
  const s = await currentSession(); if (!s) return null;
  if (s.expires_at * 1000 - Date.now() > 60_000) return s.access_token;
  if (!refreshing) refreshing = (async () => {
    try {
      const j = await gotrue("/token?grant_type=refresh_token", { refresh_token: s.refresh_token });
      const ns: Session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: s.user };
      await setLocal(KEY, ns); return ns;
    } catch { await removeLocal(KEY); return null; } finally { setTimeout(() => (refreshing = null), 0); }
  })();
  const ns = await refreshing; return ns ? ns.access_token : null;
}
export async function forceRefresh() { const s = await currentSession(); if (s) { s.expires_at = 0; await setLocal(KEY, s); } return accessToken(); }
export async function signOut() {
  const s = await currentSession();
  if (s) { try { await gotrue("/logout", {}, s.access_token); } catch { /* ignore */ } }
  await removeLocal(KEY);
}
