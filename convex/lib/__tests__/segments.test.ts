/**
 * Playlist segments v1 (raise-the-ceiling §11 / C-4) — the composer in
 * lib/practice/segments.ts. Covers:
 *   1. Kind classification (manipulative / choice / core_drill).
 *   2. The anti-slog rule and exactly what it can/cannot guarantee at size 6.
 *   3. Priority preservation (the review band's order is never touched; at
 *      most one frontier item moves, and only within the frontier band).
 *   4. Round-trip: segment counts always sum to items.length and slicing
 *      `items` by them reconstructs it.
 *   5. A randomized (seeded, dependency-free) property sweep over both
 *      invariants across many configurations, including all-review and
 *      all-frontier size-6 sessions.
 */
import { describe, expect, test } from "vitest";
import { composeSegments, type ComposeSegmentsOptions, type SegmentKind } from "../practice/segments";
import type { ServedItem } from "../practice/session";
import { MANIPULATIVE_ANSWER_TYPE } from "../../../lib/manipulative/practiceContract";
import { makeRng } from "../practice/templates";

function item(overrides: Partial<ServedItem> & { skillKey: string }): ServedItem {
  return {
    itemId: `${overrides.skillKey}#${Math.random()}`,
    skillLabel: overrides.skillKey,
    stem: "2 + 2",
    answerType: "integer",
    ...overrides,
  };
}

function manipulative(skillKey: string, lane: ServedItem["lane"] = "new"): ServedItem {
  return item({ skillKey, answerType: MANIPULATIVE_ANSWER_TYPE, lane });
}

function drill(skillKey: string, lane: ServedItem["lane"] = "new", domain?: string): ServedItem {
  return item({ skillKey, lane, domain });
}

const CHOICE_HINT = { domain: "whole-number-arithmetic", strand: "counting" };

function baseOpts(overrides: Partial<ComposeSegmentsOptions> = {}): ComposeSegmentsOptions {
  return {
    choiceHint: undefined,
    strandByKey: new Map(),
    stampDomain: false,
    ...overrides,
  };
}

// ── 1. Kind classification ──────────────────────────────────────────────────

