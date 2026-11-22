#!/usr/bin/env bash
# Proposing a Quest on the BunnyPad (TRA-695): the Quests tab's "Propose a
# Quest" button opens a chat, the kid says what they want to make, the tutor
# offers its proposal card, Propose sends it to Messages, and the Quests tab
# then shows the waiting proposal ("Waiting for a teacher"). Run against a
# private worktree deployment (real tutor reply, so it takes a minute or two)
# whose signed-in fictional scholar (test-scholar-001) has no proposals yet,
# in the school's daytime.
#
# The screenshots are the evidence: read them rather than trusting the pass
# line. Contract: run_scenario only; no top-level side effects; no EXIT traps.

_qp_wait_contains() {
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
  echo "✗ quest-propose: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

_qp_first_visible() {
  ael_find_elements "$BASE" "-ios predicate string" "visible == 1 AND ($1)" 2>/dev/null |
    head -n 1 | grep .
}

_qp_tap_visible() {
  local lit id deadline
  lit="$(_ael_predicate_literal "$1")"
  deadline=$((SECONDS + ${2:-30}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$(_qp_first_visible "name == '$lit'")" && {
      ael_click "$BASE" "$id"
      return
    }
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  echo "✗ quest-propose: no visible '$1'" >&2
  snap "missing-tap-target"
  return 1
}

run_scenario() {
  snap "home"
  _qp_tap_visible "Quests" || return 1
  sleep 3
  snap "quests-tab-propose-button"

  _qp_tap_visible "Propose a Quest" || return 1
  _qp_wait_contains "I want to propose a Quest." 60 || { snap "chat-missing"; return 1; }
  # The tutor's reply streams in; give it time to ask what they want to make.
  sleep 30
  snap "chat-tutor-asks"

  local box
  box="$(_qp_first_visible "type == 'XCUIElementTypeTextView' OR type == 'XCUIElementTypeTextField'")" || {
    snap "no-composer"
    return 1
  }
  ael_click "$BASE" "$box" || return 1
  ael_set_value "$BASE" "$box" "I want to make an app that helps me design my own board game, with cards and a score tracker. I would like to propose it as an app." || return 1
  sleep 1
  _qp_tap_visible "Send message" || return 1

  # The tutor offers the card once it knows what they want to make.
  _qp_wait_contains "Your proposal" 150 || { snap "no-card"; return 1; }
  sleep 3
  snap "proposal-card"

  _qp_tap_visible "Propose" || return 1
  sleep 6
  snap "after-propose-messages-thread"

  nav "/" || return 1
  sleep 2
  _qp_tap_visible "Quests" || return 1
  _qp_wait_contains "Waiting for a teacher" 30 || { snap "no-waiting-row"; return 1; }
  sleep 2
  snap "quests-waiting-row"

  echo "✓ quest-propose: Propose a Quest opened a chat, the card proposed, the Quests tab shows the waiting row"
}
