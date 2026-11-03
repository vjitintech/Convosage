// Minimal stand-in for Supabase Auth phone OTP (test numbers only), issuing HS256 JWTs like a local Supabase.
import http from "node:http"; import crypto from "node:crypto";
const SECRET = process.env.JWT_SECRET || "test-jwt-secret-test-jwt-secret-1234";
const TEST = { "919999900001": "123456", "15550100002": "654321" };
const users = {}; const refresh = {};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => { const h = b64({ alg: "HS256", typ: "JWT" }), b = b64(p); return `${h}.${b}.${crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url")}`; };
const session = (phone) => { const id = users[phone] ||= crypto.randomUUID(); const now = Math.floor(Date.now() / 1000); const rt = crypto.randomBytes(16).toString("hex"); refresh[rt] = phone;
  return { access_token: jwt({ sub: id, phone, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 }), refresh_token: rt, expires_in: 3600, expires_at: now + 3600, user: { id, phone } }; };
http.createServer((req, res) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {}; const send = (s, o) => { res.writeHead(s, { "content-type": "application/json", ...cors }); res.end(JSON.stringify(o)); };
    const phone = String(body.phone || "").replace(/^\+/, "");
    if (req.url.startsWith("/auth/v1/otp")) return TEST[phone] ? send(200, {}) : send(400, { msg: "SMS provider not configured in local test (use a test number)" });
    if (req.url.startsWith("/auth/v1/verify")) return TEST[phone] && TEST[phone] === body.token ? send(200, session(phone)) : send(400, { msg: "Token has expired or is invalid" });
    if (req.url.startsWith("/auth/v1/token")) { const p = refresh[body.refresh_token]; return p ? send(200, session(p)) : send(400, { msg: "Invalid Refresh Token" }); }
    if (req.url.startsWith("/auth/v1/logout")) return send(204, {});
    send(404, { msg: "not found" });
  });
}).listen(18300, () => console.log("mock gotrue on 18300"));
