#!/usr/bin/env bash
# Runs the mastery-rigor gate against the LIVE observer prompt. Pulls the API key
# from the worktree's Convex deployment env if not already in the shell.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  ANTHROPIC_API_KEY="$(npx convex env get ANTHROPIC_API_KEY 2>/dev/null || true)"
  export ANTHROPIC_API_KEY
fi
[ -z "${ANTHROPIC_API_KEY:-}" ] && { echo "No ANTHROPIC_API_KEY"; exit 2; }
exec npx tsx evals/observer/rigor-check.ts "$@"
