#!/usr/bin/env bash
# A teacher's offer on the BunnyPad (TRA-698): the Quests tab shows each offer
# as "Picked for you by <teacher>" with an outline "Start building". A row's ⋯
# button gives "Not now", which sets the offer aside (the row goes); holding a
# row does nothing.
# "Start building" starts the other offer and opens its maker session; back on
# the Quests tab that row now reads "Continue".
#
# Run against a private worktree deployment whose signed-in fictional scholar
# (test-scholar-001) has two offers from a teacher, "Clock game" (the newer,
# set aside) and "Tide talk" (started), in the school's daytime.
#
# The screenshots are the evidence: read them rather than trusting the pass
# line. Contract: run_scenario only; no top-level side effects; no EXIT traps.

_qo_wait_contains() {
  local needle="$1" timeout="${2:-60}" lit count deadline
  lit="$(_ael_predicate_literal "$needle")"
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(ael_count_elements "$BASE" "-ios predicate string" \
      "name CONTAINS[c] '$lit' OR label CONTAINS[c] '$lit' OR value CONTAINS[c] '$lit'" \
      2>/dev/null || printf '0')"
    [ "${count:-0}" -ge 1 ] && return 0
    dismiss_dev_menu_if_present
    sleep 1
  done
  echo "✗ quest-offered: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

_qo_tap_first() {
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
  echo "✗ quest-offered: no visible '$1'" >&2
  snap "missing-tap-target"
  return 1
}

# Press and hold the element whose name is exactly $1 (a row's title).
_qo_hold() {
  local lit id deadline
  lit="$(_ael_predicate_literal "$1")"
  deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND name == '$lit'" 2>/dev/null | head -n 1 | grep .)" && {
      curl -fsS --max-time 10 -X POST "$BASE/execute/sync" \
        -H 'Content-Type: application/json' \
        -d "{\"script\":\"mobile: touchAndHold\",\"args\":[{\"elementId\":\"$id\",\"duration\":1.5}]}" >/dev/null
      return
    }
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  echo "✗ quest-offered: nothing named '$1' to press and hold" >&2
  snap "missing-hold-target"
  return 1
}

run_scenario() {
  snap "home"
  _qo_tap_first "Quests" || return 1
  _qo_wait_contains "Picked for you by" 60 || { snap "no-offer-row"; return 1; }
  sleep 2
  snap "quests-offers"

  # Two offers share the title "Tide talk" (the first is set aside, the second
  # started). A hold on a row, even a long one, must never set an offer aside.
  _qo_hold "Tide talk" || return 1
  sleep 2
  snap "after-hold"
  [ "$(ael_count_elements "$BASE" "-ios predicate string" "name BEGINSWITH 'Start building: Tide talk'" 2>/dev/null)" = "2" ] ||
    { snap "hold-set-it-aside"; echo "✗ quest-offered: a hold set an offer aside" >&2; return 1; }

  # Not now: the row's ⋯ button opens a dialog and Appium's default accepts its
  # first button, Not now. One offer must go.
  _qo_tap_first "More for Tide talk" || return 1
  sleep 4
  snap "after-more"
  [ "$(ael_count_elements "$BASE" "-ios predicate string" "name BEGINSWITH 'Start building: Tide talk'" 2>/dev/null)" = "1" ] ||
    { echo "✗ quest-offered: Not now did not set the offer aside" >&2; return 1; }

  # Start building: Tide talk starts and opens its maker.
  _qo_tap_first "Start building: Tide talk" || return 1
  sleep 10
  snap "maker-session"

  # Back to the Quests tab: the started offer reads Continue.
  nav "/" || return 1
  _qo_tap_first "Quests" || return 1
  _qo_wait_contains "Continue: Tide talk" 30 || { snap "no-continue"; return 1; }
  sleep 2
  snap "quests-continue"

  echo "✓ quest-offered: offers read Picked for you, Not now sets one aside, Start building opens the maker and the row reads Continue"
}
