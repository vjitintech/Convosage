// chrome.storage helpers (works in side panel, service worker and extension pages).
export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const r = await chrome.storage.local.get(key); return (r[key] as T) ?? fallback;
}
export async function setLocal(key: string, value: unknown) { await chrome.storage.local.set({ [key]: value }); }
export async function removeLocal(key: string) { await chrome.storage.local.remove(key); }

import { CONFIG } from "../config";
export interface Endpoints { supabaseUrl: string; publishableKey: string; apiUrl: string }
/** Developer overrides (Settings → Advanced) take precedence over config.ts — used for staging/local testing. */
export async function endpoints(): Promise<Endpoints> {
  const o = await getLocal<Partial<Endpoints>>("devEndpoints", {});
  const supabaseUrl = (o.supabaseUrl || CONFIG.SUPABASE_URL).replace(/\/$/, "");
  return {
    supabaseUrl,
    publishableKey: o.publishableKey || CONFIG.SUPABASE_PUBLISHABLE_KEY,
    apiUrl: (o.apiUrl || CONFIG.API_URL || supabaseUrl + "/functions/v1/api").replace(/\/$/, ""),
  };
}
export function isConfigured(e: Endpoints) { return !/YOUR-PROJECT-REF|YOUR-SUPABASE/.test(e.supabaseUrl + e.publishableKey); }
