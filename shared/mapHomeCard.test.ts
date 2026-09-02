import { describe, expect, test } from "vitest";

import {
  MAP_HOME_COPY,
  MAP_HOME_MOVEMENT_HEADING,
  mapHomeAccess,
  mapHomeCopy,
  mapHomeSlot,
  resolveMapHomeState,
  type MapHomeState,
  type MapKind,
} from "./mapHomeCard";

// ─────────────────────────────────────────────────────────────────────────
// The Home's map card is ONE card with a state ladder (Andy, 2026-07-26:
// the reveal card, the Frontier doorway, and the daily receipt were "3
// different flavors of the same thing"). The whole point of folding them is
// that the scholar can never see two of them at once — so the ladder is a
// pure function with a truth table, and both frontends read it. Design:
// review/tree-signal-reconciliation-plan.html.
// ─────────────────────────────────────────────────────────────────────────

function state(
  map: MapKind,
  unlocked: boolean,
  revealPending: boolean,
  hasMovement: boolean | undefined,
  welcomeActive: boolean = false,
): MapHomeState {
  return resolveMapHomeState({
    map,
    unlocked,
    revealPending,
    hasMovement,
    welcomeActive,
  });
}

describe("resolveMapHomeState — the Tree ladder", () => {
  test("a locked map renders nothing, whatever else is true (f6: no surface before data)", () => {
    for (const revealPending of [false, true]) {
      for (const hasMovement of [false, true]) {
        expect(state("tree", false, revealPending, hasMovement)).toBe("hidden");
        expect(state("sky", false, revealPending, hasMovement)).toBe("hidden");
      }
    }
  });

  test("unlocked + nothing happening → the quiet standing doorway", () => {
    expect(state("tree", true, false, false)).toBe("quiet");
  });

  test("movement today → the day's receipt, and the doorway steps aside", () => {
    expect(state("tree", true, false, true)).toBe("daily");
  });

  test("a pending reveal outranks the day (one card, not two)", () => {
    expect(state("tree", true, true, false)).toBe("unlock");
    expect(state("tree", true, true, true)).toBe("unlock");
  });

  // The regression this guards: `hasMovement: false` while the recap query is
  // still in flight resolved to `quiet`, so the Home painted the footer
  // doorway and then, one round-trip later, swapped it for an elevated
  // receipt — shifting every card below it under the scholar's thumb.
  test("an unanswered day hides the card rather than guessing `quiet`", () => {
    expect(state("tree", true, false, undefined)).toBe("hidden");
    expect(mapHomeSlot(state("tree", true, false, undefined))).toBeNull();
  });

  test("a pending reveal does NOT wait on the day — the rows nest inside it", () => {
    expect(state("tree", true, true, undefined)).toBe("unlock");
  });

  test("a map that never moves reports `false`, so it is never hidden by the day", () => {
    // The Sky has no recap query at all; `false` is its answer, not `undefined`.
    expect(state("sky", true, true, false)).toBe("unlock");
  });

  test("exactly one state is ever live, so the two Home slots cannot both fill", () => {
    for (const unlocked of [false, true]) {
      for (const revealPending of [false, true]) {
        for (const hasMovement of [false, true, undefined]) {
          const s = state("tree", unlocked, revealPending, hasMovement);
          const slot = mapHomeSlot(s);
          // A slot is a function of the state alone — there is no input for
          // which "elevated" and "quiet" are both true.
          expect(slot === "elevated" || slot === "quiet" || slot === null).toBe(
            true,
          );
        }
      }
    }
    expect(mapHomeSlot("unlock")).toBe("elevated");
    expect(mapHomeSlot("daily")).toBe("elevated");
    expect(mapHomeSlot("quiet")).toBe("quiet");
    expect(mapHomeSlot("hidden")).toBeNull();
  });
});

