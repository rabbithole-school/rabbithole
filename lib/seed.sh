#!/usr/bin/env bash
# Seed the LOCAL Rabbithole deployment with a fictional school, using only
# functions present in the public snapshot. Each step is reported; a failed
# step doesn't stop the rest.
#   lib/seed.sh <checkout-dir>
set -uo pipefail
cd "${1:?usage: lib/seed.sh <checkout-dir>}"
export CONVEX_AGENT_MODE=anonymous
unset CONVEX_DEPLOYMENT
grep -q '^CONVEX_DEPLOYMENT=anonymous:' .env.local ||
  { echo "refusing: .env.local is not a local deployment" >&2; exit 1; }

failed=0
run() {
  local t0=$SECONDS out
  if out=$(npx convex run "$@" 2>&1); then
    printf '  ok    %3ss  %s\n' $((SECONDS - t0)) "$1"
  else
    printf '  FAIL  %3ss  %s\n' $((SECONDS - t0)) "$1"
    printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -n 3 | sed 's/^/          /'
    failed=$((failed + 1))
  fi
}

run seedData:seedAll
run onboarding:seedOnboarding
run standardsImport:importCommonCoreMath
run standardsImport:importCommonCoreELA
run standardsImport:importNGSS
run standardsImport:importUCLAHistoricalThinking
run knowledgeNodes:rebuild
run seed/stretchItems:seedStretchItems
run practiceSkills:seedDefaultManipulativePractice
run instruction:seedAuthoredInstruction
run knowledgeNodes:rebuildTree
run externalApps:seedPressReader
run seedRichCohort:seedAll
run seedBadgeArt:attach
run seedRoboticsMedia:attach
run seed/institutions:seedDevInstitutions
run seed/devPersonas:seedDevPersonas
run seed/physicalEnvironment:seedDevPhysicalEnvironment
run scholarApps:seedPressReaderForAllScholars
run practiceSkills:seedFadedWorkedExamples
# The public snapshot has no membership backfill; the kit's overlay adds one so
# the pretend teachers can see their pretend scholars.
run kitSeed:backfillMemberships
# Not run: practiceGen:prewarmConceptualItems needs an Anthropic key, and three
# private-only seed steps (Math Academy, school closures, the original
# membership backfill) aren't in the public snapshot.

[ "$failed" -eq 0 ] && echo "  seeded" || echo "  $failed seed step(s) failed; the app still works, minus that data"