describe("kindOf (via composeSegments' resulting segments)", () => {
  test("a manipulative-answer-type item is always 'manipulative', even under a matching choiceHint", () => {
    const strandByKey = new Map([["place_value", "counting"]]);
    const { segments } = composeSegments(
      [manipulative("place_value")],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "manipulative", count: 1 }]);
  });

  test("a NEW-lane item whose strand matches choiceHint is 'choice'", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const { segments } = composeSegments(
      [drill("skip_count_by_2", "new")],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "choice", count: 1 }]);
  });

  test("a REVIEW-lane item is never 'choice' even if its strand matches — reviews are never optional", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const { segments } = composeSegments(
      [drill("skip_count_by_2", "review")],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "core_drill", count: 1 }]);
  });

  test("a NEW-lane item in a non-matching strand is plain 'core_drill'", () => {
    const strandByKey = new Map([["long_division", "division"]]);
    const { segments } = composeSegments(
      [drill("long_division", "new")],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "core_drill", count: 1 }]);
  });

  test("without a choiceHint, no item is ever 'choice'", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const { segments } = composeSegments(
      [drill("skip_count_by_2", "new")],
      baseOpts({ choiceHint: undefined, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "core_drill", count: 1 }]);
  });

  test("stampDomain: a matching strand in the WRONG domain is not 'choice' (cross-domain strand-name collision)", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const { segments } = composeSegments(
      [drill("skip_count_by_2", "new", "fraction-arithmetic")],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey, stampDomain: true }),
    );
    expect(segments).toEqual([{ kind: "core_drill", count: 1 }]);
  });

  test("stampDomain: a matching strand in the RIGHT domain IS 'choice'", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const { segments } = composeSegments(
      [drill("skip_count_by_2", "new", "whole-number-arithmetic")],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey, stampDomain: true }),
    );
    expect(segments).toEqual([{ kind: "choice", count: 1 }]);
  });

  // ── stretch (challenge-lane items) ──────────────────────────────────────
  test("a challenge-lane item is always 'stretch'", () => {
    const { segments } = composeSegments(
      [item({ skillKey: "frontier_hard", lane: "challenge" })],
      baseOpts(),
    );
    expect(segments).toEqual([{ kind: "stretch", count: 1 }]);
  });

  test("a fluent-node stretch item is also the 'stretch' beat", () => {
    const { segments } = composeSegments(
      [item({ skillKey: "owned_hard", lane: "stretch" })],
      baseOpts(),
    );
    expect(segments).toEqual([{ kind: "stretch", count: 1 }]);
  });

  test("a challenge-lane item is 'stretch' even when a choiceHint is present", () => {
    const strandByKey = new Map([["frontier_hard", "counting"]]);
    const { segments } = composeSegments(
      [item({ skillKey: "frontier_hard", lane: "challenge" })],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "stretch", count: 1 }]);
  });

  test("a challenge-lane manipulative item is 'manipulative' — manipulative answer type takes priority for rendering", () => {
    const { segments } = composeSegments(
      [item({ skillKey: "manip_hard", lane: "challenge", answerType: MANIPULATIVE_ANSWER_TYPE })],
      baseOpts(),
    );
    // manipulative answer type is checked first (UI-rendering concern); the
    // item still belongs to the challenge tail but renders as a toolbox item.
    expect(segments).toEqual([{ kind: "manipulative", count: 1 }]);
  });

  test("non-challenge-lane items are NOT 'stretch' — 'review' lane stays 'core_drill'", () => {
    const { segments } = composeSegments([drill("rev_skill", "review")], baseOpts());
    expect(segments[0].kind).not.toBe("stretch");
  });

  test("non-challenge-lane items are NOT 'stretch' — 'new' lane stays 'core_drill'", () => {
    const { segments } = composeSegments([drill("new_skill", "new")], baseOpts());
    expect(segments[0].kind).not.toBe("stretch");
  });

  test("mixed challenge + non-challenge items: challenge items become 'stretch', others keep their kind", () => {
    const items = [
      drill("rev_skill", "review"),
      item({ skillKey: "chal_skill", lane: "challenge" }),
      drill("new_skill", "new"),
    ];
    const { items: composed, segments } = composeSegments(items, baseOpts());
    // We don't assert the exact order (anti-slog may reorder within the frontier band),
    // but every challenge item must produce a stretch segment.
    const stretchItems = composed.filter((it) => it.lane === "challenge");
    expect(stretchItems.length).toBe(1);
    const totalStretchCount = segments.filter((s) => s.kind === "stretch").reduce((n, s) => n + s.count, 0);
    expect(totalStretchCount).toBe(1);
  });

  // ── fact sprint ("Fast math") ───────────────────────────────────────────
  const factItem = (skillKey: string, factKey: string): ServedItem =>
    item({ skillKey, lane: "new", isFactSprint: true, factKey });

  test("an isFactSprint item is 'fact_sprint' regardless of lane", () => {
    const { segments } = composeSegments([factItem("mult_facts_7_8_9", "mul:7x8")], baseOpts());
    expect(segments).toEqual([{ kind: "fact_sprint", count: 1 }]);
  });

  test("fact_sprint takes priority over a matching choiceHint strand", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const { segments } = composeSegments(
      [item({ skillKey: "skip_count_by_2", lane: "new", isFactSprint: true, factKey: "add:2+2" })],
      baseOpts({ choiceHint: CHOICE_HINT, strandByKey }),
    );
    expect(segments).toEqual([{ kind: "fact_sprint", count: 1 }]);
  });

  test("a contiguous run of fact-sprint items collapses into ONE 'fact_sprint' beat", () => {
    const items = [
      factItem("mult_facts_7_8_9", "mul:7x8"),
      factItem("mult_facts_7_8_9", "mul:8x9"),
      factItem("mult_facts_7_8_9", "mul:7x9"),
    ];
    const { segments } = composeSegments(items, baseOpts());
    expect(segments).toEqual([{ kind: "fact_sprint", count: 3 }]);
  });

  test("a fact-sprint block stays its own beat, distinct from surrounding core drills", () => {
    const items = [
      factItem("mult_facts_7_8_9", "mul:7x8"),
      factItem("mult_facts_7_8_9", "mul:8x9"),
      drill("long_division", "new"),
    ];
    const { items: composed, segments } = composeSegments(items, baseOpts());
    // The sprint items form one contiguous fact_sprint segment; the drill is its own.
    const sprintCount = segments
      .filter((s) => s.kind === "fact_sprint")
      .reduce((n, s) => n + s.count, 0);
    expect(sprintCount).toBe(2);
    const sprintComposed = composed.filter((it) => it.isFactSprint);
    expect(sprintComposed.length).toBe(2);
    expect(segments.some((s) => s.kind === "core_drill")).toBe(true);
  });
});

