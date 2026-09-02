/**
 * Unit tests for the NON-LLM parts of the /story-open surface (the wonder-opening
 * Socratic conversation behind a world-connection story). The prompt VOICE is
 * measured separately by evals/spot-eval/story-open.ts (that needs a live model);
 * here we lock the deterministic machinery the endpoint depends on:
 *
 *   1. story lookup by (fromKey, toKey) via internal.edgeStories.storyOpenContext,
 *      including the auth gate (self allowed, a different scholar Forbidden, a
 *      teacher allowed) and the narrow packet it returns;
 *   2. a 404-shaped `null` when the bridge edge carries no story;
 *   3. the pure turn-cap logic (storyOpenTurnState / storyOpenEndsAfterReply);
 *   4. transcript upsert idempotency (recordTutorTranscript coalesces a
 *      growing conversation into ONE row) + the dedup-key contract.
 *
 * Mirrors the convex-test setup in storySeeding.test.ts. Does NOT edit any
 * existing test file.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  storyOpenTurnState,
  storyOpenEndsAfterReply,
  storyOpenDedupKey,
  STORY_OPEN_MAX_ASSISTANT_TURNS,
} from "../lib/practice/storyOpen";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Msg = { role: "user" | "assistant"; content: string };

const STORY = {
  kind: "instantiates" as const,
  hook: "Cicadas that count in primes",
  narrative:
    "Periodical cicadas stay underground 13 or 17 years, then a whole brood surfaces at once — and both cycle lengths are prime.",
  probe:
    "A 12-year cicada meets a predator on a 4-year cycle every time it comes up. How often would a 13-year cicada meet it?",
  source: "Magicicada spp.; predator-satiation hypothesis",
  provenance: "registry" as const,
  updatedAt: 1,
};

/** Insert a scholar, the two graph nodes, and a bridge edge (optionally with the
 *  story). Returns the ids the tests need. */
async function seedEdge(
  t: ReturnType<typeof convexTest>,
  opts: { withStory: boolean; readingLevel?: string } = { withStory: true },
): Promise<{ scholarId: Id<"users">; fromKey: string; toKey: string }> {
  const fromKey = "prime_factorization";
  const toKey = "cicada life cycles";
  const scholarId = await seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    username: "test-scholar-story",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: fromKey,
      label: "Prime factorization",
      domain: "math",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: toKey,
      label: "Cicada life cycles",
      domain: "biology",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey,
      toKey,
      domain: "sky",
      kind: "bridge",
      method: "curated",
      weight: 1,
      ...(opts.withStory ? { story: STORY } : {}),
    });
    if (opts.readingLevel) await ctx.db.patch(scholarId, { readingLevel: opts.readingLevel });
  });
  return { scholarId, fromKey, toKey };
}

describe("storyOpenContext — edge-story lookup + auth gate", () => {
  test("loads the story by (fromKey, toKey) into the narrow packet, self-access", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, fromKey, toKey } = await seedEdge(t, {
      withStory: true,
      readingLevel: "2nd grade",
    });

    const packet = await t.query(internal.edgeStories.storyOpenContext, {
      callerUserId: scholarId,
      scholarId,
      fromKey,
      toKey,
    });

    expect(packet).not.toBeNull();
    expect(packet).toMatchObject({
      hook: STORY.hook,
      narrative: STORY.narrative,
      probe: STORY.probe,
      source: STORY.source,
      fromLabel: "Prime factorization",
      toLabel: "Cicada life cycles",
      toDomain: "biology",
      readingLevel: "2nd grade",
    });
  });

  test("omits reading level when the scholar has none", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, fromKey, toKey } = await seedEdge(t, { withStory: true });
    const packet = await t.query(internal.edgeStories.storyOpenContext, {
      callerUserId: scholarId,
      scholarId,
      fromKey,
      toKey,
    });
    expect(packet).not.toBeNull();
    expect(packet?.readingLevel).toBeUndefined();
  });

  test("returns null (→ 404) when the bridge edge carries no story", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, fromKey, toKey } = await seedEdge(t, { withStory: false });
    const packet = await t.query(internal.edgeStories.storyOpenContext, {
      callerUserId: scholarId,
      scholarId,
      fromKey,
      toKey,
    });
    expect(packet).toBeNull();
  });

  test("returns null when there is no edge for the pair at all", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await seedEdge(t, { withStory: true });
    const packet = await t.query(internal.edgeStories.storyOpenContext, {
      callerUserId: scholarId,
      scholarId,
      fromKey: "prime_factorization",
      toKey: "some_unconnected_thing",
    });
    expect(packet).toBeNull();
  });

  test("a different scholar cannot open someone else's story (Forbidden)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, fromKey, toKey } = await seedEdge(t, { withStory: true });
    const otherScholar = await t.run((ctx) =>
      ctx.db.insert("users", { role: "scholar", username: "other-scholar" }),
    );
    await expect(
      t.query(internal.edgeStories.storyOpenContext, {
        callerUserId: otherScholar,
        scholarId,
        fromKey,
        toKey,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a teacher may open any scholar's story", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, fromKey, toKey } = await seedEdge(t, { withStory: true });
    const teacher = await seedStaffWithMembership(t, {
      institutionId: await seedTestInstitution(t),
      name: "Test teacher story",
      username: "test-teacher-story",
    });
    const packet = await t.query(internal.edgeStories.storyOpenContext, {
      callerUserId: teacher,
      scholarId,
      fromKey,
      toKey,
    });
    expect(packet?.hook).toBe(STORY.hook);
  });
});

