// CONVOSAGE AI — every server-side setting in one place.
// Set these as Supabase secrets:  supabase secrets set --env-file supabase/functions/.env
// See supabase/functions/.env.example for the full list with explanations.

const env = (k: string, d = ""): string => (Deno.env.get(k) ?? d).trim();
const list = (k: string): string[] => env(k).split(",").map((s) => s.trim()).filter(Boolean);
const num = (k: string, d: number): number => { const v = Number(env(k)); return Number.isFinite(v) && v > 0 ? v : d; };

export const config = {
  appName: "CONVOSAGE AI",
  // Supabase (provided automatically inside Supabase Edge Functions)
  supabaseUrl: env("SUPABASE_URL"),
  dbUrl: env("SUPABASE_DB_URL"),
  jwtSecret: env("SUPABASE_JWT_SECRET") || env("JWT_SECRET"), // legacy HS256 projects / local tests
  // Public base URL of this API (used for hosted checkout links)
  publicApiUrl: env("PUBLIC_API_URL") || (env("SUPABASE_URL") ? env("SUPABASE_URL") + "/functions/v1/api" : "http://localhost:8000"),
  allowedOrigins: list("ALLOWED_ORIGINS"), // e.g. chrome-extension://abcdefghijklmnop ; empty = any extension origin

  // Model gateway (replaceable providers)
  modelProvider: env("MODEL_PROVIDER", "anthropic") as "anthropic" | "openai",
  modelBaseUrl: env("MODEL_BASE_URL", "https://api.anthropic.com"),
  modelApiKey: env("MODEL_API_KEY"),
  modelName: env("MODEL_NAME", "claude-sonnet-5-5"),
  modelNameLarge: env("MODEL_NAME_LARGE") || env("MODEL_NAME", "claude-sonnet-5-5"),
  visionModel: env("VISION_MODEL") || env("MODEL_NAME", "claude-sonnet-5-5"),
  asrBaseUrl: env("ASR_BASE_URL", "https://api.openai.com/v1"),
  asrApiKey: env("ASR_API_KEY"),
  asrModel: env("ASR_MODEL", "whisper-1"),
  aiDailyCallLimit: num("AI_DAILY_CALL_LIMIT", 2000), // per workspace
  mcpMaxToolCalls: num("MCP_MAX_TOOL_CALLS", 3),

  // Billing
  billingProvider: env("BILLING_PROVIDER", "mock") as "razorpay" | "mock",
  razorpayKeyId: env("RAZORPAY_KEY_ID"),
  razorpayKeySecret: env("RAZORPAY_KEY_SECRET"),
  razorpayWebhookSecret: env("RAZORPAY_WEBHOOK_SECRET"),
  razorpayPlanId: env("RAZORPAY_PLAN_ID"),             // e.g. plan_XXXX (USD 10 / month)
  planLabel: env("PLAN_LABEL", "CONVOSAGE Pro — US$10 / month"),
  // Phone numbers (E.164 without +) that always use the mock "dummy payment" checkout, even in production.
  testPhones: list("TEST_PHONES"),
  mockSecret: env("MOCK_BILLING_SECRET") || env("SUPABASE_JWT_SECRET") || "local-mock-secret",

  // Capture & limits
  captureTokenTtlSec: num("CAPTURE_TOKEN_TTL_SEC", 600),
  maxAudioChunkBytes: num("MAX_AUDIO_CHUNK_BYTES", 4_000_000),
  maxFrameBytes: num("MAX_FRAME_BYTES", 2_500_000),
  maxUploadTextChars: num("MAX_UPLOAD_TEXT_CHARS", 2_000_000),
  rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 240),
  deletionGraceDays: num("DELETION_GRACE_DAYS", 7),
  cronSecret: env("CRON_SECRET"),
  mcpSecretKey: env("MCP_SECRET_KEY"), // 32+ chars; encrypts MCP auth tokens at rest
};

export function aiConfigured() { return !!(config.modelApiKey || config.modelProvider === "openai"); }
export function asrConfigured() { return !!(config.asrApiKey || /localhost|127\.0\.0\.1/.test(config.asrBaseUrl)); }
