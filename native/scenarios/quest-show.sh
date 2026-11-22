#!/usr/bin/env bash
# Showing a Quest on the BunnyPad (TRA-684, moved to the header in TRA-720):
# an approved Quest's maker screen has "I'm ready to show" in the header's
# action pill and no other hand-in ("Send to teacher", "Finish and send"). The
# pill opens a sheet ("How does it work?"); Send marks it, and the pill then
# shows a checkmark and "Ready to show"; tapping it reopens the sheet on the
# words with when they were sent ("Ready to show ·"), and Update replaces
# them. The Quests tab row then adds "Ready to show" to its meta line. Each
# "no other hand-in" check waits for the thing that used to carry it (the
# built app, the Python bench), and a failed screen query fails the step.
#
# Run against a private worktree deployment whose signed-in fictional scholar
# (test-scholar-001) has two approved Quests, neither started nor shown, in the
# school's daytime: an app Quest approved last (so it lists first) and a Python
# Quest. (quest-shown.sh is the second half: after a teacher awards the badge.)
#
# The screenshots are the evidence: read them rather than trusting the pass
# line. Contract: run_scenario only; no top-level side effects; no EXIT traps.

_qs_wait_contains() {
  # $3 = "cs" for a case-sensitive match ("Ready to show", not "I'm ready to show").
  local needle="$1" timeout="${2:-60}" op="CONTAINS[c]" lit count deadline
  [ "${3:-}" = "cs" ] && op="CONTAINS"
  lit="$(_ael_predicate_literal "$needle")"
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(ael_count_elements "$BASE" "-ios predicate string" \
      "name $op '$lit' OR label $op '$lit' OR value $op '$lit'" \
      2>/dev/null || printf '0')"
    [ "${count:-0}" -ge 1 ] && return 0
    dismiss_dev_menu_if_present
    sleep 1
  done
  echo "✗ quest-show: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

_qs_tap_first() {
  local lit id deadline
  lit="$(_ael_predicate_literal "$1")"
  deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND name CONTAINS '$lit'" 2>/dev/null | head -n 1 | grep .)" && {
      ael_click "$BASE" "$id"
      return
    }
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  echo "✗ quest-show: no visible '$1'" >&2
  snap "missing-tap-target"
  return 1
}

# A Quest's session offers no other hand-in.
_qs_none() {
  local lit count tries=0
  lit="$(_ael_predicate_literal "$1")"
  # A failed query is not a zero: retry briefly, then fail the step.
  until count="$(ael_count_elements "$BASE" "-ios predicate string" \
    "visible == 1 AND (name CONTAINS '$lit' OR label CONTAINS '$lit')" 2>/dev/null)"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 3 ]; then
      echo "✗ quest-show: couldn't ask the screen whether it shows '$1'" >&2
      snap "query-failed"
      return 1
    fi
    sleep 1
  done
  [ "$count" -eq 0 ] && return 0
  echo "✗ quest-show: a Quest's session shows '$1'" >&2
  snap "unexpected-hand-in"
  return 1
}

# The sheet's text box, for typing into.
_qs_sheet_box() {
  ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND (type == 'XCUIElementTypeTextView' OR type == 'XCUIElementTypeTextField')" 2>/dev/null | head -n 1 | grep .
}

run_scenario() {
  snap "home"
  _qs_tap_first "Quests" || return 1
  _qs_wait_contains "Advisor:" 60 || { snap "no-advisor-row"; return 1; }
  snap "quests-before"

  # The app Quest (listed first): the pill in the builder's header.
  _qs_tap_first "Start building" || return 1
  _qs_wait_contains "ready to show" 90 || { snap "no-ready-pill"; return 1; }
  sleep 2
  snap "app-header-pill"
  # Send to teacher only ever showed once there was an app, so the app must
  # be built (Present appears with it) before its absence means anything.
  _qs_wait_contains "Present" 300 || { snap "app-not-built"; return 1; }
  sleep 2
  snap "app-built-header"
  _qs_none "Send to teacher" || return 1

  _qs_tap_first "ready to show" || return 1
  _qs_wait_contains "How does it work?" 20 || { snap "no-sheet"; return 1; }
  local box
  box="$(_qs_sheet_box)" || { snap "no-sheet-input"; return 1; }
  ael_click "$BASE" "$box" || return 1
  ael_set_value "$BASE" "$box" "You type an angle and the croc opens its jaws that much. 180 opens them flat, because a straight line is 180 degrees." || return 1
  sleep 1
  snap "sheet-with-words"

  _qs_tap_first "Send" || return 1
  _qs_wait_contains "Ready to show" 20 cs || { snap "no-marked-pill"; return 1; }
  sleep 1
  snap "app-marked-pill"

  # The marked pill reopens the sheet on the words they sent, with when.
  _qs_tap_first "Ready to show" || return 1
  _qs_wait_contains "Ready to show ·" 20 cs || { snap "no-sent-time"; return 1; }
  _qs_wait_contains "the croc opens its jaws" 10 || { snap "no-sent-words"; return 1; }
  _qs_wait_contains "Update" 10 cs || { snap "no-update"; return 1; }
  sleep 1
  snap "sheet-reopened-with-time"

  # Update the words, then reopen: the new ones are what it holds.
  box="$(_qs_sheet_box)" || { snap "no-sheet-input-on-edit"; return 1; }
  ael_click "$BASE" "$box" || return 1
  ael_clear "$BASE" "$box" || return 1
  ael_set_value "$BASE" "$box" "The angle you type opens the jaws. 90 makes a square corner, and 180 lies flat." || return 1
  sleep 1
  _qs_tap_first "Update" || return 1
  sleep 2
  _qs_tap_first "Ready to show" || return 1
  _qs_wait_contains "90 makes a square corner" 20 || { snap "no-updated-words"; return 1; }
  sleep 1
  snap "sheet-reopened-after-update"
  _qs_tap_first "Cancel" || return 1
  sleep 1

  nav "/" || return 1
  sleep 2
  _qs_tap_first "Quests" || return 1
  _qs_wait_contains "Ready to show" 30 cs || { snap "no-ready-row"; return 1; }
  sleep 2
  snap "quests-ready-row"

  # The Python Quest: the same pill on the chat with its bench, and no
  # Finish and send under the bench.
  _qs_tap_first "Start building" || return 1
  _qs_wait_contains "ready to show" 90 || { snap "no-python-pill"; return 1; }
  # Finish and send sat under the bench, so the bench must be there first.
  _qs_wait_contains "Python bench" 60 cs || { snap "no-python-bench"; return 1; }
  sleep 3
  snap "python-header-pill"
  _qs_none "Finish and send" || return 1
  _qs_none "Send to teacher" || return 1

  echo "✓ quest-show: the header pill, its sheet, Send and the edit worked, the Quests row says Ready to show, and neither Quest offered another hand-in"
}
