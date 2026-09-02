#!/usr/bin/env bash
# Exercise both radical affordances against the deterministic root template
# family. A dedicated square-root key starts in its radicand; the indexed-root
# key has a real index box whose blank value deliberately means square root.
#
# `9√[7]9` is deliberately a typed but non-canonical radical, so feedback
# reliably reaches the miss state without exposing or deriving the server-side
# answer.

run_scenario() {
  nav "/practice?skill=roots_simplify_radicals" || return 1
  wait_for "Answer builder" 60 || return 1
  wait_for "insert a square root" 30 || return 1
  wait_for "insert a root with an index" 30 || return 1
  snap "radical-editor-entry"

  # First prove the compact square-root control goes straight to a square-root
  # radicand, then clear its empty structure before exercising the indexed path.
  tap_name "insert a square root" || return 1
  wait_for "square-root radicand, empty answer box" 30 || return 1
  snap "square-root-editor"
  tap_name "key backspace" || return 1

  # The remote lane explicitly renders its touch keypad so Appium can drive the
  # same shared controller without faking a UIKit hardware-key event. Tap the
  # blank index and then its radicand: this proves blank-index square-root
  # semantics rather than quietly typing an index.
  tap_name "key 9" || return 1
  tap_name "insert a root with an index" || return 1
  tap_name "root index, blank means square root; enter an integer of 2 or greater, then select the radicand, empty answer box" || return 1
  tap_name "square-root radicand, empty answer box" || return 1
  tap_name "key 9" || return 1
  snap "blank-index-root-filled"
  tap_name "root index, blank means square root; enter an integer of 2 or greater, then select the radicand, empty answer box" || return 1
  tap_name "key 7" || return 1
  wait_for "7th-root radicand, answer box 9" 30 || return 1
  snap "seventh-root-filled"
  tap_name "Check answer" || return 1
  # This scenario proves the read-only miss state itself. A breaker is a distinct
  # state and must never substitute for this capture: if prior test data has
  # accumulated enough misses, fail loudly so the run can be reset/retried from
  # a fresh seeded scholar rather than reporting the wrong evidence.
  wait_for "Not quite" 45 || return 1
  snap "radical-feedback"
}
