/**
 * Instructional "Launchpad" lifecycle mutations + content-reopen query
 * (instructional segments v1).
 *
 * The run selector (`practiceSkills.practiceSession` → `launchpad`) is a QUERY and cannot
 * write, so fire-once is claimed here from the client on card mount — the same
 * pattern `StoryMomentCard` uses with `recordMomentOffered`. Every write is
 * self-scoped scholar telemetry that is SYSTEM-ONLY: it must never feed mastery,
 * credit, adaptive difficulty, or any learner-/teacher-facing quality surface.
 *
 * Lifecycle (one patched row per scholar+key):
 *   (none) --claimShown--> shown
 *   shown  --recordChoice--> shown{initialChoice: try|show}
 *   shown  --recordViewed/Completed/Dismissed--> terminal (suppresses re-offer)
 *   any    --recordRetrieval--> append-only "See an example" reopen (non-terminal)
 *
 * Re-offer: a Launchpad only ever skipped ("try", never viewed/completed/
 * dismissed) is re-offered up to INSTRUCTION_REOFFER_CAP times on later days.
 * Daily cap: at most one Launchpad is claimed-shown per scholar-local day.
 */

import { v } from "convex/values";
import { authedMutation, authedQuery, curriculumQuery } from "./lib/customFunctions";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { dayKeyForTimezone } from "../shared/institutionDay";
import { timeZoneForScholar } from "./lib/institutionTime";
import { isSelfScholarReference } from "../shared/instructionReferenceAudience";
import { requireActiveLearnerInstitution } from "./lib/scholarEnrollment";
import {
  isInstructionSuppressed,
  instructionOfferId,
  strandInstructionKey,
  nodeInstructionKey,
  type InstructionAtom,
} from "./lib/practice/instructionEntries";
import { verifyInstructionContent } from "./lib/practice/instructionVerify";
import {
  AUTHORED_LAUNCHPADS,
  INSTRUCTION_ANCHOR_STRANDS,
  type SeedInstructionAtom,
} from "./seed/instructionSeed";
import type { Doc, Id } from "./_generated/dataModel";

export type InstructionMedium = "manipulative" | "video" | "text";

/** One canonical medium classification for teacher coverage/detail reads. */
export function instructionMedium(
  atoms: readonly Pick<InstructionAtom, "kind">[],
): InstructionMedium {
  if (atoms.some((atom) => atom.kind === "manipulative")) return "manipulative";
  if (atoms.some((atom) => atom.kind === "video")) return "video";
  return "text";
}

/** The requesting client, for `instructionContent.platforms` gating. Every
 *  scholar-facing content read takes this as an optional arg defaulting to
 *  "web", so a Launchpad authored for one platform only never surfaces on the
 *  other. */
export const instructionPlatformValidator = v.optional(
  v.union(v.literal("web"), v.literal("native")),
);
export type InstructionPlatform = "web" | "native";

async function authScholar(
  ctx: QueryCtx & { user: Doc<"users"> },
  scholarId: Id<"users">,
) {
  const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
  if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
}

/**
 * Scholar-SELF-ONLY guard for writing instructional telemetry — stricter than
 * `authScholar` above, which is teacher-or-self (fine for reads/lifecycle
 * mutations a teacher legitimately triggers on the scholar's behalf, e.g.
 * previewing/rehearsing). Retrieval logging must never be one of those: it is
 * SYSTEM-ONLY, scholar-scoped telemetry, and a teacher/parent merely viewing a
 * scholar's data (even with valid access) must produce ZERO writes against
 * that scholar's ledger — the exact doctrine `resolveRunLaunchpad`'s `isSelf`
 * parameter already enforces for the doorway (practiceSkills.ts).
 *
 * UNIFIED with (not a re-derivation of) the client-side reference-placement
 * guard: `isSelfScholarReference` (shared/instructionReferenceAudience.ts)
 * already encodes "viewer id === scholar id" for NodeDrawer's `logRetrieval`
 * prop. Reusing it here — rather than writing a second identity check — means
 * there is exactly one definition of "is this the scholar's own sitting" for
 * BOTH the client-side UI gate and the server-side write gate.
 */
async function requireScholarSelf(
  ctx: MutationCtx & { user: Doc<"users"> },
  scholarId: Id<"users">,
) {
  if (!isSelfScholarReference({ viewerId: ctx.user._id, scholarId })) {
    throw new Error("Only the scholar themself may record instruction retrieval telemetry");
  }
  await requireActiveLearnerInstitution(ctx, ctx.user._id);
}