// ── 2. Round-trip: counts sum to items.length, reconstructable ─────────────

describe("segment round-trip", () => {
  test("segment counts sum to items.length and reconstruct the composed items in order", () => {
    const items = [
      drill("a", "review"),
      manipulative("b", "review"),
      drill("c", "new"),
      manipulative("d", "new"),
      drill("e", "new"),
      drill("f", "new"),
    ];
    const { items: composed, segments } = composeSegments(items, baseOpts());
    const total = segments.reduce((sum, s) => sum + s.count, 0);
    expect(total).toBe(composed.length);

    let offset = 0;
    for (const seg of segments) {
      const slice = composed.slice(offset, offset + seg.count);
      for (const it of slice) {
        const isManip = it.answerType === MANIPULATIVE_ANSWER_TYPE;
        expect(seg.kind).toBe(isManip ? "manipulative" : "core_drill");
      }
      offset += seg.count;
    }
  });

  test("empty items → empty segments", () => {
    expect(composeSegments([], baseOpts())).toEqual({ items: [], segments: [] });
  });
});

// ── 3. Anti-slog: adjacent runs of the same kind always merge ─────────────

describe("anti-slog — same-kind adjacency", () => {
  test("all-core_drill items collapse to ONE segment (never several identical back-to-back)", () => {
    const items = [drill("a"), drill("b"), drill("c"), drill("d"), drill("e"), drill("f")];
    const { segments } = composeSegments(items, baseOpts());
    expect(segments).toEqual([{ kind: "core_drill", count: 6 }]);
  });

  test("alternating kinds within one band stay alternating (already anti-slog-clean)", () => {
    const items = [drill("a"), manipulative("b"), drill("c"), manipulative("d")];
    const { segments } = composeSegments(items, baseOpts());
    expect(segments.map((s) => s.kind)).toEqual(["core_drill", "manipulative", "core_drill", "manipulative"]);
    expect(segments.every((s) => s.count === 1)).toBe(true);
  });

  test("a review/frontier boundary clash IS resolved by moving the nearest differently-kinded frontier item to the front", () => {
    // Review band: 2 plain drills (core_drill). Frontier band: drill, drill,
    // THEN a manipulative — without a fix this would produce
    // core_drill(2 review) directly followed by core_drill(2 frontier): two
    // adjacent segments of the same kind. The composer should instead pull the
    // manipulative to the front of the frontier band.
    const items = [
      drill("r1", "review"),
      drill("r2", "review"),
      drill("f1", "new"),
      drill("f2", "new"),
      manipulative("f3", "new"),
    ];
    const { items: composed, segments } = composeSegments(items, baseOpts());
    expect(segments.map((s) => s.kind)).toEqual(["core_drill", "manipulative", "core_drill"]);
    expect(segments.map((s) => s.count)).toEqual([2, 1, 2]);
    // The review band's own order is untouched (still r1, r2 first).
    expect(composed.slice(0, 2).map((it) => it.skillKey)).toEqual(["r1", "r2"]);
    // The manipulative moved to the FRONT of the frontier band; f1/f2 keep
    // their relative order after it.
    expect(composed.slice(2).map((it) => it.skillKey)).toEqual(["f3", "f1", "f2"]);
  });

  test("CANNOT guarantee a fix when the frontier band is kind-homogeneous and matches the review band's kind — documented limitation", () => {
    // Review band: core_drill. Frontier band: ALSO all core_drill (no
    // manipulative/choice item was served this session) — nothing to swap in.
    const items = [
      drill("r1", "review"),
      drill("f1", "new"),
      drill("f2", "new"),
      drill("f3", "new"),
    ];
    const { segments } = composeSegments(items, baseOpts());
    // The clash is left in place rather than papering over it: TWO adjacent
    // core_drill segments (1 review + 3 frontier), not one merged run — the
    // composer never reorders across the review/frontier boundary itself.
    expect(segments).toEqual([
      { kind: "core_drill", count: 1 },
      { kind: "core_drill", count: 3 },
    ]);
  });

  test("all-review session (empty frontier floor) — no boundary, segments over the review band alone", () => {
    const items = [drill("r1", "review"), drill("r2", "review"), manipulative("r3", "review")];
    const { segments } = composeSegments(items, baseOpts());
    expect(segments).toEqual([
      { kind: "core_drill", count: 2 },
      { kind: "manipulative", count: 1 },
    ]);
  });

  test("size-6 edge case: all reviews, all one kind → a single segment", () => {
    const items = Array.from({ length: 6 }, (_, i) => drill(`r${i}`, "review"));
    const { segments } = composeSegments(items, baseOpts());
    expect(segments).toEqual([{ kind: "core_drill", count: 6 }]);
  });

  test("size-6 edge case: no reviews at all (a fresh-frontier / scoped session)", () => {
    const strandByKey = new Map([["skip_count_by_2", "counting"]]);
    const items = [
      drill("skip_count_by_2", "new"),
      drill("f1", "new"),
      manipulative("f2", "new"),
      drill("f3", "new"),
      drill("f4", "new"),
      drill("f5", "new"),
    ];
    const { segments } = composeSegments(items, baseOpts({ choiceHint: CHOICE_HINT, strandByKey }));
    expect(segments.map((s) => s.kind)).toEqual(["choice", "core_drill", "manipulative", "core_drill"]);
    expect(segments.reduce((n, s) => n + s.count, 0)).toBe(6);
  });
});

