#!/usr/bin/env bash
# Python bench smoke: proves the bench runs real Python (Pyodide) inside the
# native app's CodeArtifactWebView on a real simulator, and records how much
# memory the WebKit content process holds while it does.
#
# Five checks, all with fictional programs:
#   1. A SyntaxError reaches the output pane (Pyodide loaded and parsed code).
#   2. Stepping changes a variable in the variables table.
#   3. matplotlib draws a plot (the heaviest package load the bench makes).
#   4. A `while True` loop can be stopped, and the bench runs code afterwards.
#   5. The WebKit content process's memory footprint, and four latencies
#      (cold start to ready, warm reopen to ready, Run to first output, Step
#      to paint), are printed in the log and also appended to the last snap's .names.txt. That file is linked
#      from the ios-smoke PR comment, which only quotes failure lines.
#
# The simulator shows neither iPad speed nor iOS memory-kill behaviour. The
# footprint is a number a person reads against the A16's headroom, not a
# pass/fail line.
#
# What the scenario assumes of the bench (lane 2's app). These are its only
# observations, through the accessibility tree WKWebView exposes:
#   * The bench is reachable from the scholar's home: its row (name contains
#     "Python bench") leads to the unit page, whose "Continue to Python bench"
#     opens the session. Autologin signs in as
#     EXPO_PUBLIC_DEV_SCHOLAR, which defaults to test-scholar-001.
#
# Bedtime (shared/bedtime.ts) covers the scholar app 20:00-06:00 in the
# primary school's time zone, so a run at night stops at "Rabbithole is
# asleep". The scenario reports that by name rather than timing out.
#   * The editor is a textarea labelled "Python code".
#   * Buttons are named "Run", "Stop", "Step", "Edit code" and, once a
#     recording exists, "First step" and "Forward one step".
#   * The status chip reads "Python ready" once the runtime can run code, and
#     again after Stop restarts it.
#   * The output pane shows Python's own error text ("SyntaxError").
#   * A variable that changed at the current step shows "was <old value>".
#   * A plot is an <img> whose alt is the figure title, "Plot" when untitled.
# If one of these drifts, the failing step's snap has the full a11y dump
# (NN-<name>.source.xml) to fix the locator from.
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

# _pybench_wait_contains <substring> [timeout_s]: poll until an element whose
# name, label or value CONTAINS <substring> exists. scenario-lib's wait_for is
# exact-match on accessibility id, and web content inside WKWebView often
# reports its text as a value rather than a name.
_pybench_wait_contains() {
  local needle="$1" timeout="${2:-60}" lit count deadline
  lit="$(_ael_predicate_literal "$needle")"
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    count="$(ael_count_elements "$BASE" "-ios predicate string" \
      "name CONTAINS '$lit' OR label CONTAINS '$lit' OR value CONTAINS '$lit'" \
      2>/dev/null || printf '0')"
    [ "${count:-0}" -ge 1 ] && return 0
    dismiss_dev_menu_if_present
    sleep 0.2
  done
  echo "✗ python-bench: timed out after ${timeout}s waiting for text '$needle'" >&2
  return 1
}

# _pybench_ms: wall-clock milliseconds on the Mac host.
_pybench_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

# _pybench_latency <label> <start_ms>: record one timing. Appium round trips
# (~100-500 ms each) and the 0.2 s poll make these coarse upper bounds, and
# the simulator runs on the Mac's CPU, not an A16.
_pybench_latency() {
  local label="$1" start="$2" end
  end="$(_pybench_ms)"
  PYBENCH_REPORT="${PYBENCH_REPORT}· latency: ${label}_ms=$((end - start)) (simulator, Mac CPU; coarse upper bound)"$'\n'
  echo "· latency: ${label}_ms=$((end - start)) (simulator, Mac CPU; coarse upper bound)"
}

