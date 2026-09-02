import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../../schema";
import { api, internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import {
  gradeTryItAtom,
  instructionVideoEmbedUrl,
  instructionWritesFor,
  isStrandInstructionKey,
  shouldRecordInstruction,
  strandInstructionKey,
  tryItFade,
  type InstructionAtom,
} from "../instructionEntries";
import { isSolved, type PartitionState } from "../../../../lib/manipulative/logic";
import type { ManipulativeSpec, PartitionSpec } from "../../../../lib/manipulative/types";

// Lane 2 — the two INTERACTIVE atoms + the Rehearse write policy, exercised
// through their pure seams (the client graders never touch a `ctx`) AND through
// the real Convex tables to assert ZERO writes from Rehearse / from the atoms.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../../**/*.ts");

// The mutation-capable client type — satisfied by both `convexTest(...)` and its
// `.withIdentity(...)` (scholar) view, so a driver helper accepts either.
type TestClient = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;

describe("tryItFade — the final answer-producing step is hidden (does NOT show verbatim)", () => {
  test("reveals all but the last step; the faded step carries only a blank", () => {
    const steps = ["30 x 6 = 180", "4 x 6 = 24", "180 + 24 = 204"];
    const fade = tryItFade(steps);
    // All but the last are revealed verbatim…
    expect(fade.revealed.map((r) => r.text)).toEqual(["30 x 6 = 180", "4 x 6 = 24"]);
    // …the answer-producing last step is faded to a blank, its text never emitted.
    expect(fade.faded).toEqual([{ blankText: "___" }]);
    const revealedText = fade.revealed.map((r) => r.text).join(" | ");
    expect(revealedText).not.toContain("204");
    expect(revealedText).not.toContain("180 + 24");
    expect(fade.selfExplainPrompt).toBeTruthy();
  });

  test("a single-step try_it fades that step (no revealed leak, still renders via showWhenOnlyFaded)", () => {
    const fade = tryItFade(["1 + 1 = 2"]);
    expect(fade.revealed).toEqual([]);
    expect(fade.faded).toEqual([{ blankText: "___" }]);
    expect(fade.selfExplainPrompt).toBeUndefined();
  });
});

describe("gradeTryItAtom — client-graded faded step (records nothing)", () => {
  test("integer default matches exact + rejects wrong", () => {
    const atom: InstructionAtom = {
      kind: "try_it",
      strategyLabel: "Add the partial products",
      steps: ["20 × 7 = 140", "3 × 7 = 21", "Add them"],
      examplePrompt: "23 × 7 = ?",
      exampleAnswer: "161",
    };
    expect(gradeTryItAtom("161", atom)).toBe(true);
    expect(gradeTryItAtom(" 161 ", atom)).toBe(true); // trims
    expect(gradeTryItAtom("160", atom)).toBe(false);
    expect(gradeTryItAtom("", atom)).toBe(false);
  });

  test("uses the SAME representation-tolerant path (6/8 ≡ 3/4)", () => {
    const atom = {
      kind: "try_it" as const,
      strategyLabel: "Reduce",
      steps: ["Divide top and bottom by 2"],
      examplePrompt: "Simplify 6/8",
      exampleAnswer: "3/4",
      answerType: "fraction" as const,
    };
    expect(gradeTryItAtom("6/8", atom)).toBe(true);
    expect(gradeTryItAtom("3/4", atom)).toBe(true);
    expect(gradeTryItAtom("1/2", atom)).toBe(false);
  });
});

describe("instructionVideoEmbedUrl — one clipped privacy-enhanced player URL", () => {
  test("includes the authored clip bounds and required player policy", () => {
    expect(
      instructionVideoEmbedUrl({
        videoId: "dQw4w9WgXcQ",
        startSec: 30,
        endSec: 150,
      }),
    ).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" +
        "?start=30&end=150&playsinline=1&rel=0" +
        "&iv_load_policy=3&disablekb=1&color=white" +
        "&cc_load_policy=1&cc_lang_pref=en",
    );
  });

  test("strips the player chrome that would pull a scholar out of the clip", () => {
    const url = instructionVideoEmbedUrl({
      videoId: "dQw4w9WgXcQ",
      startSec: 0,
      endSec: 60,
    });
    // Annotations/cards off, keyboard shortcuts off, related videos limited to
    // the source channel, captions forced on in English.
    expect(url).toContain("iv_load_policy=3");
    expect(url).toContain("disablekb=1");
    expect(url).toContain("rel=0");
    expect(url).toContain("cc_load_policy=1");
    // `modestbranding` has been a no-op since 2023 — never re-add it as if it
    // did something.
    expect(url).not.toContain("modestbranding");
    // Controls stay ON: a scholar must be able to pause and re-watch.
    expect(url).not.toContain("controls=0");
  });
});