// ── 4. Priority preservation ────────────────────────────────────────────────

describe("priority preservation", () => {
  test("the review band's relative order is NEVER reordered", () => {
    const items = [
      drill("r3", "review"),
      manipulative("r1", "review"),
      drill("r2", "review"),
      drill("f1", "new"),
    ];
    const { items: composed } = composeSegments(items, baseOpts());
    expect(composed.slice(0, 3).map((it) => it.skillKey)).toEqual(["r3", "r1", "r2"]);
  });

  test("every review item is served strictly before every frontier item", () => {
    const items = [
      drill("f1", "new"),
      drill("r1", "review"),
      manipulative("f2", "new"),
      drill("r2", "review"),
    ];
    const { items: composed } = composeSegments(items, baseOpts());
    const laneOrder = composed.map((it) => it.lane);
    const firstNonReview = laneOrder.findIndex((l) => l !== "review");
    if (firstNonReview >= 0) {
      expect(laneOrder.slice(firstNonReview).every((l) => l !== "review")).toBe(true);
    }
  });

  test("at most ONE frontier item changes position (the rest keep their relative order)", () => {
    const items = [
      drill("r1", "review"),
      drill("f1", "new"),
      drill("f2", "new"),
      manipulative("f3", "new"),
      drill("f4", "new"),
    ];
    const before = ["f1", "f2", "f3", "f4"];
    const { items: composed } = composeSegments(items, baseOpts());
    const after = composed.slice(1).map((it) => it.skillKey);
    expect(after).not.toEqual(before); // the fix DID move something
    // Removing whichever single element moved to the front should restore the
    // original relative order of everything else.
    const moved = after[0];
    const rest = after.slice(1);
    expect(rest).toEqual(before.filter((k) => k !== moved));
  });
});

// ── 5. Randomized property sweep (seeded, dependency-free) ────────────────

function bandOf(it: ServedItem): "review" | "other" {
  return it.lane === "review" ? "review" : "other";
}

function kindOfForTest(it: ServedItem, opts: ComposeSegmentsOptions): SegmentKind {
  if (it.answerType === MANIPULATIVE_ANSWER_TYPE) return "manipulative";
  if (it.lane === "challenge" || it.lane === "stretch") return "stretch";
  if (opts.choiceHint && it.lane === "new") {
    const strand = opts.strandByKey.get(it.skillKey);
    if (strand && strand === opts.choiceHint.strand) return "choice";
  }
  return "core_drill";
}

