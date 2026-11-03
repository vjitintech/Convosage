// Postgres access for the API. Uses the database owner connection supplied by Supabase (SUPABASE_DB_URL).
// Every query that touches tenant data MUST be scoped by workspace_id — see access.ts.
import postgres from "npm:postgres@3.4.5";
import { config } from "./config.ts";

let _sql: ReturnType<typeof postgres> | null = null;
export function sql() {
  if (!_sql) {
    if (!config.dbUrl) throw new Error("SUPABASE_DB_URL is not set");
    _sql = postgres(config.dbUrl, {
      max: 5, idle_timeout: 20, connect_timeout: 10, prepare: false,
      onnotice: () => {},
      types: { bigint: postgres.BigInt },
    });
  }
  return _sql;
}
export type Sql = ReturnType<typeof postgres>;

/** Map Postgres errors raised by guards/state machine to API errors. */
export function pgErrorToHttp(e: unknown): { status: number; code: string; message: string } | null {
  const err = e as { code?: string; message?: string };
  const msg = String(err?.message || "");
  if (err?.code === "55000" || msg.startsWith("session_not_active")) return { status: 409, code: "session_not_active", message: "This session is not Active. Enable it to capture or process new content." };
  if (err?.code === "22023" && msg.startsWith("invalid_transition")) return { status: 409, code: "invalid_transition", message: msg.replace("invalid_transition:", "Cannot change status ") };
  if (msg === "legal_hold") return { status: 409, code: "legal_hold", message: "This session is under legal hold and cannot be deleted." };
  if (err?.code === "40001" || msg === "version_conflict") return { status: 409, code: "version_conflict", message: "The session changed. Refresh and try again." };
  if (err?.code === "P0002" || msg === "session_not_found") return { status: 404, code: "not_found", message: "Session not found." };
  if (err?.code === "23505") return { status: 409, code: "duplicate", message: "Already exists." };
  return null;
}
