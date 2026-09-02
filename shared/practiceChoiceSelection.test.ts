import { describe, expect, it } from "vitest";
import {
  deriveStartCta,
  effectiveDomainSet,
  expandMoreLabel,
  isDomainOutsideEffectiveSet,
  needsCheckInGate,
  nextTileSelection,
  playlistTileIconName,
  practiceCtaAccessibleLabel,
  type PlaylistChoiceCard,
} from "./practiceChoiceSelection";

const cardA: PlaylistChoiceCard = { domain: "fraction-arithmetic", strand: "mult-divide" };
const cardB: PlaylistChoiceCard = { domain: "probability", strand: "theoretical" };

describe("nextTileSelection", () => {
  it("selects a strand card from the blend (null)", () => {
    expect(nextTileSelection(null, cardA)).toEqual(cardA);
  });

  it("tapping the already-selected strand card again deselects back to the blend", () => {
    expect(nextTileSelection(cardA, cardA)).toBeNull();
    // A different object with the same (domain, strand) counts as "the same card".
    expect(nextTileSelection({ ...cardA }, cardA)).toBeNull();
  });

  it("tapping a different strand card switches the selection (not a toggle)", () => {
    expect(nextTileSelection(cardA, cardB)).toEqual(cardB);
  });

  it("tapping the blend tile always resets to the default, from any state", () => {
    expect(nextTileSelection(null, "blend")).toBeNull();
    expect(nextTileSelection(cardA, "blend")).toBeNull();
  });
});

describe("deriveStartCta", () => {
  const blendDefault = {
    needsPlacement: false,
    caughtUp: false,
    practicedToday: false,
    hasNextUp: true,
  };

  it("a picked strand always reads 'Start with <headline>' + arrow + primary, regardless of blend state", () => {
    const cases = [
      blendDefault,
      { ...blendDefault, caughtUp: true },
      { ...blendDefault, needsPlacement: true },
      { ...blendDefault, practicedToday: true, hasNextUp: true },
    ];
    for (const blend of cases) {
      expect(deriveStartCta({ strandLabel: "Multiplication & Division" }, blend)).toEqual({
        verb: "Start with Multiplication & Division",
        suffix: "→",
        primary: true,
      });
    }
  });

  it("no selection + needsPlacement → the check-in CTA", () => {
    expect(deriveStartCta(null, { ...blendDefault, needsPlacement: true })).toEqual({
      verb: "Start check-in",
      suffix: "→",
      primary: true,
    });
  });

  // Regression coverage for the pilot7 f18 finding: leaving the check-in
  // mid-flight (a probe already served, but no domain fully placed and no
  // sitting-budget pause) must NOT leave home reading "Start check-in" as if
  // nothing had happened.
  it("no selection + needsPlacement + checkInStarted → 'Resume check-in', not 'Start check-in'", () => {
    expect(
      deriveStartCta(null, { ...blendDefault, needsPlacement: true, checkInStarted: true }),
    ).toEqual({
      verb: "Resume check-in",
      suffix: "→",
      primary: true,
    });
  });

  it("no selection + needsPlacement + checkInStarted explicitly false → still 'Start check-in'", () => {
    expect(
      deriveStartCta(null, { ...blendDefault, needsPlacement: true, checkInStarted: false }),
    ).toMatchObject({ verb: "Start check-in" });
  });

  it("checkInStarted is ignored once needsPlacement is false (never bleeds into another verb)", () => {
    expect(
      deriveStartCta(null, { ...blendDefault, caughtUp: true, checkInStarted: true }),
    ).toMatchObject({ verb: "Practice more" });
  });

  it("no selection + caught up → the secondary 'Practice more?' nudge", () => {
    expect(deriveStartCta(null, { ...blendDefault, caughtUp: true })).toEqual({
      verb: "Practice more",
      suffix: "?",
      primary: false,
    });
  });

  it("no selection + practiced today with a next-up skill → Continue", () => {
    expect(
      deriveStartCta(null, { ...blendDefault, practicedToday: true, hasNextUp: true }),
    ).toEqual({ verb: "Continue", suffix: "→", primary: true });
  });

  it("no selection, nothing practiced yet → plain Start", () => {
    expect(deriveStartCta(null, blendDefault)).toEqual({
      verb: "Start",
      suffix: "→",
      primary: true,
    });
  });

  it("needsPlacement wins over caughtUp when (implausibly) both are true", () => {
    expect(
      deriveStartCta(null, { ...blendDefault, needsPlacement: true, caughtUp: true }),
    ).toMatchObject({ verb: "Start check-in" });
  });
});

