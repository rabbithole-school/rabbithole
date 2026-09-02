import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The scholar Home's map card — WHERE it may render, and what it may say.
//
// There is no component render harness in this repo (edge-runtime vitest, no
// jsdom — see the note in checkInResultCta.test.ts), so this is a structural
// drift guard: it reads the real source files and asserts the call sites. The
// card's BEHAVIOUR (which of quiet doorway / today's movement / once-ever
// unlock is live, and which maps carry a CTA) is a pure function with its own
// truth table in shared/mapHomeCard.test.ts; backend reveal semantics are
// covered by convex/__tests__/mapGates.test.ts. This suite covers only the
// third thing neither of those can see: placement.
// ─────────────────────────────────────────────────────────────────────────

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The source between two markers — used to ask "is this call site inside THAT
 *  tab's block?" without a JSX parser. Throws rather than silently returning ""
 *  if a marker moves, so a refactor can't make these assertions vacuous. */
function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  if (from < 0) throw new Error(`marker not found: ${start}`);
  const to = src.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`marker not found after ${start}: ${end}`);
  return src.slice(from, to);
}

// The three tab blocks of the web scholar home, in source order.
const WEB_NOW_BLOCK = '{(activeTab === "now" && !isRemoteMode) && (';
const WEB_ALL_BLOCK = '{(activeTab === "all" || isRemoteMode) && (';
const WEB_SUBJECT_BLOCK = "{isSubjectTab && !isRemoteMode && (";
const WEB_PREP_BLOCK = "{isPrepTab && !isRemoteMode &&";

const WEB_HOME = "app/scholar/page.tsx";
const NATIVE_HOME = "native/src/app/index.tsx";
const NATIVE_PLAYLIST =
  "native/src/components/practice/PracticePlaylistCard.tsx";
