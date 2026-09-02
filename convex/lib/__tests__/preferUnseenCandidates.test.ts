/**
 * Pure-Vitest unit tests for the serve-time recent-item dedupe selector
 * (repeat-question fix §4): `preferUnseenCandidates` + `canonicalItemIdentity`
 * in lib/practice/session.ts.
 *
 * These are the load-bearing tests for the fix — the selector is a pure function
 * of (candidates, recentIdentities, count), so it's tested here without a DB.
 * A separate convex-test (practiceDedupe.test.ts) proves the identities are
 * actually threaded into `practiceSession`.
 */

import { describe, expect, test } from "vitest";
import {
  preferUnseenCandidates,
  canonicalItemIdentity,
  makeItemId,
} from "../practice/session";

type Cand = { itemId: string; tag?: string };
const c = (itemId: string, tag?: string): Cand => ({ itemId, tag });

// add_within_5 renders identity off its stem (no visual) and seeds 2 & 3
// deterministically render the SAME question — a real template stem collision.
const TEMPLATE_SKILL = "add_within_5";
const COLLIDING_SEED_A = 2;
const COLLIDING_SEED_B = 3;

describe("canonicalItemIdentity", () => {
  test("a stored/manipulative gen# id is its own identity", () => {
    expect(canonicalItemIdentity("gen#abc123")).toBe("gen#abc123");
  });

  test("two different template seeds that render the same stem collapse to one identity", () => {
    const idA = canonicalItemIdentity(makeItemId(TEMPLATE_SKILL, COLLIDING_SEED_A));
    const idB = canonicalItemIdentity(makeItemId(TEMPLATE_SKILL, COLLIDING_SEED_B));
    // The two item IDs differ...
    expect(makeItemId(TEMPLATE_SKILL, COLLIDING_SEED_A)).not.toBe(
      makeItemId(TEMPLATE_SKILL, COLLIDING_SEED_B),
    );
    // ...but their canonical (rendered) identity is the same.
    expect(idA).toBe(idB);
  });
});

describe("preferUnseenCandidates", () => {
  test("unseen candidates retain order and win over recent ones", () => {
    const candidates = [c("gen#A"), c("gen#B"), c("gen#C"), c("gen#D")];
    const recent = new Set([canonicalItemIdentity("gen#B")]);
    const out = preferUnseenCandidates(candidates, recent, 3);
    // B (recent) is deferred past the unseen A, C, D; A/C/D keep their order.
    expect(out.map((x) => x.itemId)).toEqual(["gen#A", "gen#C", "gen#D"]);
  });

  test("the same stored itemId is deferred", () => {
    const candidates = [c("gen#X"), c("gen#Y")];
    const recent = new Set([canonicalItemIdentity("gen#X")]);
    const out = preferUnseenCandidates(candidates, recent, 1);
    expect(out.map((x) => x.itemId)).toEqual(["gen#Y"]);
  });

  test("different template ids with the same stem identity are treated as duplicates", () => {
    // A candidate rendered from seed B is a dupe of a recent attempt on seed A
    // (same stem), so the unseen stored candidate is preferred instead.
    const candidates = [
      c(makeItemId(TEMPLATE_SKILL, COLLIDING_SEED_B), "template-dupe"),
      c("gen#fresh", "unseen"),
    ];
    const recent = new Set([
      canonicalItemIdentity(makeItemId(TEMPLATE_SKILL, COLLIDING_SEED_A)),
    ]);
    const out = preferUnseenCandidates(candidates, recent, 1);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("unseen");
  });

  test("when every candidate is recent, fallback still returns the requested count", () => {
    const candidates = [c("gen#A"), c("gen#B"), c("gen#C")];
    const recent = new Set([
      canonicalItemIdentity("gen#A"),
      canonicalItemIdentity("gen#B"),
      canonicalItemIdentity("gen#C"),
    ]);
    const out = preferUnseenCandidates(candidates, recent, 2);
    // Dedupe is a preference, never a starvation gate — still returns 2, in order.
    expect(out.map((x) => x.itemId)).toEqual(["gen#A", "gen#B"]);
  });

  test("a one-item node still returns its sole item even when recent", () => {
    const candidates = [c("gen#only")];
    const recent = new Set([canonicalItemIdentity("gen#only")]);
    expect(preferUnseenCandidates(candidates, recent, 1).map((x) => x.itemId)).toEqual([
      "gen#only",
    ]);
    // And when asked for more than exists, still just the one item.
    expect(preferUnseenCandidates(candidates, recent, 3).map((x) => x.itemId)).toEqual([
      "gen#only",
    ]);
  });

  test("empty recent history preserves the current output exactly", () => {
    const candidates = [c("gen#A"), c("gen#B"), c("gen#C"), c("gen#D")];
    const out = preferUnseenCandidates(candidates, new Set<string>(), 2);
    expect(out).toEqual(candidates.slice(0, 2));
  });

  test("count <= 0 returns nothing", () => {
    expect(preferUnseenCandidates([c("gen#A")], new Set<string>(), 0)).toEqual([]);
  });
});
