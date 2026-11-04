#!/usr/bin/env bash
# Full local end-to-end: fresh DB schema + mock auth/AI + MCP test server + local API + real extension in Chromium.
# Needs Postgres 16 (+pgvector), Deno 2, Node 20, Xvfb (or a desktop), and `npm run build` in extension/.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${TEST_DB_URL:-postgres://postgres:postgres@localhost:5432/convosage}
psql "$DB" -qc "drop schema if exists app cascade" >/dev/null
for f in supabase/migrations/*.sql; do psql "$DB" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
node tests/mock-ai.mjs >/tmp/mock-ai.log 2>&1 & A=$!
node tests/mcp-http-server.mjs >/tmp/mcp.log 2>&1 & M=$!
node tests/mock-gotrue.mjs >/tmp/gotrue.log 2>&1 & G=$!
bash tests/run-api-local.sh >/tmp/api.log 2>&1 & P=$!   # set AI_MODE=openai to mimic Gemini, KEY=bad-key + EXPECT_BAD_KEY=1 for a rejected key
trap 'kill $A $M $G $P 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -s http://127.0.0.1:8000/v1/health >/dev/null 2>&1 && break; sleep 1; done
RUN="node"; [ -z "${DISPLAY:-}" ] && RUN="xvfb-run -a -s '-screen 0 1280x1024x24' node"
for t in ${@:-tests/e2e-extension.mjs tests/e2e-capture.mjs}; do echo "=== $t"; eval $RUN "$t"; done