async function eventRow(ctx: QueryCtx, scholarId: Id<"users">, key: string) {
  return await ctx.db
    .query("instructionEvents")
    .withIndex("by_scholar_key", (q) => q.eq("scholarId", scholarId).eq("key", key))
    .unique();
}

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; reason: "suppressed" | "daily_cap" };

/**
 * Claim a Launchpad as SHOWN. Idempotent within a scholar-local day, enforces the
 * re-offer cap and the ≤1/day cap authoritatively (the query's checks are only
 * advisory). Returns whether the card should actually render.
 */
export const claimInstructionShown = authedMutation({
  args: {
    scholarId: v.id("users"),
    key: v.string(),
  },
  handler: async (ctx, args): Promise<ClaimResult> => {
    await authScholar(ctx, args.scholarId);
    const key = args.key.trim();
    if (!key) throw new Error("key is required");

    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const dayBucket = dayKeyForTimezone(Date.now(), timeZone);
    const now = Date.now();

    const existing = await eventRow(ctx, args.scholarId, key);

    // Terminal / cap-exhausted → never re-show.
    if (isInstructionSuppressed(existing ?? undefined)) {
      return { claimed: false, reason: "suppressed" };
    }

    // Already shown today for this key → idempotent (a re-mount), no bump.
    if (existing?.shownAt != null && existing.lastShownDayBucket === dayBucket) {
      return { claimed: true };
    }

    // ≤1 Launchpad per day across keys: if a DIFFERENT key was already shown
    // today, hold this one for a later day (its ledger is untouched, so it stays
    // eligible — nothing is burned).
    const all = await ctx.db
      .query("instructionEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const anotherShownToday = all.some(
      (e: Doc<"instructionEvents">) =>
        e.key !== key && e.shownAt != null && e.lastShownDayBucket === dayBucket,
    );
    if (anotherShownToday) return { claimed: false, reason: "daily_cap" };

    if (existing) {
      await ctx.db.patch(existing._id, {
        shownAt: now,
        lastShownDayBucket: dayBucket,
        offerCount: (existing.offerCount ?? 0) + 1,
      });
    } else {
      await ctx.db.insert("instructionEvents", {
        scholarId: args.scholarId,
        key,
        offerId: instructionOfferId(args.scholarId, key),
        shownAt: now,
        offerCount: 1,
        lastShownDayBucket: dayBucket,
        retrievals: [],
      });
    }
    return { claimed: true };
  },
});

/** Record the scholar's fork choice ("try" = skip to the item, "show" = watch). */
export const recordInstructionChoice = authedMutation({
  args: {
    scholarId: v.id("users"),
    key: v.string(),
    choice: v.union(v.literal("try"), v.literal("show")),
  },
  handler: async (ctx, args) => {
    await authScholar(ctx, args.scholarId);
    const row = await eventRow(ctx, args.scholarId, args.key);
    if (!row) return null; // choice without a prior shown claim is a no-op
    await ctx.db.patch(row._id, { initialChoice: args.choice });
    return row._id;
  },
});

function terminalMutation(field: "viewedAt" | "completedAt" | "dismissedAt") {
  return authedMutation({
    args: { scholarId: v.id("users"), key: v.string() },
    handler: async (
      // `authedMutation`'s `input` augments ctx with `user` (see
      // customFunctions.ts) — matching that here (rather than the bare
      // `MutationCtx` this previously annotated) is what lets `authScholar`'s
      // `ctx.user` read type-check instead of silently widening past it.
      ctx: MutationCtx & { user: Doc<"users"> },
      args: { scholarId: Id<"users">; key: string },
    ) => {
      await authScholar(ctx, args.scholarId);
      return await recordInstructionTerminalInContext(
        ctx,
        args.scholarId,
        args.key,
        field,
      );
    },
  });
}

export async function recordInstructionTerminalInContext(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  key: string,
  field: "viewedAt" | "completedAt" | "dismissedAt",
) {
  const row = await eventRow(ctx, scholarId, key);
  if (!row) return null;
  if (row[field] != null) return row._id;
  await ctx.db.patch(row._id, { [field]: Date.now() });
  return row._id;
}

/** The scholar actually watched the worked example (terminal — suppresses re-offer). */
export const recordInstructionViewed = terminalMutation("viewedAt");
/** The scholar finished the Launchpad (terminal). */
export const recordInstructionCompleted = terminalMutation("completedAt");
/** The scholar deliberately dismissed it (terminal — respect the "no" durably). */
export const recordInstructionDismissed = terminalMutation("dismissedAt");

