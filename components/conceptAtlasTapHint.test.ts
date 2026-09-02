import { describe, expect, test } from "vitest";
import { tapOpensSomething } from "./conceptAtlasTapHint";

/**
 * FTUE M7 code review — the debut-Sky tap hint ("Tap a star to open it…")
 * must dismiss ONLY on a tap that actually opens something. On a scholar's
 * own Sky (`canCurate=false`, `ConceptDrawer` is a teacher curation tool),
 * the only genuinely tappable stars are pulled-next SEED stars; every other
 * star (demonstrated mastery, standards reached) is a deliberate no-op tap
 * and must NOT dismiss the hint — a no-op tap silently killing the
 * instruction that told the kid to tap would teach the wrong lesson.
 */
describe("tapOpensSomething", () => {
  test("an interactive seed star always opens something, regardless of canCurate", () => {
    expect(tapOpensSomething("seed-star-1", { isInteractiveSeed: true, canCurate: false })).toBe(true);
    expect(tapOpensSomething("seed-star-1", { isInteractiveSeed: true, canCurate: true })).toBe(true);
  });

  test("a demonstrated-mastery/standard star on a scholar's own Sky (canCurate=false) is a no-op", () => {
    // This is the exact regression: a scholar's own Sky always renders with
    // canCurate=false, so a real (non-seed) knowledgeNodes id here opens
    // nothing — the hint must stay up.
    expect(tapOpensSomething("mastery-node-1", { isInteractiveSeed: false, canCurate: false })).toBe(false);
  });

  test("a real concept id opens the ConceptDrawer on curator surfaces (canCurate=true)", () => {
    expect(tapOpensSomething("concept-node-1", { isInteractiveSeed: false, canCurate: true })).toBe(true);
  });

  test("a galaxy free-float seed id (synthetic, hover-only) never opens a drawer, even for a curator", () => {
    expect(tapOpensSomething("seed:scholar123:seedAbc", { isInteractiveSeed: false, canCurate: true })).toBe(false);
  });

  test("a galaxy free-float seed id is a no-op for a non-curator too", () => {
    expect(tapOpensSomething("seed:scholar123:seedAbc", { isInteractiveSeed: false, canCurate: false })).toBe(false);
  });
});
