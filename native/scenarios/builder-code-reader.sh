#!/usr/bin/env bash
# Builder Code view reader: opens an app session's Code view and captures the
# reader (AppCodeReader), a rule value's note, a fold opened, and the editor
# behind "Edit code", so a reviewer can see the iPad rendering of the tinted
# values, the "Runs from" lines, the folds and the code colors.
#
# Path, all fictional seed data: the signed-in scholar (test-scholar-001) has
# the "Race game" app activity on Home (convex/seed/codeReaderRace.ts), an app
# the builder wrote that publishes its rules in APP STATE and that the scholar
# may edit. Opening it lands on the app builder screen (VibecodeScreen) in Play,
# where the app runs and publishes its rules; Edit, then the top row's Code
# toggle, opens the reader. (The Python bench is Play-only, so it has no Code
# toggle.)
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

# _bcr_wait_contains <substring> [timeout_s]: poll until an element whose
# name, label or value CONTAINS <substring> exists.
_bcr_wait_contains() {
  local needle="$1" timeout="${2:-60}" lit count deadline
  lit="$(_ael_predicate_literal "$needle")"
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(ael_count_elements "$BASE" "-ios predicate string" \
      "name CONTAINS '$lit' OR label CONTAINS '$lit' OR value CONTAINS '$lit'" \
      2>/dev/null || printf '0')"
    [ "${count:-0}" -ge 1 ] && return 0
    dismiss_dev_menu_if_present
    sleep 0.3
  done
  echo "✗ builder-code-reader: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

# _bcr_first <predicate>: print the first element id matching an iOS predicate.
_bcr_first() {
  ael_find_elements "$BASE" "-ios predicate string" "$1" 2>/dev/null | head -n 1 | grep .
}

# _bcr_open_app: open the Race game session from Home, until the app shows.
_bcr_open_app() {
  local entry pred round
  if _bcr_wait_contains "Rabbithole is asleep" 3 2>/dev/null; then
    echo "✗ builder-code-reader: bedtime covers the scholar app (20:00-06:00 school time); re-run after 06:00" >&2
    snap "bedtime"
    return 1
  fi
  _bcr_wait_contains "Race game" 60 || {
    snap "app-missing"
    return 1
  }
  for ((round = 0; round < 4; round += 1)); do
    entry=""
    for pred in \
      "name BEGINSWITH 'Continue to Race game'" \
      "name BEGINSWITH 'Start Race game'" \
      "name CONTAINS 'Race game'"; do
      entry="$(_bcr_first "$pred")" && break
    done
    [ -n "$entry" ] || break
    ael_click "$BASE" "$entry" 2>/dev/null || true
    # The app's own Race! button, inside the WebView: the app has booted and
    # published its rules.
    _bcr_wait_contains "Race!" 30 2>/dev/null && return 0
  done
  echo "✗ builder-code-reader: never reached the app builder screen" >&2
  snap "app-not-opened"
  return 1
}

run_scenario() {
  local code edit fold
  _bcr_open_app || return 1
  sleep 2
  snap "builder-open"

  # The Code toggle shows only in Edit. Its accessibility name carries the
  # icon's name in front ("embed code, Code").
  local code_pred="name == 'Code' OR name ENDSWITH ', Code'"
  code="$(_bcr_first "$code_pred")" || {
    edit="$(_bcr_first "name == 'Edit'")" && ael_click "$BASE" "$edit" 2>/dev/null
    sleep 2
    code="$(_bcr_first "$code_pred")" || {
      echo "✗ builder-code-reader: no Code toggle in the builder's top row" >&2
      snap "no-code-toggle"
      return 1
    }
  }
  ael_click "$BASE" "$code" || return 1

  _bcr_wait_contains "Edit code" 20 || {
    echo "✗ builder-code-reader: the Code view opened without the reader" >&2
    snap "no-reader"
    return 1
  }
  sleep 1
  snap "reader"

  # Tap a tinted rule value: its note says which rule it is. iOS folds a
  # tappable span inside a line of text into that line's accessibility
  # element, so the value may not be findable on its own; the reader shot
  # still shows whether values are tinted.
  local rule note="not captured (no separate element for a tinted value)"
  if rule="$(_bcr_first "name BEGINSWITH 'Rule: '")"; then
    ael_click "$BASE" "$rule" 2>/dev/null || true
    if _bcr_wait_contains "Change it on its card" 5 2>/dev/null; then
      note="captured"
      snap "rule-note"
    fi
  fi

  # Open the first fold (a gray line: "Page style and layout", then names).
  fold="$(_bcr_first "name BEGINSWITH 'Page style and layout'")" && {
    ael_click "$BASE" "$fold" 2>/dev/null || true
    sleep 1
    snap "fold-open"
  }

  edit="$(_bcr_first "name == 'Edit code'")" || {
    snap "no-edit-code"
    return 1
  }
  ael_click "$BASE" "$edit" || return 1
  _bcr_wait_contains "Back to reading" 10 || {
    echo "✗ builder-code-reader: Edit code did not open the editor" >&2
    snap "no-editor"
    return 1
  }
  sleep 1
  snap "editor"

  echo "✓ builder-code-reader: reader, an opened fold, and the editor behind Edit code (rule note: $note)"
  echo "· read reader: rule values tinted, folds are gray lines with line counts, open parts show 'Runs from' lines"
}
