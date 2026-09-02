#!/usr/bin/env bash
# Scholar "Coming up" lookahead — the remote-iOS proof that Move 3's read-only
# forecast renders on the native Scholar's Prep tab. Modeled on
# authenticated-home.sh (readiness gate) + nav-smoke.sh (scenario-lib contract).
#
# The harness prologue drives the app to the authenticated-home readiness gate
# before calling run_scenario, so this starts on Home. It switches to the
# Scholar's Prep tab and asserts the "Coming up" section is present. The section
# always renders (a populated horizon shows day-grouped rows; an empty one shows
# the quiet "Nothing coming up this week" line — never null), so this passes from
# the seeded state regardless of which scholar the smoke lane signs in as.
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

run_scenario() {
  snap "home-before-prep"

  # Target the tab by its EXACT accessibility name (curly apostrophe U+2019).
  # tap_contains "Prep" would be ambiguous during the prep window, where the
  # Now screen also mounts an "Open Scholar’s Prep" entry card — two matches is
  # a hard failure. tap_name requires this one exact name.
  tap_name "Scholar’s Prep" || return 1

  # The Coming up card header renders on the Prep tab whether or not the horizon
  # has work, so this is a stable readiness signal for the section.
  wait_for "Coming up" 60 || return 1
  snap "coming-up"

  echo "✓ homework-coming-up: Coming up lookahead rendered on the native Prep tab"
}
