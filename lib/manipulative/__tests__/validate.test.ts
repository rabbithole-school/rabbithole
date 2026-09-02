/**
 * Validation-gate tests for `validateManipulativeSpec` — the governance seam the
 * show_manipulative tool routes every spec through. Proves the two-stage gate:
 * a spec must be RENDERABLE (structural fields + prompt), and — only if it
 * claims a `goal`/`answer` — also GRADABLE. Goal-less specs are valid free
 * exploration and pass without a gradability check.
 */
import { describe, expect, it } from "vitest";
import { parseStoredManipulativeArtifact, validateManipulativeSpec } from "../validate";

describe("validateManipulativeSpec", () => {
  it("accepts a goal-less rekenrek exploration sandbox", () => {
    const result = validateManipulativeSpec({
      kind: "rekenrek",
      id: "manip-rk-1",
      concept: "Number bonds",
      prompt: "Push beads into two groups. Which pairs make 10?",
      total: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.kind).toBe("rekenrek");
  });

  it("accepts a numberline WITH a usable goal", () => {
    const result = validateManipulativeSpec({
      kind: "numberline",
      id: "manip-nl-1",
      concept: "Fractions on a line",
      prompt: "Place 3/4 on the line.",
      min: 0,
      max: 1,
      tickStep: 0.25,
      start: 0,
      goal: { type: "placeFraction", num: 3, den: 4 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a spec missing its prompt, naming prompt", () => {
    const result = validateManipulativeSpec({
      kind: "rekenrek",
      id: "manip-rk-2",
      concept: "Number bonds",
      total: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("prompt");
  });

  it("rejects an unknown kind, listing the valid kinds", () => {
    const result = validateManipulativeSpec({
      kind: "hologram",
      id: "manip-x",
      prompt: "Do the thing.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("hologram");
      // Reason enumerates the closed set so the model can pick a real kind.
      expect(result.reason).toContain("rekenrek");
      expect(result.reason).toContain("numberline");
    }
  });

  it("rejects a structurally-broken spec (partition with no discs)", () => {
    // A well-shaped goal atop missing structural fields would crash the
    // renderer on mount (initialPartition(spec).discs.map) — caught here.
    const result = validateManipulativeSpec({
      kind: "partition",
      id: "manip-pt-1",
      concept: "Equivalence",
      prompt: "Make the two discs equal.",
      adjustable: ["shaded"],
      goal: { type: "discsEqualShadedArea" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a present-but-ungradable goal", () => {
    // A groupOf target larger than the bead total can never be reached, so
    // the self-check would never pass — reject rather than ship it unwinnable.
    const result = validateManipulativeSpec({
      kind: "rekenrek",
      id: "manip-rk-3",
      concept: "Number bonds",
      prompt: "Make a group of 99.",
      total: 5,
      goal: { type: "groupOf", value: 99 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a type-wrong structural field, naming the field and observed value", () => {
    // rekenrek total:"ten" casts fine but yields NaN beads — the driver for the
    // data-driven structural gate. The reason must name `rekenrek.total` and
    // quote the observed value so the tutor self-corrects.
    const result = validateManipulativeSpec({
      kind: "rekenrek",
      id: "manip-rk-4",
      concept: "Number bonds",
      prompt: "Push beads into two groups.",
      total: "ten",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("rekenrek.total");
      expect(result.reason).toContain('"ten"');
    }
  });

  it("rejects a spec missing its concept, naming concept", () => {
    // `concept` is REQUIRED in ManipulativeMeta — both frontends display it.
    const result = validateManipulativeSpec({
      kind: "rekenrek",
      id: "manip-rk-5",
      prompt: "Push beads into two groups.",
      total: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("concept");
  });

  it("rejects a functionMachine whose examples contradict its rule, naming the example", () => {
    // rule out = 2*in + 1, but examples[1] claims 3 → 8 (should be 7).
    const result = validateManipulativeSpec({
      kind: "functionMachine",
      id: "manip-fm-1",
      concept: "Function rules",
      prompt: "Study the machine, then predict the output for 5.",
      rule: { op: "affine", m: 2, b: 1 },
      examples: [
        { in: 1, out: 3 },
        { in: 3, out: 8 },
      ],
      queryInput: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("functionMachine.examples[1]");
    }
  });

  it("accepts a functionMachine whose examples are consistent with its rule", () => {
    const result = validateManipulativeSpec({
      kind: "functionMachine",
      id: "manip-fm-2",
      concept: "Function rules",
      prompt: "Study the machine, then predict the output for 5.",
      rule: { op: "affine", m: 2, b: 1 },
      examples: [
        { in: 1, out: 3 },
        { in: 3, out: 7 },
      ],
      queryInput: 5,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed top-level input", () => {
    expect(validateManipulativeSpec(null).ok).toBe(false);
    expect(validateManipulativeSpec("rekenrek").ok).toBe(false);
    expect(validateManipulativeSpec(42).ok).toBe(false);
    expect(validateManipulativeSpec({}).ok).toBe(false);
  });
});

describe("parseStoredManipulativeArtifact", () => {
  it("parses a well-formed stored envelope", () => {
    const stored = parseStoredManipulativeArtifact(
      JSON.stringify({
        v: 1,
        spec: { kind: "rekenrek", concept: "Number bonds", prompt: "Push beads.", total: 10 },
      }),
    );
    expect(stored?.v).toBe(1);
    expect(stored?.spec.kind).toBe("rekenrek");
  });

  it("returns null for a retired kind the current binary can't render", () => {
    // A stored row whose `kind` is no longer in the union (dotBlaster, the
    // retired Factor Game) must parse to null — never a blank, unsolvable frame.
    const stored = parseStoredManipulativeArtifact(
      JSON.stringify({
        v: 1,
        spec: { kind: "dotBlaster", concept: "Legacy", prompt: "Old model.", total: 10 },
      }),
    );
    expect(stored).toBeNull();
  });

  it("returns null for malformed / wrong-version content", () => {
    expect(parseStoredManipulativeArtifact("not json")).toBeNull();
    expect(parseStoredManipulativeArtifact(JSON.stringify({ v: 2, spec: {} }))).toBeNull();
    expect(parseStoredManipulativeArtifact(JSON.stringify({ v: 1 }))).toBeNull();
  });
});
