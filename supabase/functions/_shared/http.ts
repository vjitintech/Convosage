// Small HTTP toolkit: routing, JSON, errors, CORS, rate limiting and body limits.
import { config } from "./config.ts";
import { pgErrorToHttp } from "./db.ts";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
export const bad = (m: string, code = "bad_request") => new HttpError(400, code, m);
export const forbidden = (m = "You don't have access to this.") => new HttpError(403, "forbidden", m);
export const notFound = (m = "Not found.") => new HttpError(404, "not_found", m);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  let allow = "";
  if (config.allowedOrigins.length) allow = config.allowedOrigins.includes(origin) ? origin : "";
  else if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) allow = origin;
  return {
    ...(allow ? { "access-control-allow-origin": allow, vary: "origin" } : {}),
    "access-control-allow-headers": "authorization, content-type, x-capture-token, x-capture-id, x-seq, x-start-ms, x-end-ms, x-kind, x-source, x-client-info, apikey",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "600",
  };
}

const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...SEC_HEADERS, ...corsHeaders(req), ...extra },
  });
}
export function text(req: Request, body: string, contentType: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "content-type": contentType, ...SEC_HEADERS, ...corsHeaders(req), ...extra } });
}

export function errorResponse(req: Request, e: unknown) {
  if (e instanceof HttpError) return json(req, { error: { code: e.code, message: e.message, ...e.extra } }, e.status);
  const pg = pgErrorToHttp(e);
  if (pg) return json(req, { error: { code: pg.code, message: pg.message } }, pg.status);
  console.error("unhandled", e);
  return json(req, { error: { code: "internal", message: "Something went wrong. Please try again." } }, 500);
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) throw new HttpError(413, "too_large", "Request too large.");
  const raw = await req.text();
  if (raw.length > maxBytes) throw new HttpError(413, "too_large", "Request too large.");
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; } catch { throw bad("Invalid JSON body."); }
}
export async function readBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) throw new HttpError(413, "too_large", "Chunk too large.");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new HttpError(413, "too_large", "Chunk too large.");
  return buf;
}

// Best-effort per-isolate rate limiter (a WAF / API gateway should enforce global limits in production).
const buckets = new Map<string, { t: number; n: number }>();
export function rateLimit(key: string, perMinute = config.rateLimitPerMinute) {
  const now = Date.now(); const b = buckets.get(key);
  if (!b || now - b.t > 60_000) { buckets.set(key, { t: now, n: 1 }); return; }
  if (++b.n > perMinute) throw new HttpError(429, "rate_limited", "Too many requests. Slow down and retry shortly.");
  if (buckets.size > 50_000) buckets.clear();
}

// Minimal router: add("GET", "/v1/sessions/:id", handler)
type Handler = (ctx: { req: Request; params: Record<string, string>; url: URL }) => Promise<Response>;
export class Router {
  private routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
  add(method: string, path: string, h: Handler) {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:([a-zA-Z_]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
    this.routes.push({ method, re, keys, h });
  }
  async handle(req: Request, path: string): Promise<Response> {
    const url = new URL(req.url);
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = path.match(r.re); if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return await r.h({ req, params, url });
    }
    throw notFound("No such endpoint.");
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v: unknown, name = "id"): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw bad(`Invalid ${name}.`);
  return v.toLowerCase();
}
export function str(v: unknown, name: string, max = 500, required = true): string {
  if (v === undefined || v === null || v === "") { if (required) throw bad(`${name} is required.`); return ""; }
  if (typeof v !== "string") throw bad(`${name} must be text.`);
  const s = v.trim(); if (required && !s) throw bad(`${name} is required.`);
  if (s.length > max) throw bad(`${name} is too long (max ${max}).`);
  return s;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(`${name} must be one of: ${allowed.join(", ")}.`);
  return v as T;
}
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function background(p: Promise<unknown>) {
  // Supabase Edge Runtime keeps the isolate alive for background work; locally we just let it run.
  const er = (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const safe = p.catch((e) => console.error("background task failed", e));
  if (er?.waitUntil) er.waitUntil(safe);
}
