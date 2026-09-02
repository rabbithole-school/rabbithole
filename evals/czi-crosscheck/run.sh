#!/usr/bin/env bash
# Convenience wrapper: requires ANTHROPIC_API_KEY, then runs
# the CZI cross-check. Mirrors evals/tutor-quality/run.sh.
set -euo pipefail
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
cd "$(dirname "$0")/../.."
exec npx tsx evals/czi-crosscheck/run.ts "$@"