/**
 * Append a "See an example" / "See the move" reopen. NON-terminal and
 * repeatable: a scholar who skipped and later pulls the explainer up (idea
 * shelf, or the on-demand node drawer/map reference — §4.3), or after a miss
 * (post_miss), is logged without any suppression or credit effect.
 *
 * UPSERTS the lifecycle row rather than no-op'ing when one doesn't exist yet.
 * The reference placement (§4.3) never claims a Launchpad "shown" impression —
 * a scholar can open "See the move" for a node/strand they were never offered
 * a doorway into — so requiring a prior `claimInstructionShown` row here would
 * silently drop every retrieval from that placement. The minted row carries NO
 * `shownAt`/`lastShownDayBucket` and `offerCount: 0`, so it never counts toward
 * the ≤1/day governor (`claimInstructionShown`'s daily-cap scan keys off
 * `shownAt`) or the re-offer cap (`isInstructionSuppressed` keys off
 * `viewedAt`/`completedAt`/`dismissedAt`/`offerCount`) — it exists purely so the
 * retrieval is honestly logged.
 *
 * VALIDATED, not a bare passthrough: `key` must (a) parse as a real grain
 * (`parseInstructionKey`) and (b) name a key that actually has PASSED,
 * non-empty content — i.e. something a scholar could genuinely have been shown.
 * Upserting on an arbitrary caller-supplied string would let a malformed or
 * fabricated key mint a ledger row for content that doesn't exist, polluting
 * the SYSTEM-ONLY telemetry this table is documented to be.
 *
 * SCHOLAR-SELF-ONLY (`requireScholarSelf`, not the teacher-or-self
 * `authScholar`): a teacher/parent may READ a scholar's instructional content
 * (the drawer/map reference render, the practice loop's shelf preview), but
 * may never WRITE a retrieval against a scholar they merely have access to —
 * the whole point of "SYSTEM-ONLY telemetry" is that it is the scholar's own,
 * not something a remote viewer can log/pollute on their behalf.
 */
export const recordInstructionRetrieval = authedMutation({
  args: {
    scholarId: v.id("users"),
    key: v.string(),
    source: v.union(v.literal("idea_shelf"), v.literal("post_miss")),
  },
  handler: async (ctx, args) => {
    await requireScholarSelf(ctx, args.scholarId);
    if (!parseInstructionKey(args.key)) {
      throw new Error(`recordInstructionRetrieval: malformed instruction key "${args.key}"`);
    }
    // Platform-agnostic existence check — deliberately NOT `readPassedContent`
    // (which defaults to filtering by "web"), since a legitimate native-only
    // retrieval must not be rejected just because nothing passed for "web".
    const passedRows: Doc<"instructionContent">[] = await ctx.db
      .query("instructionContent")
      .withIndex("by_key_status", (q) => q.eq("key", args.key).eq("verifyStatus", "passed"))
      .collect();
    const hasContent = passedRows.some((r) => (r.atoms?.length ?? 0) > 0);
    if (!hasContent) {
      throw new Error(
        `recordInstructionRetrieval: no PASSED instructional content for key "${args.key}"`,
      );
    }
    const row = await eventRow(ctx, args.scholarId, args.key);
    const entry = { at: Date.now(), source: args.source };
    if (row) {
      await ctx.db.patch(row._id, { retrievals: [...(row.retrievals ?? []), entry] });
      return row._id;
    }
    return await ctx.db.insert("instructionEvents", {
      scholarId: args.scholarId,
      key: args.key,
      offerId: instructionOfferId(args.scholarId, args.key),
      offerCount: 0,
      retrievals: [entry],
    });
  },
});

/**
 * Read passed Launchpad content by key — powers the idea-shelf reopen and the
 * post-miss "See an example" affordance AFTER a reload, when the atoms are no
 * longer in client memory. Returns null when there is no verified content.
 */
export const instructionContentForKey = authedQuery({
  args: { scholarId: v.id("users"), key: v.string(), platform: instructionPlatformValidator },
  handler: async (ctx, args) => {
    await authScholar(ctx, args.scholarId);
    return await readPassedContent(ctx, args.key, args.platform ?? "web");
  },
});

export async function instructionContentForKeyInContext(
  ctx: QueryCtx,
  key: string,
  platform: InstructionPlatform,
) {
  return await readPassedContent(ctx, key, platform);
}

/**
 * Resolve the passed Launchpad content for the STRAND an item belongs to, from
 * its `skillKey` (nodeKey). This is what makes the persistent "See an example"
 * shelf + the post-miss explainer available on ANY item inside a seeded strand
 * (success criterion #10) without threading `strand` onto the served item —
 * `knowledgeNodes` already carries `(domain, strand)` per node. Returns null for
 * an item whose strand has no verified content, so non-seeded strands simply
 * show no shelf (documented v1 coverage bound). Never mints or mutates anything.
 */
