#!/usr/bin/env bash
set -euo pipefail
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
cd "$(dirname "$0")/../.."
exec npx tsx evals/practice-pad-hints/run.ts "$@"
