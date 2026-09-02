/**
 * Native re-export of the shared Workbench display/scoring helpers, which now
 * live in `lib/simulator/helpers.ts` (web) and are vendored to
 * `native/vendor/simulator/helpers.ts` by `native/scripts/sync-vendor.js`. Keep
 * ONLY native-only helpers here (e.g. `phaseFromId` — the SimulatorViewport's
 * own bob-phase hash; distinct from web's `stablePhase` in `viewport.ts`, and
 * NOT merged with it — different hash, viewport-internal).
 */

export * from "../../../vendor/simulator/helpers";
export { workbenchTimeNoun } from "./workbenchTerminology";

/** A stable 0..1 phase from an automaton's identity (NOT its position), so the
 * ambient bob keeps a steady rhythm as the automaton moves. */
export function phaseFromId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) & 0xffffffff;
  }
  return (Math.abs(hash) % 1000) / 1000;
}
