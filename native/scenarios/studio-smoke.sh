#!/usr/bin/env bash
# Studio smoke — proves the whole Studio stack stands up on a real simulator:
# expo-router route → native chrome driven by the SHARED ladder → the vendored
# single-file sandbox document booting inside the WebView → the level-select
# action round-tripping from native chrome into that document.
#
# What each step is evidence OF, since this lane's only observations are the
# accessibility tree and screenshots:
#
#   * The rail's chip titles ("Go", "Corner", …) are read from
#     shared/studioLevels.ts through native/vendor. Seeing them in the a11y
#     tree proves the vendor sync landed and native is reading the same
#     eleven-level ladder the sandbox is, not a stale copy.
#   * The screenshots are the only proof the sandbox's JS ran at all. A drawn
#     9x9 grid and a syntax-coloured editor cannot render unless the bundle
#     inside the document executed — the WebView would otherwise be blank.
#     Read them; do not assume.
#   * Tapping a chip dispatches the `setLevel` bridge action. If the editor
#     text changes between the two shots, the native → document direction of
#     the bridge is live.
#
# Contract: run_scenario only; no top-level side effects; no EXIT traps
# (teardown belongs to the harness). Helpers from scenario-lib.sh.

run_scenario() {
  nav "/studio" || return 1
  [ "$(where_am_i)" = "/studio" ] || {
    echo "✗ where_am_i disagrees with nav's ok verdict" >&2
    return 1
  }

  # The ladder reached native chrome. "Go" is rung 1's first level and "Corner"
  # its second; both come from the shared module, so a stale vendor copy or a
  # rail still on the three-level shim fails here rather than silently drawing
  # the wrong course. This is also the readiness gate for the screenshot below:
  # a bounded wait on real content, not a guess at how long boot takes.
  wait_for "Go" || {
    echo "✗ the level rail never showed the ladder's first level" >&2
    return 1
  }
  wait_for "Corner" || {
    echo "✗ the level rail is not showing the real shared ladder" >&2
    return 1
  }

  # The rail is native and paints before the WebView does, so settle briefly to
  # let the document's first frame land in the shot. There is no readiness
  # signal for WebView paint observable from out here.
  sleep 2
  snap "studio-open"

  # Native → document: selecting a level must reach the sandbox and swap the
  # editor's contents. Compare studio-open against studio-hallway to confirm.
  tap_name "Hallway" || {
    echo "✗ could not tap the Hallway chip" >&2
    return 1
  }
  sleep 2
  snap "studio-hallway"

  echo "✓ studio-smoke: route, shared ladder, and level selection proven on the remote sim"
  echo "· screenshots are the ONLY evidence the sandbox document itself booted —"
  echo "  check studio-open for a drawn grid and a syntax-coloured editor,"
  echo "  and studio-hallway for a CHANGED editor buffer."
}
