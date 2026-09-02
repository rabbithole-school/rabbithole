#!/usr/bin/env bash
# Runs the PCM-dimension tagging gate against the LIVE observer prompt. Pulls
# the API key from the worktree's Convex deployment env if not already in the
# shell (same pattern as rigor-check.sh / fluency-check.sh). The underlying
# .ts file itself handles a missing key gracefully (prints a message, exits
# 0), so this wrapper doesn't hard-fail either.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  ANTHROPIC_API_KEY="$(npx convex env get ANTHROPIC_API_KEY 2>/dev/null || true)"
  export ANTHROPIC_API_KEY
fi
exec npx tsx evals/observer/pcm-dimension-check.ts "$@"
