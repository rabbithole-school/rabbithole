#!/usr/bin/env bash
# My Learning's "Your sky" card on the BunnyPad (TRA-710). Run against a
# private worktree deployment whose signed-in fictional scholar
# (test-scholar-001) has a map unlocked (the card's gate) and a few wonders
# on their sky, outside the 8 pm-6 am bedtime window in the deployment
# school's time zone.
#
# It opens My Learning, finds the card by its whole accessible label (a
# button named exactly "Your sky", so an old title with a count can't pass),
# taps it, and waits for the sky's zoom buttons, which render only once the
# kid's stars have loaded and there is at least one. An Appium lookup that
# fails fails the walk; it is never read as "not there". The screenshots are
# the evidence: read them rather than trusting the pass line. Contract:
# run_scenario only; no top-level side effects; no EXIT traps (teardown
# belongs to the harness).

# _ms_count <predicate>: how many elements match an iOS predicate. Fails when
# the lookup itself fails.
_ms_count() {
  ael_count_elements "$BASE" "-ios predicate string" "$1" || {
    echo "✗ me-sky-card: element lookup failed for: $1" >&2
    return 1
  }
}

# _ms_wait <predicate> <what> [timeout_s]: poll until at least one element
# matches. 1 on timeout, 2 when a lookup fails.
_ms_wait() {
  local predicate="$1" what="$2" timeout="${3:-30}" count deadline
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(_ms_count "$predicate")" || return 2
    [ "$count" -ge 1 ] && return 0
    dismiss_dev_menu_if_present
    sleep 0.5
  done
  echo "✗ me-sky-card: timed out after ${timeout}s waiting for $what" >&2
  return 1
}

_ms_card="type == 'XCUIElementTypeButton' AND label == 'Your sky'"
_ms_zoom_in="type == 'XCUIElementTypeButton' AND label == 'Zoom in'"

run_scenario() {
  local asleep card_id
  asleep="$(_ms_count "label CONTAINS[c] 'Rabbithole is asleep'")" || return 1
  if [ "$asleep" -ge 1 ]; then
    echo "✗ me-sky-card: bedtime covers the scholar app; set the school's time zone to a daytime zone" >&2
    snap "bedtime"
    return 1
  fi

  nav "/me" || { snap "me-nav-failed"; return 1; }
  _ms_wait "$_ms_card" "the card labelled exactly 'Your sky'" 20 || {
    snap "no-sky-card"
    return 1
  }
  sleep 2
  snap "my-learning-card"

  # The card opens the kid's own sky. The zoom buttons appear only once
  # skyStars.forSelf has loaded with at least one star.
  card_id="$(ael_require_exactly_one "$BASE" "-ios predicate string" "$_ms_card")" || {
    snap "card-not-unique"
    return 1
  }
  ael_click "$BASE" "$card_id" || { snap "card-tap-failed"; return 1; }
  _ms_wait "$_ms_zoom_in" "the loaded sky's Zoom in button" 20 || {
    snap "sky-not-loaded"
    return 1
  }
  sleep 3
  snap "sky-opened"

  echo "✓ me-sky-card: My Learning's card is a button labelled Your sky, and it opens the kid's loaded sky"
}