# _pybench_open: open the bench from Home. On native, Home's row leads to the
# unit's "Where you are" page, whose "Continue to Python bench" opens the
# session; on other paths a "Start" link or the row itself does. Each round
# re-reads the tree (element ids go stale on navigation) and taps the most
# specific entry it finds, until the bench's editor shows.
_pybench_first_match() {
  local pred
  for pred in \
    "name BEGINSWITH 'Continue to Python bench'" \
    "name == 'Start' OR name == 'Continue'" \
    "name CONTAINS 'Python bench'"; do
    ael_find_elements "$BASE" "-ios predicate string" "$pred" 2>/dev/null | head -n 1 | grep . && return 0
  done
  return 1
}

_pybench_open() {
  local entry round
  if _pybench_wait_contains "Rabbithole is asleep" 3 2>/dev/null; then
    echo "✗ python-bench: bedtime covers the scholar app (20:00-06:00 school time); re-run after 06:00" >&2
    snap "bedtime"
    return 1
  fi
  _pybench_wait_contains "Python bench" 60 || {
    echo "✗ python-bench: no Python bench on the signed-in scholar's home" >&2
    snap "bench-missing"
    return 1
  }
  for ((round = 0; round < 4; round += 1)); do
    entry="$(_pybench_first_match)" || break
    ael_click "$BASE" "$entry" 2>/dev/null || true
    _pybench_wait_contains "Python code" 30 2>/dev/null && return 0
  done
  echo "✗ python-bench: tapping the bench on Home never opened its editor" >&2
  snap "bench-not-opened"
  return 1
}

# _pybench_tap <name>: tap the bench button with this exact accessibility id.
# A web <button> can appear twice in the tree (the button and its text), so
# take the first hittable match instead of requiring exactly one.
_pybench_tap() {
  local name="$1" id deadline
  # A lookup right after a run can miss a button that is on screen (seen once
  # on a local simulator), so retry briefly before calling it absent.
  deadline=$((SECONDS + 5))
  while :; do
    id="$(ael_find_elements "$BASE" "-ios predicate string" \
      "name == '$(_ael_predicate_literal "$name")' AND type == 'XCUIElementTypeButton'" \
      2>/dev/null | head -n 1)"
    [ -n "$id" ] && ael_click "$BASE" "$id" && return 0
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 0.5
  done
  echo "✗ python-bench: no '$name' button in the bench" >&2
  return 1
}

# _pybench_load_program <python source>: replace the editor's contents.
_pybench_load_program() {
  local source="$1" id value first_line i
  id="$(ael_find_elements "$BASE" "accessibility id" "Python code" 2>/dev/null | head -n 1)"
  if [ -z "$id" ]; then
    echo "✗ python-bench: no editor labelled 'Python code'" >&2
    return 1
  fi
  ael_click "$BASE" "$id" 2>/dev/null || true
  # One clear empties only the first line of a multi-line WKWebView textarea,
  # and the bench restores a scholar's saved code, so clear until it is empty.
  for ((i = 0; i < 40; i += 1)); do
    value="$(ael_attribute "$BASE" "$id" value 2>/dev/null || true)"
    [ -z "$value" ] || [ "$value" = "Python code" ] && break
    ael_clear "$BASE" "$id" 2>/dev/null || true
  done
  if [ -n "$value" ] && [ "$value" != "Python code" ]; then
    echo "✗ python-bench: the editor still holds text after 40 clears" >&2
    return 1
  fi
  ael_set_value "$BASE" "$id" "$source" || {
    echo "✗ python-bench: could not type into the editor" >&2
    return 1
  }
  ael_hide_keyboard "$BASE" 2>/dev/null || true
  # Prove the program landed whole: its first line is there and nothing ran
  # ahead of it (a leftover line above would shift every line number).
  first_line="${source%%$'\n'*}"
  value="$(ael_attribute "$BASE" "$id" value 2>/dev/null || true)"
  # (An empty read means this WebKit build doesn't expose the value; trust it.)
  case "$value" in
    "" | "$first_line"*) ;;
    *)
      echo "✗ python-bench: the editor does not start with the typed program" >&2
      return 1
      ;;
  esac
}