describe("shouldRecordInstruction — Rehearse writes nothing", () => {
  test("preview (teacher play-it) records nothing even with a scholarId", () => {
    expect(shouldRecordInstruction({ preview: true, scholarId: "u1" })).toBe(false);
  });
  test("no scholar subject → records nothing", () => {
    expect(shouldRecordInstruction({ preview: false, scholarId: null })).toBe(false);
    expect(shouldRecordInstruction({ scholarId: undefined })).toBe(false);
  });
  test("only a real scholar view records", () => {
    expect(shouldRecordInstruction({ preview: false, scholarId: "u1" })).toBe(true);
  });
});

describe("instructionWritesFor — the card's write plan (single source of truth)", () => {
  test("a real scholar's plan names each mutation in call order", () => {
    const o = { preview: false, scholarId: "u1" };
    expect(instructionWritesFor("mount", o)).toEqual([{ type: "claimShown" }]);
    expect(instructionWritesFor("tryFirst", o)).toEqual([{ type: "recordChoice", choice: "try" }]);
    expect(instructionWritesFor("showMe", o)).toEqual([
      { type: "recordChoice", choice: "show" },
      { type: "recordViewed" },
    ]);
    expect(instructionWritesFor("nowYouTry", o)).toEqual([{ type: "recordCompleted" }]);
  });
  test("preview OR no-scholar yields an EMPTY plan for every event (card invokes nothing)", () => {
    for (const event of ["mount", "tryFirst", "showMe", "nowYouTry"] as const) {
      expect(instructionWritesFor(event, { preview: true, scholarId: "u1" })).toEqual([]);
      expect(instructionWritesFor(event, { preview: false, scholarId: null })).toEqual([]);
    }
  });
});

describe("isStrandInstructionKey — strand doorway vs node grain", () => {
  test("strand keys pass; node keys are excluded from strand coverage", () => {
    expect(isStrandInstructionKey(strandInstructionKey("whole-number-arithmetic", "multiply"))).toBe(true);
    expect(isStrandInstructionKey("node:wna.multiply.2x1")).toBe(false);
    expect(isStrandInstructionKey("")).toBe(false);
  });
});

describe("manipulative atom — reuses the EXISTING spec + isSolved, ungraded", () => {
  const partition: PartitionSpec = {
    kind: "partition",
    id: "lp-partition",
    concept: "Equivalent fractions",
    prompt: "Shade one half.",
    discs: [{ parts: 4, shaded: 1 }],
    adjustable: ["parts", "shaded"],
    goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
  };

  test("an atom's spec is a JSON ManipulativeSpec (same shape as practiceItems)", () => {
    const atom: InstructionAtom = { kind: "manipulative", spec: JSON.stringify(partition) };
    const parsed = JSON.parse(atom.spec) as ManipulativeSpec;
    expect(parsed.kind).toBe("partition");
  });

  test("isSolved runs on the parsed spec for the client-side 'you did it' moment", () => {
    const spec = JSON.parse(JSON.stringify(partition)) as ManipulativeSpec;
    const solved: PartitionState = { discs: [{ parts: 4, shaded: 2 }] }; // 2/4 = 1/2
    const unsolved: PartitionState = { discs: [{ parts: 4, shaded: 1 }] };
    expect(isSolved(spec, solved)).toBe(true);
    expect(isSolved(spec, unsolved)).toBe(false);
  });
});

// ── ZERO-WRITE invariants, DRIVEN through the card's real write seam ─────────
// The card derives every lifecycle write from `instructionWritesFor` (the SAME
// function `LaunchpadCard.runWrites` consults). These tests execute that plan
// against the REAL Convex mutations — a faithful stand-in for driving the card —
// and assert the write tables (`instructionEvents` offer rows + retrievals,
// `practiceMastery`) are empty after a Rehearse (preview) and after doing either
// interactive atom, while a real scholar view DOES populate them (so the check
// isn't vacuous). If the plan is empty (preview / no scholar) NO mutation is
// invoked at all — the mutation-facing proof the review asked for.

const DOMAIN = "whole-number-arithmetic";
const STRAND = "multiply";
const KEY = strandInstructionKey(DOMAIN, STRAND);

async function seedScholar(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Ada", username: "ada-atoms", role: "scholar" }),
  );
}
async function asScholar(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}
async function allEvents(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("instructionEvents").collect() as Promise<Doc<"instructionEvents">[]>);
}
async function storeContent(t: ReturnType<typeof convexTest>) {
  await t.mutation(internal.instruction.storeInstructionContent, {
    domain: DOMAIN,
    strand: STRAND,
    title: "Multiplying by breaking apart",
    atoms: [
      { kind: "micro_explain", text: "Break the number apart, multiply each part." },
      {
        kind: "worked_example",
        strategyLabel: "Partial products",
        steps: ["20 x 7 = 140", "3 x 7 = 21", "140 + 21"],
        examplePrompt: "23 x 7 = ?",
        exampleAnswer: "161",
      },
    ],
    provenance: "authored",
  });
}