describe("effectiveDomainSet + isDomainOutsideEffectiveSet", () => {
  // Regression coverage for the PR #892 review finding: a scholar under a
  // standing assignment pinning domain A who taps a tile for domain B must
  // get an explicit domain override on the Start link, or the practice
  // screen's own standing resolution silently serves A instead of the B the
  // preview promised ("what you see isn't what you'll start", again).

  it("a mixed standing pin (2+ domains) wins as the effective set", () => {
    const set = effectiveDomainSet({
      standingDomains: ["whole-number-arithmetic", "fraction-arithmetic"],
      standingDomain: "whole-number-arithmetic",
      startedDomains: ["geometry"],
    });
    expect(set).toEqual(["whole-number-arithmetic", "fraction-arithmetic"]);
  });

  it("a single standing pin wins over started domains", () => {
    const set = effectiveDomainSet({
      standingDomain: "whole-number-arithmetic",
      startedDomains: ["geometry", "probability"],
    });
    expect(set).toEqual(["whole-number-arithmetic"]);
  });

  it("no standing pin at all falls back to the scholar's own started domains (auto-blend)", () => {
    const set = effectiveDomainSet({
      startedDomains: ["geometry", "probability"],
    });
    expect(set).toEqual(["geometry", "probability"]);
  });

  it("a new-territory tile for a domain OUTSIDE a standing pin needs an explicit override", () => {
    // Scholar has a standing assignment pinning "whole-number-arithmetic" and
    // taps a "new territory" tile for "geometry" (not started, not pinned).
    const domainSet = effectiveDomainSet({
      standingDomain: "whole-number-arithmetic",
      startedDomains: [],
    });
    expect(isDomainOutsideEffectiveSet("geometry", domainSet)).toBe(true);
  });

  it("a tile whose domain IS inside the standing pin needs no override", () => {
    const domainSet = effectiveDomainSet({
      standingDomains: ["whole-number-arithmetic", "fraction-arithmetic"],
      standingDomain: "whole-number-arithmetic",
      startedDomains: [],
    });
    expect(isDomainOutsideEffectiveSet("fraction-arithmetic", domainSet)).toBe(false);
  });

  it("a tile whose domain is inside the scholar's own started set (no pin) needs no override", () => {
    const domainSet = effectiveDomainSet({ startedDomains: ["geometry", "probability"] });
    expect(isDomainOutsideEffectiveSet("probability", domainSet)).toBe(false);
  });
});

describe("needsCheckInGate", () => {
  // pilot7 f19: a scholar with ≥1 placed domain but an incomplete/paused mixed
  // check-in must still be able to drill — the ordinary "Today's blend"
  // continue and an already-started strand pick must never gate on it.
  it("an ordinary no-pin entry with ≥1 domain already started never gates (regardless of check-in completeness)", () => {
    expect(
      needsCheckInGate({ isExplicitCheckIn: false, startedDomainCount: 1 }),
    ).toBe(false);
    expect(
      needsCheckInGate({ isExplicitCheckIn: false, startedDomainCount: 2 }),
    ).toBe(false);
  });

  it("a scholar with NOTHING started yet still gates — there is no blend to drill", () => {
    expect(
      needsCheckInGate({ isExplicitCheckIn: false, startedDomainCount: 0 }),
    ).toBe(true);
  });

  it("the explicit check-in CTA always gates, even with domains already started", () => {
    expect(
      needsCheckInGate({ isExplicitCheckIn: true, startedDomainCount: 0 }),
    ).toBe(true);
    expect(
      needsCheckInGate({ isExplicitCheckIn: true, startedDomainCount: 3 }),
    ).toBe(true);
  });
});

describe("playlistTileIconName", () => {
  // The registered practice-domain slugs (shared/practiceDomainLabels.ts'
  // PRACTICE_DOMAIN_LABELS) — hardcoded here rather than imported, since this
  // module is deliberately dependency-free (see the file header).
  const REGISTERED_DOMAINS = [
    "whole-number-arithmetic",
    "fraction-arithmetic",
    "probability",
    "geometry-measurement",
    "ratio-proportion-percent",
    "integers-coordinates",
    "early-algebra",
    "algebra-1",
  ];

  it("every tile kind resolves a non-empty icon name (carousel completeness)", () => {
    expect(playlistTileIconName("blend")).toBeTruthy();
    expect(playlistTileIconName("stretch")).toBeTruthy();
    for (const domain of REGISTERED_DOMAINS) {
      expect(playlistTileIconName("strand", domain)).toBeTruthy();
      expect(playlistTileIconName("new-territory", domain)).toBeTruthy();
    }
  });

  it("every registered domain gets its OWN curated icon, not the fallback", () => {
    const fallback = playlistTileIconName("strand", "some-not-yet-registered-domain");
    for (const domain of REGISTERED_DOMAINS) {
      expect(playlistTileIconName("strand", domain)).not.toBe(fallback);
    }
    // And the curated set itself has no accidental duplicates — each domain
    // reads as its own subject, not a repeat of a sibling's icon.
    const names = REGISTERED_DOMAINS.map((d) => playlistTileIconName("strand", d));
    expect(new Set(names).size).toBe(names.length);
  });

  it("'strand' and 'new-territory' resolve the SAME icon for a given domain (the NEW badge is the only visual difference)", () => {
    for (const domain of REGISTERED_DOMAINS) {
      expect(playlistTileIconName("new-territory", domain)).toBe(playlistTileIconName("strand", domain));
    }
  });

  it("an unregistered domain falls back rather than resolving to undefined", () => {
    expect(playlistTileIconName("strand", "not-a-real-domain")).toBe(
      playlistTileIconName("strand", "also-not-real"),
    );
  });

  it("blend and stretch each have their OWN distinct icon (never collide with each other or a domain icon)", () => {
    const blend = playlistTileIconName("blend");
    const stretch = playlistTileIconName("stretch");
    expect(blend).not.toBe(stretch);
    for (const domain of REGISTERED_DOMAINS) {
      const domainIcon = playlistTileIconName("strand", domain);
      expect(domainIcon).not.toBe(blend);
      expect(domainIcon).not.toBe(stretch);
    }
  });
});

