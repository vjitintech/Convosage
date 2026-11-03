// Phone OTP sign-in via Supabase Auth (SMS through Twilio Verify, configured in Supabase).
// Tokens are short-lived and rotated with the refresh token; no secrets are bundled in the extension.
import { endpoints, getLocal, removeLocal, setLocal } from "./storage";

export interface Session { access_token: string; refresh_token: string; expires_at: number; user: { id: string; phone?: string } }
const KEY = "authSession";

async function gotrue(path: string, body: unknown, accessToken?: string) {
  const e = await endpoints();
  const res = await fetch(e.supabaseUrl + "/auth/v1" + path, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: e.publishableKey, ...(accessToken ? { authorization: "Bearer " + accessToken } : {}) },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j.msg || j.error_description || j.message || "Request failed";
    throw new Error(/rate limit|too many/i.test(msg) ? "Too many attempts. Please wait a minute and try again." : /invalid|expired/i.test(msg) ? "That code is incorrect or has expired." : msg);
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
