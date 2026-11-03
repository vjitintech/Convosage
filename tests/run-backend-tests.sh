#!/usr/bin/env bash
# Backend integration tests: needs local Postgres 16 + pgvector, Deno 2, Node 20 (for mock AI + MCP test server).
set -euo pipefail
cd "$(dirname "$0")"
node mock-ai.mjs & AI=$!; node mcp-http-server.mjs & MCP=$!; trap 'kill $AI $MCP' EXIT; sleep 1
cd .. && TEST_DB_URL=${TEST_DB_URL:-postgres://postgres:postgres@localhost:5432/convosage} deno test -A --no-check tests/api.test.ts