# _pybench_footprint: print the memory of every WebKit content process that
# belongs to THIS simulator ($UDID). Simulator processes are ordinary macOS
# processes under that device's launchd_sim, so we walk its descendants on the
# host. `footprint` (the same phys_footprint number jetsam judges) is preferred;
# RSS from ps is the fallback when footprint is missing or refuses.
_pybench_footprint() {
  local launchd pids pid rss_kb fp line queue next p
  launchd="$(pgrep -f "launchd_sim.*$UDID" 2>/dev/null | head -n 1 || true)"
  if [ -z "$launchd" ]; then
    echo "· webcontent-footprint: no launchd_sim found for $UDID; cannot measure"
    return 0
  fi
  pids=""
  queue="$launchd"
  while [ -n "$queue" ]; do
    next=""
    for p in $queue; do
      for pid in $(pgrep -P "$p" 2>/dev/null); do
        next="$next $pid"
        if ps -o comm= -p "$pid" 2>/dev/null | grep -q 'com.apple.WebKit.WebContent'; then
          pids="$pids $pid"
        fi
      done
    done
    queue="$next"
  done
  if [ -z "$pids" ]; then
    echo "· webcontent-footprint: no com.apple.WebKit.WebContent process under $UDID"
    return 0
  fi
  for pid in $pids; do
    rss_kb="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    fp=""
    if command -v footprint >/dev/null 2>&1; then
      fp="$(footprint -p "$pid" 2>/dev/null \
        | grep -E -m1 '[Ff]ootprint' | sed -E 's/^[[:space:]]+//' || true)"
    fi
    line="· webcontent-footprint: pid=$pid rss_kb=${rss_kb:-?}"
    [ -n "$fp" ] && line="$line footprint=\"$fp\""
    echo "$line"
  done
}

