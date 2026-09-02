#!/usr/bin/env bash
# Scholar homework card — default seeded scholar → Scholar's Prep empty card.
# Contract: run_scenario only; helpers come from scenario-lib.sh.

run_scenario() {
  snap "home-before-homework-card"
  tap_name "Scholar’s Prep" || return 1
  wait_for "To do tonight" 30 || return 1
  snap "homework-tonight-card"

  local source
  source="$(find "$ARTIFACT_DIR" -name '*-homework-tonight-card.source.xml' -print | sort | tail -1)"
  [ -n "$source" ] && [ -f "$source" ] || {
    echo "✗ homework-tonight-card: source snapshot missing" >&2
    return 1
  }

  node - "$source" <<'NODE' || return 1
const fs = require("fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const heading = source.indexOf('name="To do tonight"');
const empty = source.indexOf('name="Nothing on your list yet. Add a note, or check the ideas below."');
const addNote = source.indexOf('name="Add a note"');

if (heading < 0 || empty < heading) {
  console.error("✗ homework-tonight-card: deterministic empty card missing");
  process.exit(1);
}
if (addNote < empty) {
  console.error("✗ homework-tonight-card: Add a note control missing below the empty state");
  process.exit(1);
}
NODE

  echo "✓ homework-tonight-card: default scholar sees the empty tonight card and Add a note control"
}
