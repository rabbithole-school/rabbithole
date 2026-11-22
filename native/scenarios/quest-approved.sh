#!/usr/bin/env bash
# An approved Quest on the BunnyPad (TRA-695): after a teacher approves the
# scholar's proposal (quest-propose.sh, then an approval on the deployment),
# the Quests tab row reads "Advisor: <name>" with a "Start building" button
# that opens the Quest's maker session.
#
# The screenshots are the evidence. Contract: run_scenario only; no top-level
# side effects; no EXIT traps.

_qa_wait_contains() {
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
  echo "✗ quest-approved: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

_qa_tap_first() {
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
  echo "✗ quest-approved: no visible '$1'" >&2
  snap "missing-tap-target"
  return 1
}

run_scenario() {
  snap "home"
  _qa_tap_first "Quests" || return 1
  _qa_wait_contains "Advisor:" 60 || { snap "no-advisor-row"; return 1; }
  sleep 2
  snap "quests-approved-row"

  _qa_tap_first "Start building" || return 1
  sleep 10
  snap "maker-session"

  echo "✓ quest-approved: approved row shows the advisor and Start building opens the Quest"
}
