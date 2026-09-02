import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// PR2 finish-the-check-in SURFACES — native mirror of
// components/checkInSurfacesPlacement.test.ts. Same rationale: no component
// render harness for these Convex-subscribing screens, so this is a
// structural drift guard reading the real source and asserting call sites,
// not a rendered-output test.
// ─────────────────────────────────────────────────────────────────────────

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const NATIVE_INDEX = "src/app/index.tsx";
const NATIVE_PRACTICE = "src/app/practice.tsx";
const NATIVE_PLAYLIST_CARD = "src/components/practice/PracticePlaylistCard.tsx";
const NATIVE_COMPLETION_CARD = "src/components/MapCompletionCard.tsx";
const NATIVE_CHECKIN_CARD = "src/components/practice/CheckInHomeCard.tsx";
const NATIVE_DEEP_LINK_PARAMS = "src/lib/practiceDeepLinkParams.ts";

describe("CheckInHomeCard — Surface 1 mounts above the playlist it accelerates (native)", () => {
  test("index.tsx computes a self-contained CheckInHomeCard element for the math tab", () => {
    expect(read(NATIVE_INDEX)).toContain(
      "const mathCheckInCardElevated = isMathTab && <CheckInHomeCard />;",
    );
  });

  test("threads checkInHero into PracticePlaylistCard's mount, alongside completionHero + treeHero", () => {
    const index = read(NATIVE_INDEX);
    const mountIdx = index.indexOf("<PracticePlaylistCard");
    const closeIdx = index.indexOf("/>", mountIdx);
    const mount = index.slice(mountIdx, closeIdx);
    expect(mount).toContain("treeHero={mathTreeCardElevated}");
    expect(mount).toContain("completionHero={mathCompletionCardElevated}");
    expect(mount).toContain("checkInHero={mathCheckInCardElevated}");
  });

  test("routes to the revived multi-domain check-in, never the single-domain placement route", () => {
    expect(read(NATIVE_CHECKIN_CARD)).toContain('/practice?checkin=all');
  });
});

describe("PracticePlaylistCard — completionHero/checkInHero ordering mirrors web (native)", () => {
  test("completionHero renders unconditionally first in BOTH early returns (nothingToServe, loadingCard)", () => {
    const src = read(NATIVE_PLAYLIST_CARD);
    // nothingToServe: completionHero, checkInHero, then treeHero.
    expect(src).toMatch(/\{completionHero\}\s*\{checkInHero\}\s*\{treeHero \?\? null\}/);
    // loadingCard: completionHero, then the skeleton (no checkInHero — avoids
    // a reflow against the pre-existing treeHero boundary-crossing optimization).
    expect(src).toMatch(/\{completionHero\}\s*<PracticePlaylistSkeleton/);
  });

  test("main render: completionHero first, checkInHero always directly above the playlist body, treeHero toggles side", () => {
    const src = read(NATIVE_PLAYLIST_CARD);
    // !hasWork branch: completionHero, treeHero, checkInHero, then <HomeSection> (the playlist body).
    expect(src).toMatch(
      /\{completionHero\}\s*\{!hasWork \? treeHero : null\}\s*\{checkInHero\}\s*<HomeSection/,
    );
    // hasWork branch: treeHero renders at the END, after the playlist body closes.
    expect(src).toMatch(/<\/HomeSection>\s*\{hasWork \? treeHero : null\}/);
  });
});

describe("MapCompletionCard — Surface 4 is the loudest rung, scholar-self only (native)", () => {
  test("is a self-only component — never accepts a scholarId prop", () => {
    expect(read(NATIVE_COMPLETION_CARD)).not.toMatch(/scholarId\s*:/);
  });

  test("CheckInHomeCard is also self-only — resolves its own scholarId, no prop", () => {
    // Native has no remote/teacher Home view (confirmed: no isRemoteMode in
    // native/src/app/index.tsx), so both cards resolve `api.users.currentUser`
    // themselves rather than threading a scholarId prop from a parent.
    const src = read(NATIVE_CHECKIN_CARD);
    expect(src).toContain("api.users.currentUser");
    expect(src).not.toMatch(/export function CheckInHomeCard\([^)]*scholarId/);
  });

  test("CheckInHomeCard is auto-blend only — a teacher-pinned scholar never sees it", () => {
    // The half of web's `checkInScholarId` that native must reproduce for
    // itself. Web writes `checkInScholarId = autoBlend ? recapScholarId :
    // undefined` (app/scholar/page.tsx) — a pin IS the single-domain override,
    // so there is no cross-domain check-in to accelerate. Dropping the prop
    // (correct: no remote view) once dropped this gate with it, and a pinned
    // scholar on iPad saw a card web suppresses. Structural guard, because
    // there is no RN render harness in this repo.
    const src = read(NATIVE_CHECKIN_CARD);
    expect(src).toContain("api.standingPractice.myActiveStanding");
    expect(src).toContain("const autoBlend = standing === null;");
    // The gate must sit on the map query itself, so a pinned scholar never
    // even subscribes — the same shape PracticePlaylistCard uses.
    expect(src).toMatch(/autoBlend && scholarId \? \{ scholarId \} : "skip"/);
  });
});

describe("?checkin=all — the revived multi-domain check-in entry (Surface 2, native)", () => {
  test("practiceDeepLinkParams derives checkInAllDomains only on the true default (no-pin) blend entry", () => {
    const src = read(NATIVE_DEEP_LINK_PARAMS);
    expect(src).toContain(
      'isDefaultBlendEntry && !choiceDomain && firstValue(raw.checkin) === "all";',
    );
  });

  test("practice.tsx mounts NativePlacement with multiDomain when checkInAllDomains is true", () => {
    const src = read(NATIVE_PRACTICE);
    expect(src).toContain("if (checkInAllDomains && !placementDone) {");
    const gateIdx = src.indexOf("if (checkInAllDomains && !placementDone) {");
    const gateEnd = src.indexOf("\n  }\n", gateIdx);
    const gate = src.slice(gateIdx, gateEnd);
    expect(gate).toContain("<NativePlacement");
    expect(gate).toContain("multiDomain");
  });

  test("checked BEFORE the single-domain placement gate, and skips the ambient session load", () => {
    const src = read(NATIVE_PRACTICE);
    const checkInGateIdx = src.indexOf("if (checkInAllDomains && !placementDone) {");
    const singleDomainGateIdx = src.indexOf(
      "if (!isMixed && !mappingEntry && !placementDone && (needsPlacement === true || enteredPlacement)) {",
    );
    expect(checkInGateIdx).toBeGreaterThan(-1);
    expect(singleDomainGateIdx).toBeGreaterThan(-1);
    expect(checkInGateIdx).toBeLessThan(singleDomainGateIdx);
    expect(src).toContain("if (checkInAllDomains) return;");
  });
});
