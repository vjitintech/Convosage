#!/usr/bin/env bash
# Runs the API edge function locally against local Postgres + mocks (for extension end-to-end tests).
export SUPABASE_DB_URL=${SUPABASE_DB_URL:-postgres://postgres:postgres@localhost:5432/convosage}
export SUPABASE_JWT_SECRET=test-jwt-secret-test-jwt-secret-1234 MODEL_PROVIDER=anthropic MODEL_BASE_URL=http://127.0.0.1:18100 MODEL_API_KEY=test
export ASR_BASE_URL=http://127.0.0.1:18100/v1 BILLING_PROVIDER=razorpay TEST_PHONES=919999900001,15550100002 MCP_SECRET_KEY=0123456789abcdef0123456789abcdef0123 PORT=8000
# AI_MODE=openai mimics the user's Gemini setup (OpenAI-compatible endpoint); MODEL_API_KEY=bad-key simulates a rejected key.
if [ "${AI_MODE:-}" = "openai" ]; then export MODEL_PROVIDER=openai MODEL_BASE_URL=http://127.0.0.1:18100/v1beta/openai MODEL_NAME=gemini-2.5-flash MODEL_API_KEY=${KEY:-test}; fi
exec deno run -A --no-check supabase/functions/api/index.ts