export const instructionContentForSkill = authedQuery({
  args: { scholarId: v.id("users"), skillKey: v.string(), platform: instructionPlatformValidator },
  handler: async (ctx, args) => {
    await authScholar(ctx, args.scholarId);
    return await instructionContentForSkillInContext(
      ctx,
      args.skillKey,
      args.platform ?? "web",
    );
  },
});

export async function instructionContentForSkillInContext(
  ctx: QueryCtx,
  skillKey: string,
  platform: InstructionPlatform,
) {
  const node = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
    .first();
  if (!node || !node.strand) return null;
  const key = strandInstructionKey(node.domain, node.strand);
  const content = await readPassedContent(ctx, key, platform);
  return content ? { ...content, key } : null;
}

// ─── Key space (instructional-content-plan §3) ─────────────────────────────
//
// `instructionContent.key` is (and stays) a plain `v.string()` — every read
// path (`readPassedContent`, the `by_key`/`by_key_status` indexes) is already
// key-format-agnostic, so adding a finer grain is a STRING-format extension,
// not a schema change. Two grains are live:
//   - `strand:<domain>:<strand>` — the existing doorway grain (built by
//     `strandInstructionKey` in `lib/practice/instructionEntries.ts`, which
//     stays the single source of truth for that shape — the pure selector core
//     imports it too).
//   - `node:<nodeKey>` — new. `nodeKey` is already globally unique
//     (`graphValidation.ts`), so it never needs a domain prefix the way
//     strands do.
// `parseInstructionKey`/`buildInstructionKey` are the ONE canonical pair for
// building/reading either shape; readers that want "node-first, strand
// fallback" resolution (§3's "Resolution order") call them directly rather
// than re-deriving the string format inline.

/** Either instructional-content key grain, pre-parse. */
export type InstructionKeyRef =
  | { kind: "node"; nodeKey: string }
  | { kind: "strand"; domain: string; strand: string };

/** Build the canonical stored-key string for either grain. */
export function buildInstructionKey(ref: InstructionKeyRef): string {
  if (ref.kind === "node") return nodeInstructionKey(ref.nodeKey);
  return strandInstructionKey(ref.domain, ref.strand);
}

/**
 * Parse a stored/queried key back into its grain. Returns null for a key that
 * matches neither shape (defensive — a malformed/legacy key should never
 * throw, just fail to resolve).
 */
export function parseInstructionKey(key: string): InstructionKeyRef | null {
  if (key.startsWith("node:")) {
    const nodeKey = key.slice("node:".length);
    return nodeKey ? { kind: "node", nodeKey } : null;
  }
  if (key.startsWith("strand:")) {
    const rest = key.slice("strand:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return null;
    return { kind: "strand", domain: rest.slice(0, sep), strand: rest.slice(sep + 1) };
  }
  return null;
}

/**
 * On-demand REFERENCE placement (§4.3 "See the move" from the node drawer /
 * map). Node-grain content FIRST, falling back to the node's strand entry
 * exactly like `instructionContentForSkill`'s resolution — a node with no
 * node-grain content of its own still explains itself via its strand's move.
 * Pure pull: read-only, no lifecycle write, no governor (uncapped,
 * non-terminal — see `recordInstructionRetrieval`, which the caller invokes
 * separately to log the open). Returns null when the node doesn't resolve or
 * neither grain has PASSED, non-empty content.
 */
export const instructionContentForNode = authedQuery({
  args: { scholarId: v.id("users"), nodeKey: v.string(), platform: instructionPlatformValidator },
  handler: async (ctx, args) => {
    await authScholar(ctx, args.scholarId);
    const platform = args.platform ?? "web";
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.nodeKey))
      .first();
    if (!node) return null;

    const nodeLevelKey = buildInstructionKey({ kind: "node", nodeKey: args.nodeKey });
    const nodeContent = await readPassedContent(ctx, nodeLevelKey, platform);
    if (nodeContent) return nodeContent;

    if (!node.strand) return null;
    const strandKey = buildInstructionKey({ kind: "strand", domain: node.domain, strand: node.strand });
    return await readPassedContent(ctx, strandKey, platform);
  },
});

/**
 * Context for generating ONE MORE worked example on demand — powers the "Show me
 * another" affordance on the "See an example" shelf
 * (`practiceGen.generateAnotherWorkedExample`). Resolves the strand from `skillKey`
 * and describes the MOVE it teaches (its micro_explain / strategy / rationale),
 * the grade band, and the strand's canonical example prompt so the generator can
 * teach the same move
 * with a DIFFERENT example. Scholar-self / teacher-of gated, read-only, mints
 * nothing. Returns null when the node/strand can't be resolved.
 */
