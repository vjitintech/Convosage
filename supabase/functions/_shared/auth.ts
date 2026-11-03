// Verifies Supabase Auth access tokens (phone OTP sign-in) and maps them to app users.
// Supports asymmetric signing keys (JWKS, current Supabase default) and legacy HS256 secrets.
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "npm:jose@5.9.6";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export interface AuthUser { id: string; phone: string | null; role: string; aal?: string }

export async function authenticate(req: Request): Promise<AuthUser> {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "unauthenticated", "Please sign in.");
  let payload: JWTPayload;
  try {
    const { alg } = decodeProtectedHeader(token);
    if (alg === "HS256") {
      if (!config.jwtSecret) throw new Error("no hs256 secret");
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), { audience: "authenticated" }));
    } else {
      if (!jwks) jwks = createRemoteJWKSet(new URL(config.supabaseUrl + "/auth/v1/.well-known/jwks.json"));
      ({ payload } = await jwtVerify(token, jwks, { audience: "authenticated" }));
    }
  } catch {
    throw new HttpError(401, "invalid_token", "Your sign-in has expired. Please sign in again.");
  }
  if (!payload.sub || payload.role !== "authenticated") throw new HttpError(401, "invalid_token", "Please sign in.");
  return { id: String(payload.sub), phone: (payload as Record<string, unknown>).phone as string || null, role: String(payload.role), aal: (payload as Record<string, unknown>).aal as string };
}
