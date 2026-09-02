/**
 * Edge-story curation — CRUD and registry seeding for durable bridge stories.
 *
 * A story is stored on `knowledgeNodeEdges.story`, never as a node facet. Public
 * reads are available to any signed-in user; writes are curriculum-gated.
 *
 * THE EDGE IS THE CANONICAL HOME for everything story-shaped, including the
 * "application" questions: an application is a RELATIONSHIP fact (this node
 * meets this story), not an item kind. The `practiceItems` rows this file mints
 * for answered registry questions (`tier: "stretch"` + `storyToKey`) are
 * SERVING PROJECTIONS of that edge content — derived, re-derivable, and kept
 * only because the verifier/serve machinery lives on items. Don't author
 * story questions anywhere but the registry/edge, and don't treat the item row
 * as the source of truth. Design: review/story-quest-rationalization-plan.html.
 */

import { v } from "convex/values";
import { curriculumMutation, curriculumQuery } from "./lib/customFunctions";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isDurableEdge, relationOf } from "../shared/edgeOntology";
import {
  STORY_REGISTRY,
  type RegistryQuestion,
  type StoryKind,
} from "./lib/practice/storyRegistry";
import { normalizeLabel } from "./lib/nodeDepthHelpers";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";

export const STORY_KINDS = [
  "instantiates",
  "applies",
  "history",
  "etymology",
] as const;

const HOOK_MAX = 200;
const NARRATIVE_MAX = 600;
const TEASER_MAX = 400;
const VISUAL_EMOJI_MAX = 16;
const PROBE_MAX = 300;
const SKY_EDGE_DOMAIN = "sky";

type StoredEdgeStory = NonNullable<Doc<"knowledgeNodeEdges">["story"]>;
type StoryInput = {
  kind: string;
  hook: string;
  narrative: string;
  teaser?: string;
  visualEmoji?: string;
  probe?: string;
  source?: string;
};

const storyInputValidator = v.object({
  kind: v.string(),
  hook: v.string(),
  narrative: v.string(),
  teaser: v.optional(v.string()),
  visualEmoji: v.optional(v.string()),
  probe: v.optional(v.string()),
  source: v.optional(v.string()),
});

function legacyWorldNodeKey(label: string): string {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!key) throw new Error("Far-end label must contain at least one letter or number.");
  return key;
}

function methodForStory(
  provenance: StoredEdgeStory["provenance"],
): "curated" | "generated" {
  return provenance === "generated" ? "generated" : "curated";
}

