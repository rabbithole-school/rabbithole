#!/usr/bin/env bash
# Slides rehearsal (TRA-714) — Rehearse from the /dev-slides fixture deck:
# Start, Finish, and the review screen; then the harness's sample rehearsal,
# which needs no microphone. The back-of-the-room half (audience mode, the
# back-row video in the review) needs a second device and a camera, so it is
# checked by hand on two BunnyPads.
#
# The Present/Rehearse sheet is NOT driven here. Mini's Appium session runs
# with autoAcceptAlerts (scripts/remote-ios-smoke.sh), and WDA treats an
# ActionSheetIOS sheet as an alert and taps its first button, Present, before
# a scenario can choose Rehearse. So the scenario enters through /dev-slides'
# dev-only "Rehearse" button, which takes the same path past the sheet; the
# sheet itself is checked by hand on a BunnyPad. The same setting accepts the
# microphone prompt.
#
# What each shot is evidence OF:
#
#   * ready: Rehearse opens ready to record — "Ready to rehearse", Start and
#     Done, and below the notes how a friend can watch from the back.
#   * rehearsing: after Start, "Recording m:ss" and Finish in place of Start
#     and Done. No voice meter: the presenter's own mic is never judged.
#   * no-microphone (instead, on a Mac with no microphone, like Mini): Start
#     says "Recording couldn't start the microphone." and stays ready.
#   * review (or after-finish): Finish on a take of a few seconds. With no
#     BunnyPad at the back, the review shows the slide timeline and the
#     slide-by-slide times, and says nothing about loudness. If the simulator
#     couldn't record at all there is no take and the ready screen is back
#     instead; the scenario says which.
#   * sample-review: the newest of two made-up takes — slide preview, Play
#     (off: no audio), the slide strip, the slide-by-slide times, and the
#     comparison with the previous take's length.
#   * sample-take-1: the older take.
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

count_named() {
  ael_count_elements "$BASE" "accessibility id" "$1" 2>/dev/null || printf '0'
}

run_scenario() {
  nav "/dev-slides" || return 1
  wait_for "dev-slides-rehearse" || {
    echo "✗ the /dev-slides harness never showed its Rehearse button" >&2
    return 1
  }

  # A real rehearsal of a few seconds.
  tap_name "dev-slides-rehearse" || return 1
  wait_for "Start" || {
    echo "✗ rehearsing never showed Start" >&2
    snap "no-start"
    return 1
  }
  sleep 1
  snap "ready"
  tap_name "Start" || return 1
  # A Mac with no microphone (Mini) can't record: the take says so and stays
  # ready. Either outcome is right; a screen that shows neither is the bug.
  local j recording=0
  for ((j = 0; j < 30; j += 1)); do
    if [ "$(count_named "Finish")" -ge 1 ]; then
      recording=1
      break
    fi
    if [ "$(count_named "Recording couldn't start the microphone.")" -ge 1 ]; then
      break
    fi
    sleep 1
  done
  if [ "$recording" = 0 ]; then
    snap "no-microphone"
    if [ "$(count_named "Recording couldn't start the microphone.")" -lt 1 ]; then
      echo "✗ Start showed neither Finish nor the microphone notice" >&2
      return 1
    fi
    echo "· no microphone here: the take said so and stayed ready"
    tap_name "Done" || return 1
  else
    sleep 4
    snap "rehearsing"
    tap_name "Finish" || return 1
  fi

  local i reviewed=0
  for ((i = 0; i < 15 && recording == 1; i += 1)); do
    if [ "$(count_named "Rehearse again")" -ge 1 ]; then
      reviewed=1
      break
    fi
    if [ "$(count_named "Start")" -ge 1 ]; then
      break
    fi
    sleep 1
  done
  if [ "$reviewed" = 1 ]; then
    sleep 1
    snap "review"
    tap_name "Done" || return 1
    echo "• a real take was recorded and reviewed"
  elif [ "$recording" = 1 ]; then
    snap "after-finish"
    echo "· no take to review: the simulator couldn't record (see rehearsing)"
    tap_name "Done" || return 1
  fi

  # The sample rehearsal: the review screen without a microphone.
  wait_for "dev-slides-sample-rehearsal" || return 1
  tap_name "dev-slides-sample-rehearsal" || return 1
  wait_for "Rehearse again" || {
    echo "✗ the sample rehearsal never opened its review" >&2
    snap "no-sample"
    return 1
  }
  sleep 1
  snap "sample-review"

  tap_name "Take 1" || return 1
  sleep 1
  snap "sample-take-1"
  tap_name "Done" || return 1

  echo "✓ slides-rehearsal: Rehearse entry, Start, the recording screen, Finish, and the review"
  echo "· check ready for the back-of-the-room hint, and sample-review for the timeline and table"
}
