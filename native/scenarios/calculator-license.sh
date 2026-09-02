#!/usr/bin/env bash
# Verify the scholar-facing Calculator License credential on the seeded remote
# smoke account after its fictional dev record has been prepared.

run_scenario() {
  tap_name "Math" || return 1
  wait_for "Kai Nakamura's Calculator License. Active. Score 26 out of 28." 60 || return 1
  snap "calculator-license"
  echo "✓ calculator-license: active credential rendered on native"
}
