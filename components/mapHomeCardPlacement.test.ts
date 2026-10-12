import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The scholar Home's map card — WHERE it may render.
//
// There is no component render harness in this repo (edge-runtime vitest, no
// jsdom), so this is a structural drift guard: it reads the real source files
// and asserts the call sites. The card's BEHAVIOUR (which of quiet doorway /
// today's movement / once-ever unlock is live) is a pure function with its
// own truth table in shared/mapHomeCard.test.ts; backend reveal semantics are
// covered by convex/__tests__/mapGates.test.ts. This suite keeps only the two
// placement sentinels a lint cannot express: the retired Sky-reveal surface,
// and the in-session leak this card must never re-acquire.
// ─────────────────────────────────────────────────────────────────────────

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const WEB_HOME = "app/scholar/page.tsx";
const NATIVE_HOME = "native/src/app/index.tsx";

// ─────────────────────────────────────────────────────────────────────────
// f21 — Andy's ruling (2026-07-15, live feedback with screenshot): the map
// reveal must surface ONLY on the scholar HOME screen, never in-session/
// in-flow — it was competing with the completion flow's own "Up next →" CTA.
// The reveal is now a STATE of this card rather than a card of its own, so the
// rule attaches to the card.
// ─────────────────────────────────────────────────────────────────────────
describe("MapHomeCard — Home is the only render surface", () => {
  test("the Sky reveal card is retired: no surface mounts MapHomeCard map=\"sky\" (P5/d4)", () => {
    // The once-ever "Your Sky is ready" reveal was killed 2026-08-12
    // (review/story-quest-rationalization-plan.html, decision d4): the Quests
    // tab's invitation family carries the "something new" moment now. Sky
    // ACCESS is unchanged (web title-bar "Your Map"; native pull-to-Sky) and
    // /scholar/map // /sky still consume revealPending on first arrival.
    expect(read(WEB_HOME)).not.toContain('map="sky"');
    expect(read(NATIVE_HOME)).not.toContain('map="sky"');
  });

  test("no in-flow surface renders the card", () => {
    for (const path of [
      "components/SessionInterface.tsx",
      "components/practice/Placement.tsx",
      "native/src/app/session/[id].tsx",
      "native/src/components/practice/NativePlacement.tsx",
    ]) {
      expect(read(path)).not.toContain("MapHomeCard");
    }
    // The prop that used to gate the in-session sky reveal is fully removed,
    // not just unused-but-present (a half-removal would be easy to miss).
    expect(read("components/SessionInterface.tsx")).not.toContain(
      "canRevealMaps",
    );
    // Both Check-In result screens are still allowed (and expected) to read
    // treeRevealPending for their own CTA-copy label — a label, not a card.
    expect(read("components/practice/Placement.tsx")).toContain(
      "treeRevealPending",
    );
    expect(
      read("native/src/components/practice/NativePlacement.tsx"),
    ).toContain("treeRevealPending");
  });
});