export const exampleGenContext = authedQuery({
  args: { scholarId: v.id("users"), skillKey: v.string() },
  handler: async (ctx, args) => {
    await authScholar(ctx, args.scholarId);
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.skillKey))
      .first();
    if (!node || !node.strand) return null;
    const key = strandInstructionKey(node.domain, node.strand);
    const content = await readPassedContent(ctx, key);
    const atoms = (content?.atoms ?? []) as InstructionAtom[];
    const micro = atoms.find((a) => a.kind === "micro_explain");
    const worked = atoms.find((a) => a.kind === "worked_example");
    // The "move" this strand teaches, best available description → generic.
    const move =
      (micro && micro.kind === "micro_explain" ? micro.text : undefined) ??
      (worked && worked.kind === "worked_example" ? worked.strategyLabel : undefined) ??
      node.rationale ??
      node.label;
    return {
      domain: node.domain,
      strand: node.strand,
      label: node.label,
      title: content?.title ?? node.label,
      move,
      gradePhrase: node.grade ? `a grade-${node.grade} student` : "a curious young student",
      baseExamplePrompt:
        worked && worked.kind === "worked_example" ? worked.examplePrompt : null,
    };
  },
});

/**
 * Teacher-facing instructional coverage for a domain (Math Skills tab). One row
 * per strand key (upsert-by-key), so the whole catalog is tiny — a full read is
 * cheap. Reports, per strand that has stored Launchpad content: verify status,
 * provenance, title/subtitle, and which atom kinds it carries. Also returns the
 * DESIGNATED anchor strands for the domain, so the UI can flag gaps (an anchor
 * with no passing content) rather than silently omit them. Scholar-agnostic
 * catalog data, curriculum-gated like the rest of this surface. Never mutates.
 */