function validateStory(entry: StoryInput, provenance: "authored" | "registry" | "generated"): StoredEdgeStory {
  const kind = entry.kind.trim();
  if (!(STORY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `Invalid story kind "${entry.kind}" — must be one of: ${STORY_KINDS.join(", ")}.`,
    );
  }

  const hook = entry.hook.trim();
  if (!hook) throw new Error("Hook text is required.");
  if (hook.length > HOOK_MAX) {
    throw new Error(`Hook text must be ${HOOK_MAX} characters or fewer.`);
  }

  const narrative = entry.narrative.trim();
  if (!narrative) throw new Error("Narrative text is required.");
  if (narrative.length > NARRATIVE_MAX) {
    throw new Error(`Narrative text must be ${NARRATIVE_MAX} characters or fewer.`);
  }

  let teaser: string | undefined;
  if (entry.teaser !== undefined) {
    teaser = entry.teaser.trim();
    if (!teaser) throw new Error("Teaser, when present, must be non-empty.");
    if (teaser.length > TEASER_MAX) {
      throw new Error(`Teaser must be ${TEASER_MAX} characters or fewer.`);
    }
  }

  let visualEmoji: string | undefined;
  if (entry.visualEmoji !== undefined) {
    visualEmoji = entry.visualEmoji.trim();
    if (!visualEmoji) throw new Error("Visual emoji, when present, must be non-empty.");
    if (visualEmoji.length > VISUAL_EMOJI_MAX) {
      throw new Error(`Visual emoji must be ${VISUAL_EMOJI_MAX} characters or fewer.`);
    }
    const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(visualEmoji);
    const isFlag = /^[\p{Regional_Indicator}]{2}$/u.test(visualEmoji);
    const pictographs = visualEmoji.match(/\p{Extended_Pictographic}/gu) ?? [];
    const isSinglePictograph =
      pictographs.length === 1 && !/[\p{L}\p{N}]/u.test(visualEmoji);
    // A ZWJ sequence is one rendered emoji even when it contains several
    // pictographs (for example, a profession or family emoji).
    const isJoinedPictograph =
      pictographs.length > 1 &&
      visualEmoji.includes("\u200D") &&
      !/[\p{L}\p{N}]/u.test(visualEmoji);
    if (!isKeycap && !isFlag && !isSinglePictograph && !isJoinedPictograph) {
      throw new Error("Visual emoji must be a single emoji.");
    }
    if (!isKeycap && !isFlag && pictographs.length === 0) {
      throw new Error("Visual emoji must include an emoji character.");
    }
  }

  let probe: string | undefined;
  if (entry.probe !== undefined) {
    probe = entry.probe.trim();
    if (!probe) throw new Error("Probe, when present, must be non-empty.");
    if (probe.length > PROBE_MAX) {
      throw new Error(`Probe must be ${PROBE_MAX} characters or fewer.`);
    }
  }

  let source: string | undefined;
  if (entry.source !== undefined) {
    const trimmed = entry.source.trim();
    source = trimmed || undefined;
  }

  return {
    kind: kind as StoryKind,
    hook,
    narrative,
    provenance,
    updatedAt: Date.now(),
    ...(teaser !== undefined ? { teaser } : {}),
    ...(visualEmoji !== undefined ? { visualEmoji } : {}),
    ...(probe !== undefined ? { probe } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

async function nodeByKey(ctx: MutationCtx, nodeKey: string) {
  return await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
    .first();
}

async function edgesForPair(ctx: MutationCtx, fromKey: string, toKey: string) {
  return (await ctx.db
    .query("knowledgeNodeEdges")
    .withIndex("by_from", (q) => q.eq("fromKey", fromKey))
    .collect()).filter((e) => e.toKey === toKey);
}

function storyPriority(story: StoredEdgeStory): number {
  if (story.provenance === "authored") return 3;
  if (story.provenance === "generated") return 2;
  return 1;
}

/**
 * Is this existing bridge edge OFF-LIMITS to the registry seeder?
 *
 * Deliberately NARROWER than `isDurableEdge` (shared/edgeOntology.ts), and
 * local to the seeder on purpose. `isDurableEdge` is true for ANY row carrying
 * a story, so using it as the seeder's skip guard made the registry
 * WRITE-ONCE PER PAIR: once a story existed on a deployment, no later edit to
 * its text/teaser/probe/source could ever reach it (the seeder skipped the pair
 * and the patch path below was unreachable). Only two things are genuinely the
 * seeder's business to leave alone:
 *
 *   - a TOMBSTONE — a durable, story-less bridge left behind by a curation
 *     delete (`coreRemove` clears `story` but keeps the row precisely so the
 *     next seed can't resurrect it);
 *   - a story whose provenance is "authored" — a human's words win.
 *
 * Machine-owned provenance ("registry"/"generated") is refreshed from the
 * registry, which is what makes the registry the source of truth it claims to
 * be. `isDurableEdge` itself is left untouched: it gates DELETION in the
 * rebuild/prune pipelines, where loosening it would let a pipeline drop corpus
 * rows.
 */
function isSeederProtectedBridge(edge: Doc<"knowledgeNodeEdges">): boolean {
  if (edge.story === undefined) return isDurableEdge(edge);
  return edge.story.provenance === "authored";
}

/** Does the stored story already match what the registry would write? */
function storyMatches(stored: StoredEdgeStory, next: StoredEdgeStory): boolean {
  return (
    stored.kind === next.kind &&
    stored.hook === next.hook &&
    stored.narrative === next.narrative &&
    stored.teaser === next.teaser &&
    stored.visualEmoji === next.visualEmoji &&
    stored.probe === next.probe &&
    stored.source === next.source &&
    stored.provenance === next.provenance
  );
}

export function validateRegistryStoryAuthoring(entry: {
  probe?: string;
  questions?: readonly RegistryQuestion[];
}) {
  if (entry.probe !== undefined && entry.questions !== undefined) {
    throw new Error("A registry story may carry probe OR questions, not both.");
  }
  if (entry.questions === undefined) return;
  if (entry.questions.length === 0) {
    throw new Error("Registry story questions, when present, must be non-empty.");
  }
  for (const question of entry.questions) {
    if (!question.text.trim()) {
      throw new Error("Registry story question text must be non-empty.");
    }
    if (question.answer === undefined) {
      if (question.answerType !== undefined || question.choices !== undefined) {
        throw new Error("An answerless registry story question cannot carry grading fields.");
      }
      continue;
    }
    if (!question.answer.trim()) {
      throw new Error("An answered registry story question must carry a non-empty answer.");
    }
    if (question.answerType === undefined) {
      throw new Error("An answered registry story question must carry an answerType.");
    }
    if (question.answerType === "multipleChoice") {
      const index = Number(question.answer);
      if (
        !question.choices ||
        question.choices.length < 2 ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= question.choices.length
      ) {
        throw new Error(
          "A multiple-choice registry story question needs choices and a valid zero-based answer index.",
        );
      }
    } else if (question.choices !== undefined) {
      throw new Error("Only multiple-choice registry story questions may carry choices.");
    }
  }
}

// The seeder's OWN provenance tag for a question row it minted — deliberately
// distinct from `"authored"`, which `practiceItemPool.createItemCore` /
// `updateItemCore` stamp on any row a human curator saves through the item
// editor (`components/practice/NodeItemPool.tsx`), including a registry-seeded
// stretch item a teacher opens and tweaks. That editor has no concept of
// `storyToKey` (never reads or writes it), so the field survives a human edit
// untouched — but `source` does not: every human save unconditionally
// overwrites it to `"authored"`. Using a distinct tag here (instead of the old
// `"authored"`, which collided with that human-edited state) is what makes
// `source === REGISTRY_QUESTION_SOURCE` a reliable "nobody has touched this
// since the seeder wrote it" signal — the same "a human's words win" rule
// `isSeederProtectedBridge` already enforces one level up, for edges.
const REGISTRY_QUESTION_SOURCE = "registry";

/** Do the registry's answer-key fields for `question` already match `existing`? */
function questionAnswerKeyMatches(
  existing: Doc<"practiceItems">,
  question: RegistryQuestion,
  entry: { toKey: string },
  domain: string,
): boolean {
  return (
    existing.domain === domain &&
    existing.answerType === question.answerType &&
    existing.answerCanonical === question.answer &&
    existing.storyToKey === entry.toKey &&
    existing.technique === question.technique &&
    existing.bloomLevel === question.bloomLevel &&
    (existing.choices ?? undefined)?.length === (question.choices ?? undefined)?.length &&
    (question.choices ?? []).every((choice, i) => existing.choices?.[i] === choice)
  );
}

async function seedRegistryQuestions(
  ctx: MutationCtx,
  entry: (typeof STORY_REGISTRY)[number],
  fromNode: Doc<"knowledgeNodes">,
) {
  let questionsRefreshed = 0;
  for (const question of entry.questions ?? []) {
    if (question.answer === undefined) continue;
    if (question.answerType === undefined) {
      throw new Error("An answered registry story question must carry an answerType.");
    }
    const existing = await ctx.db
      .query("practiceItems")
      .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
      .filter((q) => q.eq(q.field("stem"), question.text))
      .first();
    if (existing) {
      // Only ever patch a row this SAME seeder minted and no human has since
      // edited (see REGISTRY_QUESTION_SOURCE above) — anything else (a legacy
      // pre-fix seed, or a genuine curator override) is left exactly alone,
      // same as the pre-existing `continue`.
      if (
        existing.source === REGISTRY_QUESTION_SOURCE &&
        !questionAnswerKeyMatches(existing, question, entry, fromNode.domain)
      ) {
        await ctx.db.patch(existing._id, {
          domain: fromNode.domain,
          answerType: question.answerType,
          answerCanonical: question.answer,
          choices: question.choices,
          technique: question.technique,
          bloomLevel: question.bloomLevel,
          storyToKey: entry.toKey,
          verifiedAt: Date.now(),
        });
        questionsRefreshed++;
      }
      continue;
    }
    await ctx.db.insert("practiceItems", {
      skillKey: entry.fromKey,
      domain: fromNode.domain,
      stem: question.text,
      answerType: question.answerType,
      answerCanonical: question.answer,
      ...(question.choices ? { choices: question.choices } : {}),
      tier: "stretch",
      ...(question.technique ? { technique: question.technique } : {}),
      ...(question.bloomLevel !== undefined ? { bloomLevel: question.bloomLevel } : {}),
      // The link's from-key is the row's own skillKey; only the far end is stored.
      storyToKey: entry.toKey,
      verifierKind: "arithmetic",
      source: REGISTRY_QUESTION_SOURCE,
      verifiedAt: Date.now(),
    });
  }
  return questionsRefreshed;
}

async function mergeLegacyEdge(
  ctx: MutationCtx,
  edge: Doc<"knowledgeNodeEdges">,
  fromKey: string,
  toKey: string,
) {
  const duplicate = (await edgesForPair(ctx, fromKey, toKey)).find(
    (candidate) => candidate._id !== edge._id && candidate.kind === edge.kind,
  );
  if (!duplicate) {
    await ctx.db.patch(edge._id, { fromKey, toKey });
    return;
  }

  const legacyTombstone = edge.story === undefined && isDurableEdge(edge);
  const canonicalTombstone =
    duplicate.story === undefined && isDurableEdge(duplicate);
  if (legacyTombstone || canonicalTombstone) {
    await ctx.db.patch(duplicate._id, {
      story: undefined,
      method: "curated",
    });
  } else if (
    edge.story !== undefined &&
    (duplicate.story === undefined ||
      storyPriority(edge.story) > storyPriority(duplicate.story))
  ) {
    await ctx.db.patch(duplicate._id, {
      story: edge.story,
      method: methodForStory(edge.story.provenance),
    });
  }
  if (duplicate.weight === undefined && edge.weight !== undefined) {
    await ctx.db.patch(duplicate._id, { weight: edge.weight });
  }

  // This is an identity migration, not a cache clear: after merging the
  // canonical row, the legacy-key duplicate must disappear even if durable.
  await ctx.db.delete(edge._id);
}

async function migrateLegacyWorldNode(
  ctx: MutationCtx,
  legacyNode: Doc<"knowledgeNodes">,
  canonicalNode: Doc<"knowledgeNodes">,
) {
  const touching = new Map<
    Id<"knowledgeNodeEdges">,
    Doc<"knowledgeNodeEdges">
  >();
  for (const edge of [
    ...(await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_from", (q) => q.eq("fromKey", legacyNode.nodeKey))
      .collect()),
    ...(await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_to", (q) => q.eq("toKey", legacyNode.nodeKey))
      .collect()),
  ]) {
    touching.set(edge._id, edge);
  }

  for (const edge of touching.values()) {
    await mergeLegacyEdge(
      ctx,
      edge,
      edge.fromKey === legacyNode.nodeKey
        ? canonicalNode.nodeKey
        : edge.fromKey,
      edge.toKey === legacyNode.nodeKey ? canonicalNode.nodeKey : edge.toKey,
    );
  }

  const [legacyEmbedding, canonicalEmbedding] = await Promise.all([
    ctx.db
      .query("knowledgeNodeEmbeddings")
      .withIndex("by_node", (q) => q.eq("nodeId", legacyNode._id))
      .unique(),
    ctx.db
      .query("knowledgeNodeEmbeddings")
      .withIndex("by_node", (q) => q.eq("nodeId", canonicalNode._id))
      .unique(),
  ]);
  if (legacyEmbedding) {
    if (canonicalEmbedding) await ctx.db.delete(legacyEmbedding._id);
    else await ctx.db.patch(legacyEmbedding._id, { nodeId: canonicalNode._id });
  }
  await ctx.db.delete(legacyNode._id);
}

async function rekeyLegacyWorldNode(
  ctx: MutationCtx,
  legacyNode: Doc<"knowledgeNodes">,
  canonicalKey: string,
) {
  const touching = new Map<
    Id<"knowledgeNodeEdges">,
    Doc<"knowledgeNodeEdges">
  >();
  for (const edge of [
    ...(await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_from", (q) => q.eq("fromKey", legacyNode.nodeKey))
      .collect()),
    ...(await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_to", (q) => q.eq("toKey", legacyNode.nodeKey))
      .collect()),
  ]) {
    touching.set(edge._id, edge);
  }
  for (const edge of touching.values()) {
    await mergeLegacyEdge(
      ctx,
      edge,
      edge.fromKey === legacyNode.nodeKey ? canonicalKey : edge.fromKey,
      edge.toKey === legacyNode.nodeKey ? canonicalKey : edge.toKey,
    );
  }
  await ctx.db.patch(legacyNode._id, {
    nodeKey: canonicalKey,
    normalizedLabel: canonicalKey,
  });
}

async function ensureWorldNode(
  ctx: MutationCtx,
  args: { label: string; domain: string; hook: string },
) {
  const canonicalKey = normalizeLabel(args.label);
  if (!canonicalKey) {
    throw new Error("Far-end label must contain at least one letter or number.");
  }
  const legacyKey = legacyWorldNodeKey(args.label);
  const [canonicalNode, legacyNode] = await Promise.all([
    nodeByKey(ctx, canonicalKey),
    legacyKey === canonicalKey ? Promise.resolve(null) : nodeByKey(ctx, legacyKey),
  ]);

  if (canonicalNode) {
    if (legacyNode) {
      await migrateLegacyWorldNode(ctx, legacyNode, canonicalNode);
    }
    return { node: canonicalNode, created: false };
  }
  if (legacyNode) {
    await rekeyLegacyWorldNode(ctx, legacyNode, canonicalKey);
    const migrated = await ctx.db.get(legacyNode._id);
    if (!migrated) throw new Error("Migrated world node could not be read back.");
    return { node: migrated, created: false };
  }

  const nodeId = await ctx.db.insert("knowledgeNodes", {
    nodeKey: canonicalKey,
    label: args.label,
    domain: args.domain,
    normalizedLabel: canonicalKey,
    source: "world",
    embeddingText: `${args.label}. ${args.hook}`,
    refCount: 1,
  });
  const inserted = await ctx.db.get(nodeId);
  if (!inserted) throw new Error("Inserted world node could not be read back.");
  return { node: inserted, created: true };
}

function shapeStoryEdge(
  edge: Doc<"knowledgeNodeEdges">,
  farNode: Doc<"knowledgeNodes"> | null,
) {
  return {
    edgeId: edge._id,
    fromKey: edge.fromKey,
    toKey: edge.toKey,
    toLabel: farNode?.label ?? edge.toKey,
    toDomain: farNode?.domain ?? edge.domain,
    kind: edge.kind,
    method: edge.method ?? null,
    story: edge.story!,
  };
}

async function coreUpsert(
  ctx: MutationCtx,
  args: {
    edgeId?: Id<"knowledgeNodeEdges">;
    fromKey: string;
    toKey?: string;
    toLabel?: string;
    toDomain?: string;
    story: StoryInput;
    provenance?: "authored" | "registry" | "generated";
  },
) {
  const story = validateStory(args.story, args.provenance ?? "authored");

  if (args.edgeId) {
    const edge = await ctx.db.get(args.edgeId);
    if (!edge) throw new Error(`Unknown edge: ${args.edgeId}`);
    // A story lives ONLY on a bridge. Refuse to stamp one onto a dependency
    // edge (buildsOn/buildsTowards/requires) — that would reclassify a
    // load-bearing prerequisite into a durable, uncleanable associative edge.
    if (relationOf(edge.kind) !== "bridge") {
      throw new Error(
        `Cannot attach a story to a ${edge.kind} (dependency) edge — stories live on bridges.`,
      );
    }
    const method = methodForStory(story.provenance);
    await ctx.db.patch(edge._id, { story, method });
    const farNode = await nodeByKey(ctx, edge.toKey);
    return shapeStoryEdge({ ...edge, story, method }, farNode);
  }

  const fromNode = await nodeByKey(ctx, args.fromKey);
  if (!fromNode) throw new Error(`Unknown source node: ${args.fromKey}`);

  const label = args.toLabel?.trim();
  const domain = args.toDomain?.trim();
  let toKey = args.toKey?.trim() ?? "";
  let farNode = toKey ? await nodeByKey(ctx, toKey) : null;
  if (!farNode && label && domain) {
    const canonicalKey = normalizeLabel(label);
    if (toKey && toKey !== canonicalKey) {
      throw new Error(
        `New world node key must match its normalized label: "${canonicalKey}".`,
      );
    }
    const ensured = await ensureWorldNode(ctx, {
      label,
      domain,
      hook: story.hook,
    });
    farNode = ensured.node;
    toKey = farNode.nodeKey;
  }
  if (!farNode) throw new Error(`Unknown far-end node: ${toKey}`);

  // Only ever reuse an existing BRIDGE for this pair. A dependency edge
  // (buildsOn/buildsTowards/requires) that happens to run the same direction
  // must NOT be clobbered into a bridge — that would silently destroy a
  // prerequisite relation the practice scheduler gates on. If the pair has only
  // a dependency edge (or nothing), insert a fresh, independent bridge.
  const existing = await edgesForPair(ctx, args.fromKey, toKey);
  const edgeToWrite = existing.find((e) => relationOf(e.kind) === "bridge") ?? null;
  const method = methodForStory(story.provenance);
  if (edgeToWrite) {
    await ctx.db.patch(edgeToWrite._id, {
      kind: "bridge",
      method,
      domain: SKY_EDGE_DOMAIN,
      weight: edgeToWrite.weight ?? 1,
      story,
    });
    return shapeStoryEdge(
      { ...edgeToWrite, kind: "bridge", method, domain: SKY_EDGE_DOMAIN, weight: edgeToWrite.weight ?? 1, story },
      farNode,
    );
  }

  const edgeId = await ctx.db.insert("knowledgeNodeEdges", {
    fromKey: args.fromKey,
    toKey,
    domain: SKY_EDGE_DOMAIN,
    kind: "bridge",
    method,
    weight: 1,
    story,
  });
  const edge = await ctx.db.get(edgeId);
  if (!edge) throw new Error("Inserted story edge could not be read back.");
  return shapeStoryEdge(edge, farNode);
}

async function coreRemove(ctx: MutationCtx, args: { edgeId: Id<"knowledgeNodeEdges"> }) {
  const edge = await ctx.db.get(args.edgeId);
  if (!edge) throw new Error(`Unknown edge: ${args.edgeId}`);
  // Clear the story but KEEP the edge as a story-less bridge. Hard-deleting a
  // curated/registry edge would let the next rebuildPracticeNodes → seedRegistry
  // resurrect the very story the teacher just removed. The surviving durable
  // (method:"curated") tombstone is what blocks that resurrection — see
  // seedRegistry's `isSeederProtectedBridge` guard and the storySeeding
  // "curated-to-none blocks registry resurrection" test.
  await ctx.db.patch(edge._id, { story: undefined });
  return { deleted: false };
}

export const upsertStory = curriculumMutation({
  args: {
    edgeId: v.optional(v.id("knowledgeNodeEdges")),
    fromKey: v.string(),
    toKey: v.optional(v.string()),
    toLabel: v.optional(v.string()),
    toDomain: v.optional(v.string()),
    story: storyInputValidator,
  },
  handler: async (ctx, args) => coreUpsert(ctx, args),
});

export const removeStory = curriculumMutation({
  args: { edgeId: v.id("knowledgeNodeEdges") },
  handler: async (ctx, args) => coreRemove(ctx, args),
});

export const upsertStoryInternal = internalMutation({
  args: {
    edgeId: v.optional(v.id("knowledgeNodeEdges")),
    fromKey: v.string(),
    toKey: v.optional(v.string()),
    toLabel: v.optional(v.string()),
    toDomain: v.optional(v.string()),
    story: storyInputValidator,
  },
  handler: async (ctx, args) => coreUpsert(ctx, args),
});

export const removeStoryInternal = internalMutation({
  args: { edgeId: v.id("knowledgeNodeEdges") },
  handler: async (ctx, args) => coreRemove(ctx, args),
});

export const listStories = curriculumQuery({
  args: {},
  handler: async (ctx) => {
    // Curated corpus at editorial scale (~54 rows today). If this climbs past
    // ~500, add a domain arg for server-side narrowing.
    const storyEdges = (
      await Promise.all(
        (["registry", "authored", "generated"] as const).map((provenance) =>
          ctx.db
            .query("knowledgeNodeEdges")
            .withIndex("by_story_provenance", (q) =>
              q.eq("story.provenance", provenance),
            )
            .collect(),
        ),
      )
    ).flat();

    const nodeCache = new Map<
      string,
      { label: string; domain: string; strand: string | null }
    >();
    const nodeInfo = async (nodeKey: string) => {
      const cached = nodeCache.get(nodeKey);
      if (cached) return cached;
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
        .first();
      const resolved = {
        label: node?.label ?? nodeKey.replace(/[-_]+/g, " "),
        domain: node?.domain ?? "unknown",
        strand: node?.strand ?? null,
      };
      nodeCache.set(nodeKey, resolved);
      return resolved;
    };

    const rows = await Promise.all(
      storyEdges.map(async (edge) => {
        const story = edge.story;
        if (!story) return null;
        const [fromNode, toNode] = await Promise.all([
          nodeInfo(edge.fromKey),
          nodeInfo(edge.toKey),
        ]);
        return {
          edgeId: edge._id,
          fromKey: edge.fromKey,
          fromLabel: fromNode.label,
          fromDomain: fromNode.domain,
          fromStrand: fromNode.strand,
          toKey: edge.toKey,
          toLabel: toNode.label,
          toDomain: toNode.domain,
          kind: story.kind,
          hook: story.hook,
          narrative: story.narrative,
          ...(story.visualEmoji ? { visualEmoji: story.visualEmoji } : {}),
          ...(story.probe ? { probe: story.probe } : {}),
          ...(story.source ? { source: story.source } : {}),
          provenance: story.provenance,
          ...(story.updatedAt ? { updatedAt: story.updatedAt } : {}),
        };
      }),
    );
    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});

async function queryNodeByKey(ctx: QueryCtx, nodeKey: string) {
  return await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
    .first();
}

/**
 * Resolve the server-side context for a `/story-open` conversation (convex/http.ts):
 * the auth gate + the edge story loaded by (fromKey, toKey) + the plain skill/world
 * labels + the scholar's reading level. Resolution shape:
 *
 *  - Auth: a scholar may only open a story from their OWN fluency moment; a teacher
 *    may open any (requireTeacherOrSelf throws "Forbidden" otherwise). The scholarId
 *    exists ONLY for this gate — no per-scholar data enters the returned packet, so
 *    the story-open prompt structurally cannot receive sensitive scholar data.
 *  - Story load: a story lives on a BRIDGE edge (`knowledgeNodeEdges.story`). We find
 *    the bridge for this pair that actually carries a story and hand back its fields.
 *    Returns `null` when the edge has no story (a story-less/tombstoned bridge, or no
 *    edge at all) so the route can 404 — there is nothing to talk about.
 *
 * The returned fields are exactly `StoryOpenPacket` (convex/lib/practice/storyOpen.ts).
 */
export const storyOpenContext = internalQuery({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    fromKey: v.string(),
    toKey: v.string(),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Not authenticated");
    // Ownership gate: self (the scholar whose fluency moment this is) or a teacher.
    const isTeacher = requireTeacherOrSelf(caller, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, caller, args.scholarId);

    // A story lives only on a bridge edge for this pair. Scan the from-side and
    // pick the bridge that actually carries a story (there is at most one).
    const edges = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_from", (q) => q.eq("fromKey", args.fromKey))
      .collect();
    const storyEdge = edges.find(
      (e) => e.toKey === args.toKey && relationOf(e.kind) === "bridge" && e.story !== undefined,
    );
    if (!storyEdge || !storyEdge.story) return null;

    const [fromNode, toNode, scholar] = await Promise.all([
      queryNodeByKey(ctx, args.fromKey),
      queryNodeByKey(ctx, args.toKey),
      ctx.db.get(args.scholarId),
    ]);

    return {
      hook: storyEdge.story.hook,
      narrative: storyEdge.story.narrative,
      ...(storyEdge.story.probe !== undefined ? { probe: storyEdge.story.probe } : {}),
      ...(storyEdge.story.source !== undefined ? { source: storyEdge.story.source } : {}),
      ...(fromNode?.label ? { fromLabel: fromNode.label } : {}),
      toLabel: toNode?.label ?? args.toKey,
      toDomain: toNode?.domain ?? storyEdge.domain,
      ...(scholar?.readingLevel ? { readingLevel: scholar.readingLevel } : {}),
    };
  },
});

/**
 * Seed the static story registry into `knowledgeNodeEdges` (idempotent).
 *
 * Returns `{ nodes, edges, refreshed, questionsRefreshed }`: world nodes
 * created, story bridges newly inserted, already-seeded bridges patched with
 * updated registry TEXT (narrative/teaser/probe/…), and already-seeded
 * question `practiceItems` rows patched with a corrected ANSWER KEY
 * (`answerCanonical`/`answerType`/`choices`/`technique`/`bloomLevel`) — two
 * independent counters because they patch two different tables via two
 * different code paths. Either being > 0 on a deployment that already has the
 * corpus is the expected shape after the matching kind of registry edit;
 * all-zero means nothing changed.
 */
export const seedRegistry = internalMutation({
  args: {},
  handler: async (ctx) => {
    let nodes = 0;
    let edges = 0;
    let refreshed = 0;
    let questionsRefreshed = 0;
    for (const entry of STORY_REGISTRY) {
      validateRegistryStoryAuthoring(entry);
      const fromNode = await nodeByKey(ctx, entry.fromKey);
      // Best-effort: a registry entry whose source skill was renamed/dropped from
      // a practice graph is skipped, NOT thrown — a stale story reference must
      // never abort the whole node rebuild (db:seed / knowledgeNodes.rebuild).
      if (!fromNode) {
        console.warn(`seedRegistry: skipping story — source node missing: ${entry.fromKey}`);
        continue;
      }
      questionsRefreshed += await seedRegistryQuestions(ctx, entry, fromNode);
      const canonicalKey = normalizeLabel(entry.toLabel);
      if (entry.toKey !== canonicalKey) {
        throw new Error(
          `Story registry toKey must equal normalizeLabel(toLabel): "${entry.toKey}" !== "${canonicalKey}".`,
        );
      }
      const ensured = await ensureWorldNode(ctx, {
        label: entry.toLabel,
        domain: entry.toDomain,
        hook: entry.hook,
      });
      if (ensured.created) nodes++;

      // A protected BRIDGE already owning this pair (a teacher-AUTHORED story OR
      // a story-less tombstone from a curation delete) is left alone. Anything
      // else — including an already-seeded registry/generated story — is
      // refreshed below, so registry edits actually reach a seeded deployment.
      // A dependency edge on the same pair neither blocks nor gets clobbered —
      // the story bridge is a separate, independent edge.
      const existing = await edgesForPair(ctx, entry.fromKey, entry.toKey);
      const bridges = existing.filter((e) => relationOf(e.kind) === "bridge");
      if (bridges.some(isSeederProtectedBridge)) continue;

      const story = validateStory(
        {
          kind: entry.kind,
          hook: entry.hook,
          narrative: entry.narrative,
          teaser: entry.teaser,
          visualEmoji: entry.visualEmoji,
          probe:
            entry.questions?.find((question) => question.answer === undefined)?.text ??
            entry.probe,
          source: entry.source,
        },
        entry.provenance ?? "registry",
      );
      const method = methodForStory(story.provenance);
      const cacheEdge = bridges.find((e) => e.story !== undefined) ?? bridges[0];
      if (cacheEdge) {
        const upToDate =
          cacheEdge.story !== undefined &&
          storyMatches(cacheEdge.story, story) &&
          cacheEdge.method === method &&
          cacheEdge.domain === SKY_EDGE_DOMAIN &&
          cacheEdge.kind === "bridge" &&
          cacheEdge.weight === 1;
        // Re-writing an identical row would only churn `updatedAt`, so a no-op
        // run stays a no-op.
        if (upToDate) continue;
        await ctx.db.patch(cacheEdge._id, {
          domain: SKY_EDGE_DOMAIN,
          kind: "bridge",
          method,
          weight: 1,
          story,
        });
        refreshed++;
        continue;
      }
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: entry.fromKey,
        toKey: entry.toKey,
        domain: SKY_EDGE_DOMAIN,
        kind: "bridge",
        method,
        weight: 1,
        story,
      });
      edges++;
    }
    return { nodes, edges, refreshed, questionsRefreshed };
  },
});