describe("resolveMapHomeState — the reveal defers during the welcome sequence", () => {
  // The bug this guards (reported on web): a brand-new scholar's Sky unlocks
  // MID-welcome, because the observer plants seeds as they chat
  // (convex/mapGates.ts). The "Your Sky is ready" reveal then fired before the
  // scholar had even finished being welcomed. The intent is that the moment
  // DEFERS: finish welcome → the reveal greets them the next time home.
  test("a pending reveal is held to `hidden` while welcome is active", () => {
    expect(state("sky", true, true, false, true)).toBe("hidden");
    // Map-agnostic: a Tree reveal defers too (a Tree that moved today keeps its
    // pending reveal held rather than leaking out as a receipt mid-welcome).
    expect(state("tree", true, true, false, true)).toBe("hidden");
    expect(state("tree", true, true, true, true)).toBe("hidden");
    expect(state("tree", true, true, undefined, true)).toBe("hidden");
  });

  test("once welcome is done, the deferred reveal shows on the next resolve", () => {
    // Same inputs, welcomeActive now false → the reveal is no longer withheld.
    expect(state("sky", true, true, false, false)).toBe("unlock");
    expect(state("tree", true, true, false, false)).toBe("unlock");
  });

  test("welcomeActive defaults false, so existing callers are unchanged", () => {
    // The 4-arg overload (no welcomeActive) must behave exactly as before.
    expect(state("sky", true, true, false)).toBe("unlock");
    expect(state("tree", true, true, true)).toBe("unlock");
  });

  test("welcome only defers the REVEAL — a standing/daily state still shows", () => {
    // An already-revealed map (revealPending false) is a doorway/receipt, not a
    // once-ever moment, so welcomeActive does not suppress it.
    expect(state("tree", true, false, false, true)).toBe("quiet");
    expect(state("tree", true, false, true, true)).toBe("daily");
  });

  test("a locked map is still hidden regardless of welcome state", () => {
    expect(state("sky", false, true, false, true)).toBe("hidden");
    expect(state("tree", false, true, true, true)).toBe("hidden");
  });
});

describe("resolveMapHomeState — the Sky reaches only its unlock", () => {
  // Andy, 2026-07-26: "no let's keep sky as is for this PR." The Sky's standing
  // access is the Quests-tab pull-down, and there is no "which stars changed
  // today" read model — so neither extra state may leak in via the shared card.
  test("the Sky unlock still renders", () => {
    expect(state("sky", true, true, false)).toBe("unlock");
  });

  test("an unlocked, revealed Sky shows no quiet doorway", () => {
    expect(state("sky", true, false, false)).toBe("hidden");
  });

  test("the Sky never renders a daily receipt (no Sky movement data exists)", () => {
    expect(state("sky", true, false, true)).toBe("hidden");
  });
});

describe("mapHomeAccess — J10(b), as narrowed 2026-07-26", () => {
  test("the Tree card IS the doorway, so it keeps its CTA in every state", () => {
    expect(mapHomeAccess("tree")).toBe("cta");
    for (const s of ["unlock", "daily", "quiet"] as const) {
      expect(mapHomeCopy("tree", s)?.cta).toBeTruthy();
    }
  });

  test("a gesture-reached map still carries NO button", () => {
    expect(mapHomeAccess("sky")).toBe("gesture");
    expect(mapHomeCopy("sky", "unlock")?.cta).toBeNull();
  });

  test("every map with a CTA state is a `cta` map, and vice versa", () => {
    for (const map of ["sky", "tree"] as const) {
      const hasAnyCta = Object.values(MAP_HOME_COPY[map]).some((c) => !!c.cta);
      expect(hasAnyCta).toBe(mapHomeAccess(map) === "cta");
    }
  });
});

describe("MAP_HOME_COPY — one word per clock", () => {
  test("SOMETHING NEW is reserved for the once-ever unlock", () => {
    expect(mapHomeCopy("tree", "unlock")?.eyebrow).toBe("Something new");
    expect(mapHomeCopy("sky", "unlock")?.eyebrow).toBe("Something new");
    // Routine-but-important movement must not wear the milestone's word.
    expect(mapHomeCopy("tree", "daily")?.eyebrow).toBe("Today");
    expect(mapHomeCopy("tree", "daily")?.eyebrow).not.toMatch(/something new/i);
  });

  test("the standing doorway takes no eyebrow — it is a sibling card, not a section", () => {
    expect(mapHomeCopy("tree", "quiet")?.eyebrow).toBeNull();
  });

  test("nested movement rows say which clock they are on", () => {
    expect(MAP_HOME_MOVEMENT_HEADING).toMatch(/today/i);
  });

  test("no copy exists for a state its map cannot reach", () => {
    expect(mapHomeCopy("sky", "quiet")).toBeNull();
    expect(mapHomeCopy("sky", "daily")).toBeNull();
    expect(mapHomeCopy("tree", "hidden")).toBeNull();
  });

  test("every reachable state has copy (a live state can never render blank)", () => {
    for (const map of ["sky", "tree"] as const) {
      for (const unlocked of [true]) {
        for (const revealPending of [false, true]) {
          for (const hasMovement of [false, true]) {
            const s = state(map, unlocked, revealPending, hasMovement);
            if (s === "hidden") continue;
            expect(mapHomeCopy(map, s)).not.toBeNull();
            expect(mapHomeCopy(map, s)?.title).toBeTruthy();
          }
        }
      }
    }
  });
});