run_scenario() {
  # Pyodide's first load fetches the runtime (~10 MB) and, for the plot,
  # matplotlib and numpy over the preview's network: generous, bounded waits.
  # The status chip says "Python ready" once the runtime can run code.
  local PYBENCH_LOAD_TIMEOUT=180 PYBENCH_REPORT="" t0 t1

  # --- cold start to Python ready ---------------------------------------------
  nav "/" || return 1
  t0="$(_pybench_ms)"
  _pybench_open || return 1
  t1="$(_pybench_ms)"
  _pybench_wait_contains "Python ready" "$PYBENCH_LOAD_TIMEOUT" || {
    echo "✗ python-bench: the bench never reported Python ready" >&2
    snap "bench-not-ready"
    return 1
  }
  # Two numbers: the whole Home → unit page → session walk (mostly navigation
  # and Appium round trips), and the bench's own boot from its editor showing.
  _pybench_latency "cold_home_to_ready" "$t0"
  _pybench_latency "cold_editor_to_ready" "$t1"
  snap "bench-open"

  # --- warm reopen to ready -----------------------------------------------
  nav "/" || return 1
  t0="$(_pybench_ms)"
  _pybench_open || return 1
  t1="$(_pybench_ms)"
  _pybench_wait_contains "Python ready" "$PYBENCH_LOAD_TIMEOUT" || {
    echo "✗ python-bench: the bench never reported Python ready on reopen" >&2
    snap "bench-reopen-not-ready"
    return 1
  }
  _pybench_latency "warm_home_to_ready" "$t0"
  _pybench_latency "warm_editor_to_ready" "$t1"

  # --- Run to first output ------------------------------------------------
  _pybench_load_program 'print("bench", 1 + 1)' || return 1
  t0="$(_pybench_ms)"
  _pybench_tap "Run" || return 1
  _pybench_wait_contains "bench 2" 60 || { snap "run-no-output"; return 1; }
  _pybench_latency "run_to_first_output" "$t0"

  # --- 1. SyntaxError -----------------------------------------------------
  _pybench_load_program 'print("hello, bench"' || return 1
  _pybench_tap "Run" || return 1
  _pybench_wait_contains "SyntaxError" "$PYBENCH_LOAD_TIMEOUT" || {
    snap "syntax-error-missing"
    return 1
  }
  snap "syntax-error"

  # --- 2. Step to a variable change ---------------------------------------
  # Three assignments; after two steps `apples` has changed from 3 to 5.
  # "Step" records the run; "Forward one step" walks the recording.
  # The step where apples goes 3 -> 5 marks the row "was 3", so step forward
  # until that text appears, timing the step that painted it.
  local tries found=0
  _pybench_load_program $'apples = 3\napples = apples + 2\npears = apples * 2' || return 1
  _pybench_tap "Step" || return 1
  _pybench_wait_contains "Recorded" 60 || { snap "step-no-recording"; return 1; }
  _pybench_tap "First step" || { snap "step-no-first"; return 1; }
  for ((tries = 0; tries < 6; tries += 1)); do
    t0="$(_pybench_ms)"
    _pybench_tap "Forward one step" || { snap "step-no-forward"; return 1; }
    if _pybench_wait_contains "was 3" 3 2>/dev/null; then found=1; break; fi
  done
  [ "$found" = 1 ] || {
    echo "✗ python-bench: stepping never showed apples changing from 3" >&2
    snap "step-no-change"
    return 1
  }
  _pybench_latency "step_to_paint" "$t0"
  snap "step-variable-changed"
  _pybench_tap "Edit code" || return 1

  # --- 3. matplotlib plot -------------------------------------------------
  _pybench_load_program $'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3, 4], [1, 4, 9, 16])\nplt.show()' || return 1
  _pybench_tap "Run" || return 1
  _pybench_wait_contains "Plot" "$PYBENCH_LOAD_TIMEOUT" || { snap "plot-missing"; return 1; }
  sleep 2 # let the image paint; no paint signal is observable from here
  snap "plot"
  # The high-water mark: matplotlib and numpy are loaded in the worker now.
  # Stop (next) ends that worker, so measure before it.
  local plot_footprint
  plot_footprint="$(_pybench_footprint | sed 's/webcontent-footprint:/webcontent-footprint (after plot):/')"
  printf '%s\n' "$plot_footprint"

  # --- 4. while True, then recover ----------------------------------------
  _pybench_load_program 'while True: pass' || return 1
  _pybench_tap "Run" || return 1
  sleep 5 # the loop must be genuinely running before Stop means anything
  snap "loop-running"
  _pybench_tap "Stop" || return 1
  # Stop kills the worker and restarts Python; Run is disabled until it is back.
  _pybench_wait_contains "Python ready" "$PYBENCH_LOAD_TIMEOUT" || {
    echo "✗ python-bench: Python did not come back after Stop" >&2
    snap "loop-no-restart"
    return 1
  }
  _pybench_load_program 'print("recovered", 6 * 7)' || return 1
  _pybench_tap "Run" || return 1
  _pybench_wait_contains "recovered 42" "$PYBENCH_LOAD_TIMEOUT" || {
    echo "✗ python-bench: the bench did not run code after stopping a while True loop" >&2
    snap "loop-not-recovered"
    return 1
  }

  # --- 5. memory footprint ------------------------------------------------
  # The plotting high-water mark was taken in section 3, before Stop ended
  # that worker. This second sample is the fresh interpreter after recovery.
  local footprint names
  footprint="$(_pybench_footprint | sed 's/webcontent-footprint:/webcontent-footprint (after Stop and recovery):/')"
  printf '%s\n' "$footprint"
  snap "loop-recovered"
  # snap is best-effort: with no names file, skip the report rather than fail.
  names="$(ls -1 "$ARTIFACT_DIR"/*-loop-recovered.names.txt 2>/dev/null | tail -n 1 || true)"
  if [ -n "$names" ]; then
    { printf '\n# latency + webcontent footprint (not a11y names; appended by python-bench-smoke)\n'
      printf '%s%s\n%s\n' "$PYBENCH_REPORT" "$plot_footprint" "$footprint"; } >> "$names"
  fi

  echo "✓ python-bench-smoke: SyntaxError, step, plot, and loop recovery proven on the remote sim"
  echo "· read the footprint lines above against the A16's memory headroom;"
  echo "  the simulator does not reproduce iOS memory kills."
}