/**
 * Execute the card's write plan for a UI event exactly as `LaunchpadCard`'s
 * `runWrites` does: consult `instructionWritesFor`, then invoke the matching
 * REAL mutation for each planned write. Counts the invocations so a test can
 * assert ZERO mutations fire in preview mode. `t` is the caller's identity
 * (scholar for the real path; the plan is empty for preview so identity is moot).
 */
async function driveCardEvent(
  t: TestClient,
  event: "mount" | "tryFirst" | "showMe" | "nowYouTry",
  opts: { preview?: boolean; scholarId: Id<"users"> | null; key: string },
): Promise<number> {
  const plan = instructionWritesFor(event, opts);
  let invoked = 0;
  for (const w of plan) {
    invoked++;
    if (!opts.scholarId) continue;
    if (w.type === "claimShown") {
      await t.mutation(api.instruction.claimInstructionShown, { scholarId: opts.scholarId, key: opts.key });
    } else if (w.type === "recordChoice") {
      await t.mutation(api.instruction.recordInstructionChoice, {
        scholarId: opts.scholarId,
        key: opts.key,
        choice: w.choice,
      });
    } else if (w.type === "recordViewed") {
      await t.mutation(api.instruction.recordInstructionViewed, { scholarId: opts.scholarId, key: opts.key });
    } else if (w.type === "recordCompleted") {
      await t.mutation(api.instruction.recordInstructionCompleted, { scholarId: opts.scholarId, key: opts.key });
    }
  }
  return invoked;
}

describe("Rehearse writes NOTHING — driven through the card's real write seam", () => {
  test("a REAL scholar walking mount → show → now-you-try populates the ledger (control)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asAda = await asScholar(t, scholarId);
    await storeContent(t);

    // Drive the scholar path event-by-event, exactly as the card would.
    expect(await driveCardEvent(asAda, "mount", { scholarId, key: KEY })).toBe(1);
    expect(await driveCardEvent(asAda, "showMe", { scholarId, key: KEY })).toBe(2); // choice + viewed
    expect(await driveCardEvent(asAda, "nowYouTry", { scholarId, key: KEY })).toBe(1);

    const rows = (await allEvents(t)).filter((r) => r.key === KEY);
    expect(rows.length).toBe(1);
    expect(rows[0].shownAt).toBeTruthy();
    expect(rows[0].initialChoice).toBe("show");
    expect(rows[0].viewedAt).toBeTruthy();
    expect(rows[0].completedAt).toBeTruthy();
  });

  test("a Rehearse (preview) walking the SAME path invokes ZERO mutations and leaves instructionEvents empty", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asAda = await asScholar(t, scholarId);
    await storeContent(t);

    // Preview: the plan is empty for every event, so no mutation is even called.
    for (const event of ["mount", "tryFirst", "showMe", "nowYouTry"] as const) {
      expect(instructionWritesFor(event, { preview: true, scholarId })).toEqual([]);
      const invoked = await driveCardEvent(asAda, event, { preview: true, scholarId, key: KEY });
      expect(invoked).toBe(0);
    }
    // No offer row, no retrievals anywhere — the ledger is untouched by Rehearse.
    const rows = await allEvents(t);
    expect(rows).toEqual([]);
    expect(rows.flatMap((r) => r.retrievals ?? [])).toEqual([]);
  });

  test("a preview card with NO scholar subject also invokes zero mutations", async () => {
    const t = convexTest(schema, modules);
    await storeContent(t);
    for (const event of ["mount", "tryFirst", "showMe", "nowYouTry"] as const) {
      expect(instructionWritesFor(event, { scholarId: null })).toEqual([]);
      const invoked = await driveCardEvent(t, event, { scholarId: null, key: KEY });
      expect(invoked).toBe(0);
    }
    expect(await allEvents(t)).toEqual([]);
  });

  test("doing either interactive atom (grade / solve) writes NO practiceMastery row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);

    // The atoms' ONLY graders are ctx-free pure functions — exercise both.
    expect(gradeTryItAtom("204", { exampleAnswer: "204", answerType: "integer" })).toBe(true);
    const spec = JSON.parse(
      JSON.stringify({
        kind: "partition",
        id: "p",
        concept: "Equivalent fractions",
        prompt: "Shade one half.",
        discs: [{ parts: 4, shaded: 1 }],
        adjustable: ["parts", "shaded"],
        goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
      }),
    ) as ManipulativeSpec;
    expect(isSolved(spec, { discs: [{ parts: 4, shaded: 2 }] } as PartitionState)).toBe(true);

    const mastery = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .filter((q) => q.eq(q.field("scholarId"), scholarId))
        .collect(),
    );
    expect(mastery).toEqual([]);
  });
});