export const instructionCoverage = curriculumQuery({
  args: { domain: v.string() },
  handler: async (ctx, args) => {
    const inDomain: Doc<"instructionContent">[] = await ctx.db
      .query("instructionContent")
      .withIndex("by_domain", (q) => q.eq("domain", args.domain))
      .collect();
    const strands = inDomain
      // STRAND-GRAIN ONLY. `instructionContent` also carries `node:<nodeKey>`
      // rows (§3) which stamp the SAME `domain`/`strand` as their owning
      // node — so filtering by `r.domain` alone lets a node-grain row pollute
      // this "one row per strand key" catalog (a second entry for a strand
      // already listed, or worse, silently standing in for the strand's own
      // Instruction rail row). `parseInstructionKey` is the single source of
      // truth for the key shape; only `kind: "strand"` belongs here.
      .filter((r) => parseInstructionKey(r.key)?.kind === "strand")
      .map((r) => ({
        strand: r.strand,
        key: r.key,
        status: r.verifyStatus,
        provenance: r.provenance,
        title: r.title,
        subtitle: r.subtitle ?? null,
        atomKinds: (r.atoms ?? []).map((a) => a.kind),
        medium: instructionMedium(r.atoms ?? []),
        hasWorkedExample: (r.atoms ?? []).some((a) => a.kind === "worked_example"),
        version: r.version,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => a.strand.localeCompare(b.strand));
    // NODE-GRAIN segments (§3 `node:<nodeKey>`) — the twin of `strands`, keyed
    // by the anchor skill instead of a strand doorway. METADATA ONLY: the
    // Content-lens subscribes to this coverage read continuously, so it must
    // NOT carry every node segment's full atom stack + verify report (that
    // scales the payload + invalidation cost with the whole authored corpus).
    // The per-skill pane fetches the selected node's FULL segment separately
    // via `instructionSegmentForNode`, gated on this metadata list telling it a
    // segment exists. The surface-wide Instruction chip counts strand + node
    // segments together (a plain count — mixed grain has no honest
    // denominator), with the grain split in the chip's tooltip.
    const nodeSegments = inDomain
      .flatMap((r) => {
        const ref = parseInstructionKey(r.key);
        if (ref?.kind !== "node") return [];
        return [
          {
            nodeKey: ref.nodeKey,
            strand: r.strand,
            key: r.key,
            status: r.verifyStatus,
            provenance: r.provenance,
            title: r.title,
            subtitle: r.subtitle ?? null,
            atomKinds: (r.atoms ?? []).map((a) => a.kind),
            medium: instructionMedium(r.atoms ?? []),
            hasWorkedExample: (r.atoms ?? []).some((a) => a.kind === "worked_example"),
            version: r.version,
            updatedAt: r.updatedAt,
          },
        ];
      })
      .sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
    const anchors = INSTRUCTION_ANCHOR_STRANDS.filter((a) => a.domain === args.domain).map(
      (a) => a.strand,
    );
    return { domain: args.domain, strands, nodeSegments, anchors };
  },
});

/**
 * Teacher-facing full node-grain instructional segment for ONE skill (Math
 * Skills unified per-skill pane). The keyed twin of
 * `instructionLaunchpadForStrand`: `instructionCoverage.nodeSegments` lists only
 * metadata, so the pane fetches a skill's node-grain atom bodies here — and only
 * for the selected skill (skip when the metadata says the skill has no
 * node-grain segment), so the full atom stack is never in the always-on
 * coverage subscription. Returns null when the node has no stored node-grain
 * segment.
 */
export const instructionSegmentForNode = curriculumQuery({
  args: { nodeKey: v.string() },
  handler: async (ctx, args) => {
    const key = buildInstructionKey({ kind: "node", nodeKey: args.nodeKey });
    const rows: Doc<"instructionContent">[] = await ctx.db
      .query("instructionContent")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    let best: Doc<"instructionContent"> | null = null;
    for (const row of rows) {
      if (parseInstructionKey(row.key)?.kind !== "node") continue;
      if (!best || row.version > best.version) best = row;
    }
    if (!best || (best.atoms?.length ?? 0) === 0) return null;
    return {
      nodeKey: args.nodeKey,
      key: best.key,
      domain: best.domain,
      strand: best.strand,
      status: best.verifyStatus,
      provenance: best.provenance,
      title: best.title,
      subtitle: best.subtitle ?? null,
      atoms: best.atoms as InstructionAtom[],
      atomKinds: (best.atoms ?? []).map((a) => a.kind),
      medium: instructionMedium(best.atoms ?? []),
      hasWorkedExample: (best.atoms ?? []).some((a) => a.kind === "worked_example"),
      version: best.version,
      updatedAt: best.updatedAt,
      verifyReport: best.verifyReport ?? null,
    };
  },
});

/**
 * Teacher-facing Launchpad detail for one strand in a domain (Math Skills tab).
 * Unlike the scholar reopen queries, this returns the full stored catalog row —
 * including atom bodies and verify metadata — so curriculum users can inspect the
 * exact Launchpad attached to the strand-grained Instruction rail.
 */
export const instructionLaunchpadForStrand = curriculumQuery({
  args: { domain: v.string(), strand: v.string() },
  handler: async (ctx, args) => {
    const key = strandInstructionKey(args.domain, args.strand);
    const rows: Doc<"instructionContent">[] = await ctx.db
      .query("instructionContent")
      .withIndex("by_key", (q) => q.eq("key", key))
      .collect();
    let best: Doc<"instructionContent"> | null = null;
    for (const row of rows) {
      if (row.domain !== args.domain || row.strand !== args.strand) continue;
      if (!best || row.version > best.version) best = row;
    }
    if (!best || (best.atoms?.length ?? 0) === 0) return null;
    return {
      key: best.key,
      domain: best.domain,
      strand: best.strand,
      status: best.verifyStatus,
      provenance: best.provenance,
      title: best.title,
      subtitle: best.subtitle ?? null,
      atoms: best.atoms as InstructionAtom[],
      atomKinds: (best.atoms ?? []).map((a) => a.kind),
      medium: instructionMedium(best.atoms ?? []),
      hasWorkedExample: (best.atoms ?? []).some((a) => a.kind === "worked_example"),
      version: best.version,
      updatedAt: best.updatedAt,
      verifyReport: best.verifyReport ?? null,
    };
  },
});

/** Shared read: the highest-version PASSED, non-empty, PLATFORM-ELIGIBLE
 *  content for a key, or null. `platform` defaults to "web" — every row stored
 *  today carries `platforms: ["web", "native"]`, so the default is currently a
 *  no-op and only starts mattering once content diverges by platform. */
async function readPassedContent(ctx: QueryCtx, key: string, platform: InstructionPlatform = "web") {
  const rows: Doc<"instructionContent">[] = await ctx.db
    .query("instructionContent")
    .withIndex("by_key_status", (q) => q.eq("key", key).eq("verifyStatus", "passed"))
    .collect();
  const eligible = rows.filter((r) => (r.platforms ?? []).includes(platform));
  if (eligible.length === 0) return null;
  const best = eligible.reduce((a, b) => (b.version > a.version ? b : a));
  const unavailableVideoIds = new Set(best.unavailableVideoIds ?? []);
  const atoms = (best.atoms as InstructionAtom[]).filter(
    (atom) => atom.kind !== "video" || !unavailableVideoIds.has(atom.videoId),
  );
  if (atoms.length === 0) return null;
  return {
    key: best.key,
    title: best.title,
    subtitle: best.subtitle,
    atoms,
    contentVersion: best.version,
  };
}

const videoHealthStatusValidator = v.union(
  v.literal("alive"),
  v.literal("dead"),
  v.literal("unknown"),
);

/**
 * Lightweight read for the Node action. Database scans stay in this Convex
 * query; the action only performs the external checks and orchestrates writes.
 */
export const listPassedVideoContent = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<"instructionContent">[] = await ctx.db
      .query("instructionContent")
      .filter((q) => q.eq(q.field("verifyStatus"), "passed"))
      .collect();

    return rows.flatMap((row) => {
      const videoIds = [
        ...new Set(
          (row.atoms as InstructionAtom[])
            .filter((atom) => atom.kind === "video")
            .map((atom) => atom.videoId),
        ),
      ];
      return videoIds.length > 0 ? [{ contentId: row._id, videoIds }] : [];
    });
  },
});