/** Generate a random size-6 (or given size) fixture: each item independently
 *  gets a random lane ("review" | "new") and kind-shaping traits (manipulative
 *  answerType, or a strand that may or may not match the fixed choiceHint). */
function randomFixture(seed: number, size = 6): { items: ServedItem[]; opts: ComposeSegmentsOptions } {
  const rng = makeRng(seed);
  const strandByKey = new Map<string, string>();
  const items: ServedItem[] = [];
  for (let i = 0; i < size; i++) {
    const key = `s${i}_${seed}`;
    const lane: ServedItem["lane"] = rng.int(0, 1) === 0 ? "review" : "new";
    const isManip = rng.int(0, 2) === 0; // ~1/3 manipulative
    const isChoiceStrand = !isManip && rng.int(0, 2) === 0; // ~1/3 of the remainder
    if (isChoiceStrand) strandByKey.set(key, CHOICE_HINT.strand);
    items.push(
      isManip ? manipulative(key, lane) : drill(key, lane),
    );
  }
  return { items, opts: baseOpts({ choiceHint: CHOICE_HINT, strandByKey }) };
}

describe("property sweep — composeSegments over many random size-6 sessions", () => {
  for (let seed = 0; seed < 200; seed++) {
    test(`seed ${seed}: preserves the multiset, review order, and the boundary-only anti-slog guarantee`, () => {
      const { items, opts } = randomFixture(seed);
      const { items: composed, segments } = composeSegments(items, opts);

      // Round-trip: same items (by itemId), same length.
      expect(composed.length).toBe(items.length);
      expect(new Set(composed.map((it) => it.itemId))).toEqual(new Set(items.map((it) => it.itemId)));
      expect(segments.reduce((n, s) => n + s.count, 0)).toBe(composed.length);

      // Priority preservation: the review band is an exact, untouched prefix.
      const originalReview = items.filter((it) => bandOf(it) === "review");
      const composedReview = composed.filter((it) => bandOf(it) === "review");
      expect(composedReview.map((it) => it.itemId)).toEqual(originalReview.map((it) => it.itemId));
      expect(composed.slice(0, originalReview.length).every((it) => bandOf(it) === "review")).toBe(true);

      // At most one frontier ("other") item ever changes position relative to
      // the original frontier order.
      const originalOther = items.filter((it) => bandOf(it) === "other").map((it) => it.itemId);
      const composedOther = composed.filter((it) => bandOf(it) === "other").map((it) => it.itemId);
      let moves = 0;
      {
        // Count minimal single-element-move distance: is composedOther equal
        // to originalOther with at most one element relocated to the front?
        if (composedOther.join() !== originalOther.join()) {
          moves = 1;
          const movedId = composedOther[0];
          const rest = composedOther.slice(1);
          expect(rest).toEqual(originalOther.filter((id) => id !== movedId));
        }
      }
      expect(moves).toBeLessThanOrEqual(1);

      // Anti-slog: any adjacent-same-kind segment pair can ONLY occur at the
      // review→frontier boundary segment index, and ONLY when the frontier
      // band is kind-homogeneous and matches the review band's trailing kind.
      for (let i = 1; i < segments.length; i++) {
        if (segments[i].kind !== segments[i - 1].kind) continue;
        // A violation exists — verify it is the documented, unavoidable one.
        const reviewKinds = new Set(originalReview.map((_id, idx) => kindOfForTest(originalReview[idx], opts)));
        const otherKinds = new Set(items.filter((it) => bandOf(it) === "other").map((it) => kindOfForTest(it, opts)));
        expect(originalReview.length).toBeGreaterThan(0);
        expect(items.filter((it) => bandOf(it) === "other").length).toBeGreaterThan(0);
        expect(otherKinds.size).toBe(1); // frontier band is kind-homogeneous
        expect(reviewKinds.has([...otherKinds][0])).toBe(true); // and clashes with reviews
      }
    });
  }
});