describe("story-open turn cap (pure)", () => {
  const mk = (assistantTurns: number): Msg[] => {
    const out: Msg[] = [];
    for (let i = 0; i < assistantTurns; i++) {
      out.push({ role: "user", content: `q${i}` });
      out.push({ role: "assistant", content: `a${i}` });
    }
    out.push({ role: "user", content: "one more" });
    return out;
  };

  test("counts assistant turns and reports below the cap", () => {
    const { assistantTurns, atCap } = storyOpenTurnState(mk(2));
    expect(assistantTurns).toBe(2);
    expect(atCap).toBe(false);
  });

  test("atCap flips exactly at STORY_OPEN_MAX_ASSISTANT_TURNS", () => {
    expect(storyOpenTurnState(mk(STORY_OPEN_MAX_ASSISTANT_TURNS - 1)).atCap).toBe(false);
    expect(storyOpenTurnState(mk(STORY_OPEN_MAX_ASSISTANT_TURNS)).atCap).toBe(true);
    expect(storyOpenTurnState(mk(STORY_OPEN_MAX_ASSISTANT_TURNS + 1)).atCap).toBe(true);
  });

  test("cap is 6 (roomier than the handoff's 4)", () => {
    expect(STORY_OPEN_MAX_ASSISTANT_TURNS).toBe(6);
  });

  test("storyOpenEndsAfterReply marks the last pre-cap reply", () => {
    // Replying when 4 assistant turns already exist yields the 5th — not yet the cap.
    expect(storyOpenEndsAfterReply(STORY_OPEN_MAX_ASSISTANT_TURNS - 2)).toBe(false);
    // Replying when 5 exist yields the 6th (== cap) → the client should close.
    expect(storyOpenEndsAfterReply(STORY_OPEN_MAX_ASSISTANT_TURNS - 1)).toBe(true);
  });

  test("empty transcript is not at the cap", () => {
    expect(storyOpenTurnState([]).atCap).toBe(false);
    expect(storyOpenTurnState([]).assistantTurns).toBe(0);
  });
});

describe("storyOpenDedupKey (pure)", () => {
  test("is deterministic and 16 hex chars", () => {
    const a = storyOpenDedupKey("u1", "prime_factorization", "cicada life cycles", "why??");
    const b = storyOpenDedupKey("u1", "prime_factorization", "cicada life cycles", "why??");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("varies with each component", () => {
    const base = storyOpenDedupKey("u1", "a", "b", "hi");
    expect(storyOpenDedupKey("u2", "a", "b", "hi")).not.toBe(base); // caller
    expect(storyOpenDedupKey("u1", "x", "b", "hi")).not.toBe(base); // fromKey
    expect(storyOpenDedupKey("u1", "a", "y", "hi")).not.toBe(base); // toKey
    expect(storyOpenDedupKey("u1", "a", "b", "yo")).not.toBe(base); // opening msg
  });
});

describe("recordTutorTranscript — story-open upsert idempotency", () => {
  test("coalesces a growing conversation into ONE row, createdAt stable", async () => {
    const t = convexTest(schema, modules);
    const dedupKey = "abcd1234abcd1234";
    const common = {
      surface: "storyOpen" as const,
      anchor: {
        kind: "storyOpen" as const,
        fromKey: "prime_factorization",
        toKey: "cicada life cycles",
        hook: STORY.hook,
      },
      dedupKey,
      promptVersion: "2026-07-story-open-v1",
    };

    const first = await t.mutation(internal.tutorTranscripts.recordTutorTranscript, {
      ...common,
      transcript: [
        { role: "user", content: "why??" },
        { role: "assistant", content: "reply 1" },
      ],
    });
    expect(first.inserted).toBe(true);

    const second = await t.mutation(internal.tutorTranscripts.recordTutorTranscript, {
      ...common,
      transcript: [
        { role: "user", content: "why??" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "huh, and then?" },
        { role: "assistant", content: "reply 2" },
      ],
    });
    expect(second.inserted).toBe(false);
    expect(second.tutorTranscriptId).toBe(first.tutorTranscriptId);

    const rows = await t.run((ctx) => ctx.db.query("tutorTranscripts").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].surface).toBe("storyOpen");
    expect(rows[0].anchor).toEqual(common.anchor);
    expect(rows[0].turns).toBe(2);
    expect(rows[0].transcript).toHaveLength(4);
    expect(rows[0]._id).toBe(first.tutorTranscriptId);
  });

  test("distinct dedup keys make distinct rows", async () => {
    const t = convexTest(schema, modules);
    const base = {
      surface: "storyOpen" as const,
      anchor: {
        kind: "storyOpen" as const,
        fromKey: "prime_factorization",
        toKey: "cicada life cycles",
        hook: STORY.hook,
      },
      promptVersion: "2026-07-story-open-v1",
      transcript: [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: "there" },
      ],
    };
    await t.mutation(internal.tutorTranscripts.recordTutorTranscript, {
      ...base,
      dedupKey: "aaaaaaaaaaaaaaaa",
    });
    await t.mutation(internal.tutorTranscripts.recordTutorTranscript, {
      ...base,
      dedupKey: "bbbbbbbbbbbbbbbb",
    });
    const rows = await t.run((ctx) => ctx.db.query("tutorTranscripts").collect());
    expect(rows).toHaveLength(2);
  });

  test("rejects a surface whose discriminated anchor does not match", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.tutorTranscripts.recordTutorTranscript, {
        surface: "storyOpen",
        anchor: {
          kind: "handoff",
          itemId: "fraction.add#1",
          skillKey: "fraction.add",
          stem: "1/2 + 1/4",
          wrongAnswers: ["2/6"],
        },
        dedupKey: "cccccccccccccccc",
        promptVersion: "2026-07-story-open-v1",
        transcript: [
          { role: "user", content: "why?" },
          { role: "assistant", content: "Let's wonder." },
        ],
      }),
    ).rejects.toThrow(/surface must match its anchor/);
  });
});