/**
 * Apply one row's health results. UNKNOWN deliberately preserves the prior
 * unavailable state: a transient timeout, rate limit, or YouTube 5xx must never
 * blank otherwise-working instruction for every scholar. Only DEAD may add an
 * id, while ALIVE removes it so recovered clips return automatically.
 */
export const recordVideoHealthResults = internalMutation({
  args: {
    contentId: v.id("instructionContent"),
    checkedAt: v.number(),
    results: v.array(
      v.object({
        videoId: v.string(),
        status: videoHealthStatusValidator,
      }),
    ),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.contentId);
    if (!row) return;

    const rowVideoIds = [
      ...new Set(
        (row.atoms as InstructionAtom[])
          .filter((atom) => atom.kind === "video")
          .map((atom) => atom.videoId),
      ),
    ];
    const rowVideoIdSet = new Set(rowVideoIds);
    const unavailable = new Set(
      (row.unavailableVideoIds ?? []).filter((videoId) => rowVideoIdSet.has(videoId)),
    );
    let hasKnownResult = false;

    for (const result of args.results) {
      if (!rowVideoIdSet.has(result.videoId) || result.status === "unknown") continue;
      hasKnownResult = true;
      if (result.status === "dead") unavailable.add(result.videoId);
      else unavailable.delete(result.videoId);
    }

    const patch: {
      videosCheckedAt: number;
      unavailableVideoIds?: string[];
    } = { videosCheckedAt: args.checkedAt };
    if (hasKnownResult) {
      patch.unavailableVideoIds = rowVideoIds.filter((videoId) => unavailable.has(videoId));
    }
    await ctx.db.patch(row._id, patch);
  },
});

// ─── Content store + seed (generate → verify → store) ─────────────────────────

const instructionAtomValidator = v.union(
  v.object({
    kind: v.literal("story_hook"),
    hook: v.string(),
    fromKey: v.optional(v.string()),
    toKey: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("micro_explain"), text: v.string() }),
  v.object({
    kind: v.literal("worked_example"),
    strategyLabel: v.string(),
    steps: v.array(v.string()),
    examplePrompt: v.string(),
    exampleAnswer: v.string(),
  }),
  v.object({
    kind: v.literal("try_it"),
    strategyLabel: v.string(),
    steps: v.array(v.string()),
    examplePrompt: v.string(),
    exampleAnswer: v.string(),
    answerType: v.optional(
      v.union(
        v.literal("integer"),
        v.literal("decimal"),
        v.literal("fraction"),
        v.literal("expression"),
        v.literal("multipleChoice"),
      ),
    ),
  }),
  v.object({ kind: v.literal("manipulative"), spec: v.string() }),
);

type StoreResult = { key: string; status: "passed" | "failed"; version: number; report: string };

/**
 * Shared store path for BOTH authored seed and machine generation: verify, then
 * upsert one row per key (bumping `version` only when the content actually
 * changed). Content that fails verification is stored with `verifyStatus:"failed"`
 * so it is auditable but NEVER served (the selector reads `verifyStatus:"passed"`).
 *
 * Key-space (§3): when `nodeKey` is set, the stored KEY is the node grain
 * (`node:<nodeKey>`) rather than the strand doorway grain — `domain`/`strand`
 * are still carried on the row (the node's own domain/strand, for the teacher
 * inventory + anchor reporting), but resolution (`instructionContentForNode`)
 * reads the row by its `node:` key. Additive: every existing strand-grain
 * caller (the authored seed, `practiceGen.generateInstructionContent`) omits
 * `nodeKey` and is byte-for-byte unchanged.
 */
