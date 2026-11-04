// API client for the CONVOSAGE backend (Supabase Edge Function "api").
import { accessToken, forceRefresh } from "./auth";
import { endpoints } from "./storage";

export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; asText?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const e = await endpoints();
  const go = async (token: string | null) => fetch(e.apiUrl + path, {
    method: opts.method || (opts.body !== undefined || opts.raw !== undefined ? "POST" : "GET"),
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}), apikey: e.publishableKey, ...(opts.headers || {}) },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  });
  let res: Response;
  const timeout = new AbortController(); const tt = setTimeout(() => timeout.abort(), 30000);
  if (!opts.signal) opts = { ...opts, signal: timeout.signal };
  try { res = await go(await accessToken()); } catch (err) { if (timeout.signal.aborted) throw new ApiError(0, "timeout", "The CONVOSAGE server didn't respond in 30 seconds. Check that the Supabase functions are deployed and healthy."); if ((err as Error).name === "AbortError") throw err; throw new ApiError(0, "network", "Can't reach the CONVOSAGE service. Check your connection."); }
  clearTimeout(tt);
  if (res.status === 401) { const t = await forceRefresh(); if (t) res = await go(t); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) window.dispatchEvent?.(new CustomEvent("convosage:signed-out"));
    throw new ApiError(res.status, j?.error?.code || "error", j?.error?.message || `Request failed (${res.status})`);
  }
  if (opts.asText) return (await res.text()) as unknown as T;
  return (await res.json()) as T;
}
export const fmtTime = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