describe("expandMoreLabel", () => {
  it("no selection (the blend) reads 'today's set'", () => {
    expect(expandMoreLabel(2, null)).toBe("2 more in today's set");
  });

  it("a chosen playlist names ITSELF, not the generic 'today's set'", () => {
    expect(expandMoreLabel(1, { strandLabel: "Fraction Concepts" })).toBe(
      "1 more in Fraction Concepts",
    );
    expect(expandMoreLabel(3, { strandLabel: "Area & Perimeter" })).toBe(
      "3 more in Area & Perimeter",
    );
  });
});

describe("practiceCtaAccessibleLabel", () => {
  const blendDefault = {
    needsPlacement: false,
    caughtUp: false,
    practicedToday: false,
    hasNextUp: true,
  };
  const noSelection = { hasSelectedChoice: false };

  // Regression coverage for the accessibility defect found in adversarial
  // review of PR #906: the visual CTA forks "Start check-in" vs. "Resume
  // check-in" (the pilot7 f18 fix), but the accessible label used to be a
  // SEPARATELY hard-coded string that never forked — so assistive-tech users
  // never heard the difference. The accessible label must always match the
  // SAME fork the visual `startCta.verb` renders, in BOTH states.
  it("the accessible label forks Start vs Resume in lockstep with the visual CTA verb, in both states", () => {
    for (const checkInStarted of [false, true]) {
      const startCta = deriveStartCta(null, {
        ...blendDefault,
        needsPlacement: true,
        checkInStarted,
      });
      const expectedVerb = checkInStarted ? "Resume check-in" : "Start check-in";
      expect(startCta.verb).toBe(expectedVerb);

      const aria = practiceCtaAccessibleLabel(startCta, {
        ...noSelection,
        needsPlacement: true,
        caughtUp: false,
        practicedToday: false,
        nextUpLabel: null,
        firstPostPlacementBlock: false,
      });
      const expectedAria = checkInStarted
        ? "Resume your math check-in"
        : "Start your math check-in";
      expect(aria).toBe(expectedAria);
    }
  });

  it("a picked strand's accessible label is IDENTICAL to its visual verb (nothing to fork)", () => {
    const startCta = deriveStartCta({ strandLabel: "Fraction Concepts" }, blendDefault);
    const aria = practiceCtaAccessibleLabel(startCta, {
      hasSelectedChoice: true,
      needsPlacement: false,
      caughtUp: false,
      practicedToday: false,
      nextUpLabel: null,
      firstPostPlacementBlock: false,
    });
    expect(aria).toBe(startCta.verb);
    expect(aria).toBe("Start with Fraction Concepts");
  });

  it("caught-up, continue-with-next-up, first-block, and default states each get their own descriptive sentence", () => {
    const caughtUpCta = deriveStartCta(null, { ...blendDefault, caughtUp: true });
    expect(
      practiceCtaAccessibleLabel(caughtUpCta, {
        ...noSelection,
        needsPlacement: false,
        caughtUp: true,
        practicedToday: false,
        nextUpLabel: null,
        firstPostPlacementBlock: false,
      }),
    ).toBe("Practice more math");

    const continueCta = deriveStartCta(null, {
      ...blendDefault,
      practicedToday: true,
      hasNextUp: true,
    });
    expect(
      practiceCtaAccessibleLabel(continueCta, {
        ...noSelection,
        needsPlacement: false,
        caughtUp: false,
        practicedToday: true,
        nextUpLabel: "Multiplication & Division",
        firstPostPlacementBlock: false,
      }),
    ).toBe("Continue your math playlist with Multiplication & Division");

    const freshCta = deriveStartCta(null, blendDefault);
    expect(
      practiceCtaAccessibleLabel(freshCta, {
        ...noSelection,
        needsPlacement: false,
        caughtUp: false,
        practicedToday: false,
        nextUpLabel: null,
        firstPostPlacementBlock: true,
      }),
    ).toBe("Start your first math playlist");
    expect(
      practiceCtaAccessibleLabel(freshCta, {
        ...noSelection,
        needsPlacement: false,
        caughtUp: false,
        practicedToday: false,
        nextUpLabel: null,
        firstPostPlacementBlock: false,
      }),
    ).toBe("Start today's math playlist");
  });
});