const WEB_CARD = "components/MapHomeCard.tsx";
const NATIVE_CARD = "native/src/components/MapHomeCard.tsx";

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

  test("the Tree card keeps its Math-tab home on both frontends", () => {
    const home = read(WEB_HOME);
    const subjectTab = between(home, WEB_SUBJECT_BLOCK, WEB_PREP_BLOCK);
    expect(subjectTab).toMatch(/<MapHomeCard\s*\n\s*map="tree"/);
    expect(subjectTab).toContain("isMathTab && (");
    expect(between(home, WEB_NOW_BLOCK, WEB_ALL_BLOCK)).not.toContain(
      "MapHomeCard",
    );
    expect(read(NATIVE_HOME)).toMatch(
      /isMathTab && <MapHomeCard\s+map="tree"\s+slot="elevated"\s*\/>/,
    );
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

// ─────────────────────────────────────────────────────────────────────────
// One signal, one position (Andy, 2026-07-26: the reveal card, the Frontier
// doorway and the daily receipt were "3 different flavors of the same thing").
// The ladder guarantees exactly one STATE is live; these guard that the old
// duplicate SURFACES are actually gone and cannot creep back.
// ─────────────────────────────────────────────────────────────────────────
describe("MapHomeCard — the folded surfaces stay folded", () => {
  test("the standalone reveal / Frontier / native recap components are gone", () => {
    for (const gone of [
      "MapRevealCard",
      "MapRevealNativeCard",
      "FrontierCard",
    ]) {
      expect(read(WEB_HOME)).not.toContain(gone);
      expect(read(NATIVE_HOME)).not.toContain(gone);
    }
  });

  test("native renders the Tree card in exactly two slots — elevated and quiet", () => {
    const home = read(NATIVE_HOME);
    const treeCalls = home.match(/<MapHomeCard\s+map="tree"[^/]*\/>/g) ?? [];
    expect(treeCalls).toHaveLength(2);
    expect(treeCalls.filter((c) => c.includes('slot="elevated"'))).toHaveLength(
      1,
    );
    expect(treeCalls.filter((c) => c.includes('slot="quiet"'))).toHaveLength(1);
  });

  test("native resolves the playlist and elevated Tree through one placement boundary", () => {
    const home = read(NATIVE_HOME);
    const playlist = read(NATIVE_PLAYLIST);
    expect(home).not.toContain("mathPlaylistHasWork");
    expect(home).toMatch(
      /<PracticePlaylistCard[\s\S]*treeHero=\{mathTreeCardElevated\}[\s\S]*\/>/,
    );

    const loadingBoundary = between(
      playlist,
      "if (loadingCard) {",
      "// `playlist` is narrowed to defined past the guards above",
    );
    expect(loadingBoundary).not.toContain("treeHero");
    // The nothing-to-serve branch still returns the Tree hero across the same
    // placement boundary — now alongside the completion + check-in heroes
    // (finish-the-check-in Surfaces 1/4), which is why it is a block rather than
    // the old one-liner. The boundary invariant (treeHero resolves here, never in
    // the loading branch above) is unchanged.
    const nothingBranch = between(
      playlist,
      "if (nothingToServe) {",
      "// Neither real surface paints",
    );
    expect(nothingBranch).toContain("treeHero ?? null");

    const resolved = between(
      playlist,
      "return (\n    <>",
      "function PracticePlaylistSkeleton",
    );
    const elevated = resolved.indexOf("{!hasWork ? treeHero : null}");
    const card = resolved.indexOf("<HomeSection");
    const demoted = resolved.indexOf("{hasWork ? treeHero : null}");
    expect(elevated).toBeGreaterThanOrEqual(0);
    expect(elevated).toBeLessThan(card);
    expect(demoted).toBeGreaterThan(card);
  });

  test("the daily receipt no longer renders itself on the Now tab", () => {
    // Andy, 2026-07-26 ("should daily Tree movement leave the Now tab?" →
    // "yes"): its canonical home is the Tree card on the Math tab. Native's
    // recap now has no component of its own at all.
    expect(read(NATIVE_HOME)).not.toContain("DailyRecapCard");
    // Web keeps the presentational card — but only inside MapHomeCard and in
    // the teacher's REMOTE view, never as a standing Now-tab surface.
    const web = read(WEB_HOME);
    const recapCalls = web.match(/<DailyRecapCard\b/g) ?? [];
    expect(recapCalls).toHaveLength(1);
    expect(between(web, WEB_NOW_BLOCK, WEB_ALL_BLOCK)).not.toContain(
      "DailyRecapCard",
    );
    expect(between(web, WEB_ALL_BLOCK, WEB_SUBJECT_BLOCK)).toContain(
      "<DailyRecapCard",
    );
  });

  test("both frontends read the shared ladder rather than re-deriving it", () => {
    expect(read(WEB_CARD)).toContain("resolveMapHomeState");
    expect(read("native/src/hooks/useMapHomeState.ts")).toContain(
      "resolveMapHomeState",
    );
    // Copy included: a hardcoded title on either side is drift by construction.
    expect(read(WEB_CARD)).toContain("mapHomeCopy");
    expect(read(NATIVE_CARD)).toContain("mapHomeCopy");
  });

  // The `daily` state is the one that composes a pre-existing presentational
  // component, so it is the one that can quietly stop reading the shared copy
  // and fall back to that component's own hardcoded strings — which is exactly
  // what it did until review caught it. Asserting the file merely *mentions*
  // `mapHomeCopy` passes vacuously in that case, so assert the wiring.
  test("the web daily receipt is TOLD its copy, not left to hardcode it", () => {
    const web = read(WEB_CARD);
    const call = web.slice(web.indexOf("<DailyRecapCard"));
    expect(call).toContain("title={copy.title}");
    expect(call).toContain("ctaLabel={copy.cta");
    // …and the presentational card must accept them rather than ignore them.
    const recapCard = read("components/DailyRecapCard.tsx");
    expect(recapCard).toMatch(/title\s*=\s*DEFAULT_TITLE/);
    expect(recapCard).toMatch(/ctaLabel\s*=\s*DEFAULT_CTA/);
    expect(recapCard).toContain("{title}");
    expect(recapCard).toContain("{ctaLabel}");
  });

  // The flash this guards is invisible in a screenshot and obvious in the
  // hand: both frontends must distinguish "the day has not answered yet" from
  // "the day answered no", or the card renders a rung it is about to leave.
  test("both frontends pass `undefined` for an unanswered day, not `false`", () => {
    expect(read("native/src/hooks/useMapHomeState.ts")).toContain(
      "recap === undefined ? undefined",
    );
    expect(read(WEB_CARD)).toContain("recap === undefined ? undefined");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// f21 addendum (2026-07-15) — Andy, re a home-screen screenshot: "let's make
// the 'Something New' card(s) for sky map and tree map full width - all the
// cards on the home screen are the same width so far, let's keep it that
// way." The unlock state must fill the SAME column every other Home card
// fills, not center as a narrower island.
// ─────────────────────────────────────────────────────────────────────────
describe("MapHomeCard — full width, matching every other Home card", () => {
  test("web has no maxW cap and stretches w=100%", () => {
    const card = read(WEB_CARD);
    expect(card).toContain('w="100%"');
    expect(card).not.toMatch(/maxW=/);
    expect(card).not.toMatch(/alignSelf="center"/);
  });

  test("native has no maxWidth cap and fills its parent", () => {
    const card = read(NATIVE_CARD);
    expect(card).toMatch(/width:\s*"100%"/);
    expect(card).not.toMatch(/maxWidth:/);
    expect(card).not.toMatch(/alignSelf:\s*"center"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// J10(b) — Andy's ruling (2026-07-20), as NARROWED on 2026-07-26 ("agree,
// narrow J10(b)"). The original: reveal cards stop being "press the button to
// open the map"; they TEACH the access path, and the reveal is consumed when
// the scholar actually ARRIVES. That was written when the reveal was a
// throwaway card beside the real doorway. Now the Tree card IS the doorway, so
// removing its CTA in the unlock state would strip the access path from the one
// surface that owns it. The narrowing, encoded in shared/mapHomeCard.ts and
// unit-tested there:
//   - a map reached by a GESTURE (Sky) still carries NO button;
//   - a map whose standing Home access is this card (Tree) keeps its CTA.
// What did NOT change, and is guarded here: neither state consumes the reveal
// itself — a render is not an acknowledgement, and neither is a click.
// ─────────────────────────────────────────────────────────────────────────
describe("MapHomeCard — teach the gesture, and never self-acknowledge (J10(b))", () => {
  test("neither card consumes the reveal itself", () => {
    for (const path of [WEB_CARD, NATIVE_CARD]) {
      const card = read(path);
      expect(card).not.toContain("useMutation");
      expect(card).not.toContain("acknowledgeReveal");
    }
  });

  test("the CTA-vs-gesture decision is read from the shared rule, not hardcoded", () => {
    for (const path of [WEB_CARD, NATIVE_CARD]) {
      expect(read(path)).toContain("mapHomeAccess");
    }
  });

  test("web's gesture copy points at the REAL top-right nav control label", () => {
    const card = read(WEB_CARD);
    const home = read(WEB_HOME);
    // Whatever the nav control actually says, the card must quote it verbatim.
    // This pins the two to the same string so renaming one trips the test.
    expect(home).toContain("Your Map");
    expect(card).toContain("Your Map");
    expect(card).toMatch(/top corner/i);
  });

  test("native's gesture copy teaches the pull-down", () => {
    expect(read(NATIVE_CARD)).toMatch(/Pull down/i);
  });

  test("the map surfaces consume the reveal on arrival, per lens", () => {
    const mapPage = read("app/scholar/map/page.tsx");
    expect(mapPage).toContain("api.mapGates.acknowledgeReveal");
    // Fires for the visible lens (effectiveMode), not a hardcoded map.
    expect(mapPage).toMatch(/acknowledgeReveal\(\{\s*map:\s*m\s*\}\)/);

    const sky = read("native/src/app/sky.tsx");
    expect(sky).toContain("api.mapGates.acknowledgeReveal");
    expect(sky).toMatch(/acknowledgeReveal\(\{\s*map:\s*m\s*\}\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The mastery dial's palette + the nested rows' grammar.
//
// Two failures this pins, both of which shipped once:
//   1. The palette lived in three hand-synced copies, each with a "keep in
//      sync" comment and no test. It is now shared/masteryDialPalette.ts;
//      these tests fail the moment a component re-mints one of the hexes.
//   2. The unlock state's nested rows rendered as centered "name · label"
//      text — the same signal the sibling receipt draws with a dial, in a
//      second vocabulary, with the mastery colour dropped entirely.
// ─────────────────────────────────────────────────────────────────────────

const PALETTE = "shared/masteryDialPalette.ts";
const WEB_DIAL = "components/KnowledgeNodeDial.tsx";
const WEB_CENTER_DOT = "components/MasteryCenterDot.tsx";
const NATIVE_DIAL = "native/src/components/tree/treeGlyphs.tsx";

describe("mastery dial palette", () => {
  test("the dot hexes live in exactly one module", () => {
    const palette = read(PALETTE);
    // The earned hues are the signal; assert they are HERE...
    expect(palette).toContain("#e0b84e"); // frontier amber
    expect(palette).toContain("#3a9e6b"); // fluent green
    expect(palette).toContain("#d7dbd4"); // locked grey (paper)

    // ...and nowhere else. Any component re-declaring one has forked the
    // palette, which is exactly how the three copies arose.
    for (const path of [
      WEB_DIAL,
      WEB_CENTER_DOT,
      NATIVE_DIAL,
      "components/NodeDrawer.tsx",
      WEB_CARD,
      NATIVE_CARD,
    ]) {
      const src = read(path);
      for (const hex of ["#e0b84e", "#3a9e6b", "#d7dbd4", "#0f766e"]) {
        expect(
          src.includes(hex),
          `${path} re-declares dial hex ${hex} — import from ${PALETTE} instead`,
        ).toBe(false);
      }
    }
  });

  test("night re-states only the background-relative colours", () => {
    const palette = read(PALETTE);
    // The night override is deltas-only, so the earned hues cannot fork per
    // surface: whatever is overridden must NOT be frontier or fluent.
    const night = between(
      palette,
      "const MASTERY_DOT_COLOR_NIGHT",
      "export function masteryDotColor",
    );
    expect(night).toContain("locked:");
    expect(night).not.toContain("frontier:");
    expect(night).not.toContain("fluent:");
  });

  test("both dials accept a surface and default it to paper", () => {
    for (const path of [WEB_DIAL, NATIVE_DIAL]) {
      const src = read(path);
      expect(src).toMatch(/surface[?]?:\s*DialSurface/);
      expect(src).toContain('surface = "paper"');
    }
    // The earned hues + hollow fill come from the shared palette, never a
    // forked copy. The native dial resolves them inline; the web dial delegates
    // its centre dot to the shared MasteryCenterDot, which resolves them — so
    // the palette threads through one renderer, not two.
    expect(read(NATIVE_DIAL)).toContain("masteryDotColor");
    expect(read(NATIVE_DIAL)).toContain("dialHollowFill");
    expect(read(WEB_DIAL)).toContain("MasteryCenterDot");
    const centreDot = read(WEB_CENTER_DOT);
    expect(centreDot).toContain("masteryDotColor");
    expect(centreDot).toContain("dialHollowFill");
  });
});

describe("the unlock state's nested rows", () => {
  test("use the receipt's row grammar, not a second vocabulary", () => {
    for (const [path, dial] of [
      [WEB_CARD, "KnowledgeNodeDial"],
      [NATIVE_CARD, "TreeDial"],
    ] as const) {
      const src = read(path);
      const nested = between(
        src,
        "MAP_HOME_MOVEMENT_HEADING",
        "state === \"daily\"",
      );
      // A dial per row — the amber/green mapping the receipt already carries.
      expect(nested, `${path} nested rows must render a ${dial}`).toContain(dial);
      expect(nested).toContain("DIAL_STATE[line.mastery]");
      // On the dark card, so the quiet locked dot stays the quiet one.
      expect(nested).toContain('surface="night"');
      // ...and NOT the old centered "name · label" run-together text.
      expect(nested).not.toContain("{line.text} · {line.label}");
    }
  });

  test("the recap dot mapping has one home, shared by every surface", () => {
    expect(read("shared/dailyRecapLines.ts")).toContain("RECAP_DIAL_STATE");
    for (const path of [WEB_CARD, NATIVE_CARD, "components/DailyRecapCard.tsx"]) {
      const src = read(path);
      expect(src).toContain("RECAP_DIAL_STATE");
      // No local re-declaration of the three-way mapping.
      expect(src).not.toMatch(/revealed:\s*"locked"/);
    }
  });
});
