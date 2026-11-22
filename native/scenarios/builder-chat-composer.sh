#!/usr/bin/env bash
# Builder chat composer: opens an app session's chat sheet with the composer
# focused, so a reviewer can see whether the composer's right-hand button
# (mic when empty, Send once there is text) clears iPadOS's minimized-keyboard
# pill. With a hardware keyboard connected (the fleet posture, which the lane
# applies), iPadOS floats that small glass "A" pill in the bottom-right screen
# corner whenever a text field is focused.
#
# Path, all fictional seed data: the signed-in scholar (test-scholar-001) has
# the Python bench app activity on Home (convex/seed/pythonBench.ts). Opening it
# lands on the app builder screen (VibecodeScreen); its header's "Chat" button
# opens the bottom chat sheet whose composer this scenario focuses.
#
# The screenshots are the evidence: composer-focused shows the mic button
# beside the pill, composer-typed shows the Send button beside it. Whether the
# simulator draws the pill exactly as a device does is not guaranteed, so read
# the shots rather than trusting a pass line.
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

# _bcc_wait_contains <substring> [timeout_s]: poll until an element whose
# name, label or value CONTAINS <substring> exists (wait_for is exact-match,
# and WebView text often surfaces as a value).
_bcc_wait_contains() {
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
  echo "✗ builder-chat-composer: timed out after ${timeout}s waiting for '$needle'" >&2
  return 1
}

# _bcc_first <predicate>: print the first element id matching an iOS predicate.
_bcc_first() {
  ael_find_elements "$BASE" "-ios predicate string" "$1" 2>/dev/null | head -n 1 | grep .
}

# _bcc_open_app: open the Python bench session from Home (the same entry
# points python-bench-smoke.sh uses), until the app's editor shows.
_bcc_open_app() {
  local entry pred round
  if _bcc_wait_contains "Rabbithole is asleep" 3 2>/dev/null; then
    echo "✗ builder-chat-composer: bedtime covers the scholar app (20:00-06:00 school time); re-run after 06:00" >&2
    snap "bedtime"
    return 1
  fi
  _bcc_wait_contains "Python bench" 60 || {
    snap "app-missing"
    return 1
  }
  for ((round = 0; round < 4; round += 1)); do
    entry=""
    for pred in \
      "name BEGINSWITH 'Continue to Python bench'" \
      "name == 'Start' OR name == 'Continue'" \
      "name CONTAINS 'Python bench'"; do
      entry="$(_bcc_first "$pred")" && break
    done
    [ -n "$entry" ] || break
    ael_click "$BASE" "$entry" 2>/dev/null || true
    _bcc_wait_contains "Python code" 30 2>/dev/null && return 0
  done
  echo "✗ builder-chat-composer: never reached the app builder screen" >&2
  snap "app-not-opened"
  return 1
}

run_scenario() {
  local chat composer i
  _bcc_open_app || return 1
  sleep 2
  snap "builder-open"

  chat="$(_bcc_first "name == 'Chat' AND type == 'XCUIElementTypeButton'")" ||
    chat="$(_bcc_first "name == 'Chat'")" || {
      echo "✗ builder-chat-composer: no Chat button in the builder header" >&2
      snap "no-chat-button"
      return 1
    }
  ael_click "$BASE" "$chat" || return 1

  # The composer's placeholder names who answers: the tutor in Play, the
  # designer in Edit. Either is the composer. An empty RN multiline field
  # carries its placeholder in its accessibility label (name/label), not in
  # placeholderValue, so match all four.
  local ph="name CONTAINS 'Talk to the tutor' OR label CONTAINS 'Talk to the tutor' OR placeholderValue CONTAINS 'Talk to the tutor' OR value CONTAINS 'Talk to the tutor' OR name CONTAINS 'Tell the designer' OR label CONTAINS 'Tell the designer' OR placeholderValue CONTAINS 'Tell the designer' OR value CONTAINS 'Tell the designer'"
  composer=""
  for ((i = 0; i < 20; i += 1)); do
    composer="$(_bcc_first "(type == 'XCUIElementTypeTextView' OR type == 'XCUIElementTypeTextField') AND ($ph)")" && break
    sleep 0.5
  done
  [ -n "$composer" ] || {
    echo "✗ builder-chat-composer: the chat sheet opened without a findable composer" >&2
    snap "no-composer"
    return 1
  }
  sleep 1
  snap "chat-open"

  # Focus the composer: with the hardware keyboard connected this is what
  # summons the bottom-right keyboard pill. Empty composer → mic button.
  ael_click "$BASE" "$composer" || return 1
  sleep 2
  snap "composer-focused"

  # Some text swaps the mic for the Send button. Never sent. Wait for both
  # the text and the Send button, so a failed type can't pass as this shot.
  ael_set_value "$BASE" "$composer" "Make the plot purple" || {
    echo "✗ builder-chat-composer: typing into the composer failed" >&2
    snap "type-failed"
    return 1
  }
  { _bcc_wait_contains "Make the plot purple" 10 && wait_for "Send" 10; } || {
    echo "✗ builder-chat-composer: the typed text or the Send button never showed" >&2
    snap "send-missing"
    return 1
  }
  snap "composer-typed"

  echo "✓ builder-chat-composer: chat sheet open with the composer focused"
  echo "· read composer-focused (mic) and composer-typed (Send): the button must sit"
  echo "  fully clear of the keyboard pill in the bottom-right corner"
}