async function storeLaunchpad(
  ctx: MutationCtx,
  lp: {
    domain: string;
    strand: string;
    title: string;
    subtitle?: string;
    atoms: SeedInstructionAtom[];
    provenance: "authored" | "generated";
    /** When set, store under the NODE grain (`node:<nodeKey>`) instead of the
     *  strand doorway grain. */
    nodeKey?: string;
  },
): Promise<StoreResult> {
  const key = lp.nodeKey
    ? buildInstructionKey({ kind: "node", nodeKey: lp.nodeKey })
    : strandInstructionKey(lp.domain, lp.strand);
  const result = verifyInstructionContent({ title: lp.title, subtitle: lp.subtitle, atoms: lp.atoms });
  const now = Date.now();
  const existing: Doc<"instructionContent"> | null = await ctx.db
    .query("instructionContent")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const base = {
    key,
    domain: lp.domain,
    strand: lp.strand,
    title: lp.title,
    subtitle: lp.subtitle,
    atoms: lp.atoms,
    provenance: lp.provenance,
    verifyStatus: result.status,
    verifyReport: result.report,
    // Both surfaces render Launchpads since P1 (web `LaunchpadCard.tsx` +
    // native `native/src/components/practice/LaunchpadCard.tsx`).
    platforms: ["web", "native"],
    updatedAt: now,
  };
  if (existing) {
    const changed =
      JSON.stringify(existing.atoms) !== JSON.stringify(lp.atoms) ||
      existing.title !== lp.title ||
      existing.subtitle !== lp.subtitle;
    const version = changed ? existing.version + 1 : existing.version;
    await ctx.db.patch(existing._id, { ...base, version });
    return { key, status: result.status, version, report: result.report };
  }
  await ctx.db.insert("instructionContent", { ...base, version: 1, createdAt: now });
  return { key, status: result.status, version: 1, report: result.report };
}

/** Store a single Launchpad (used by practiceGen.generateInstructionContent
 *  and, node-grain, a future §3 generation pass). */
export const storeInstructionContent = internalMutation({
  args: {
    domain: v.string(),
    strand: v.string(),
    title: v.string(),
    subtitle: v.optional(v.string()),
    atoms: v.array(instructionAtomValidator),
    provenance: v.union(v.literal("authored"), v.literal("generated")),
    // §3 key space: when set, stores under `node:<nodeKey>` instead of the
    // strand doorway grain `strand:<domain>:<strand>`. Additive — omitted by
    // every existing caller, which is byte-for-byte unchanged.
    nodeKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<StoreResult> => {
    return await storeLaunchpad(ctx, args);
  },
});

/**
 * Seed all authored Launchpads through the verify→store gate (idempotent), then
 * report coverage over the designated anchor strands. A designated anchor with no
 * PASSED content is surfaced in `missingAnchors` — never a silent gap.
 *
 * Exported as a plain helper (not just a mutation) because a Convex mutation
 * cannot `runMutation` another mutation: the dev fixture seeders in
 * `convex/seed/launchpadDemo.ts` are themselves mutations and need to call this
 * inline. Without it a `pnpm db:reset` leaves `instructionContent` EMPTY, the
 * selector's `hasContent` gate is false for every strand, and the Launchpad
 * silently never appears for the very fixtures that exist to demo it.
 */
export async function seedAuthoredInstructionInto(ctx: MutationCtx): Promise<{
  stored: number;
  passed: number;
  failed: { key: string; report: string }[];
  missingAnchors: string[];
}> {
  const results: StoreResult[] = [];
  for (const lp of AUTHORED_LAUNCHPADS) {
    results.push(await storeLaunchpad(ctx, { ...lp, provenance: "authored" }));
  }
  const passedKeys = new Set(results.filter((r) => r.status === "passed").map((r) => r.key));
  const missingAnchors = INSTRUCTION_ANCHOR_STRANDS.filter(
    (a) => !passedKeys.has(strandInstructionKey(a.domain, a.strand)),
  ).map((a) => strandInstructionKey(a.domain, a.strand));
  return {
    stored: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").map((r) => ({ key: r.key, report: r.report })),
    missingAnchors,
  };
}

export const seedAuthoredInstruction = internalMutation({
  args: {},
  handler: async (ctx) => await seedAuthoredInstructionInto(ctx),
});
