import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { authedQuery, authedMutation, authedAction } from "./lib/customFunctions";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isTeacherRole, ROLES } from "./lib/roles";
import { requireTeacherOrSelf } from "./lib/auth";
import {
  requireActiveScholarAccess,
  resolveActiveMembership,
} from "./lib/access";
import { geminiGenerateImage } from "./lib/gemini";
import { toStorageBlob, readImageSize } from "./lib/imageBytes";
import { buildFaithfulSlideImagePrompt } from "./lib/slideImageFidelity";
import { recordImageUsage } from "./usage";
import { llmBudgetExceeded } from "./llmBudget";
import { validateSpec, validateScholarPins } from "../lib/geomap/validate";
import { applyGeoMapOps, type GeoMapOp } from "../lib/geomap/patch";
import { registryKeys } from "../lib/geomap/registry";
import { historicalBasemapKeys } from "../lib/geomap/historicalBasemaps";
import type {
  GeoMapSpec,
  StoredMapArtifact,
} from "../lib/geomap/types";
import {
  parseStoredMapArtifact,
  projectStoredMapForScholar,
} from "../lib/geomap/stored";
import {
  validateManipulativeSpec,
  type StoredManipulativeArtifact,
} from "../lib/manipulative/validate";
import {
  applySlideOps,
  emptyDeck,
  makeDeckIdFactory,
  summarizeDeckForModel,
  validateDeck,
  type Deck,
  type SlideOp,
} from "../shared/slidesScene";
import { findExactlyOneLiteral } from "./lib/exactTextMatch";
import { isTextArtifact } from "../shared/textArtifacts";

function artifactState(artifact: {
  _id: Id<"artifacts">;
  title: string;
  content: string;
  lastEditedBy: "scholar" | "ai";
  type?: "text" | "code" | "map" | "slides" | "manipulative";
  language?: string;
  revision?: number;
}) {
  return {
    _id: artifact._id,
    title: artifact.title,
    content: artifact.content,
    lastEditedBy: artifact.lastEditedBy,
    type: artifact.type,
    language: artifact.language,
    revision: artifact.revision ?? 0,
  };
}

function editResult(
  artifact: Parameters<typeof artifactState>[0],
  baseRevision: number | undefined,
) {
  if (!isTextArtifact(artifact)) {
    return {
      kind: "refused" as const,
      error: "Structured artifacts must be edited with their own tool.",
      artifact: artifactState(artifact),
    };
  }
  const currentRevision = artifact.revision ?? 0;
  const compatibleLegacyWrite =
    baseRevision === undefined && artifact.revision === undefined;
  if (baseRevision !== currentRevision && !compatibleLegacyWrite) {
    return { kind: "conflict" as const, artifact: artifactState(artifact) };
  }
  return { kind: "ready" as const, currentRevision };
}

/**
 * Get all artifacts for a session (reactive, used by ArtifactPanel).
 * Returns array sorted by creation time.
 */
export const getBySession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return [];
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return [];
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }

    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .collect();
    // No-spoiler redaction on the scholar's own live map surface (this is the
    // read the web SessionInterface + native GeoMapCard use). Teachers/staff
    // keep the raw spec.
    if (isTeacher) return rows;
    return rows.map(redactMapRowForScholar);
  },
});

/**
 * Scholar saves edits to artifact content (by artifact ID).
 */
export const scholarUpdate = authedMutation({
  args: {
    artifactId: v.id("artifacts"),
    content: v.optional(v.string()),
    title: v.optional(v.string()),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new Error("Artifact not found");
    const session = await ctx.db.get(artifact.sessionId);
    if (!session) throw new Error("Artifact session not found");
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    if (!isTextArtifact(artifact)) {
      throw new Error("Structured artifacts must be edited with their own tool.");
    }
    const currentRevision = artifact.revision ?? 0;
    const compatibleLegacyWrite =
      args.baseRevision === undefined && artifact.revision === undefined;
    if (args.baseRevision !== currentRevision && !compatibleLegacyWrite) {
      return {
        ok: false as const,
        conflict: true as const,
        artifact: {
          _id: artifact._id,
          title: artifact.title,
          content: artifact.content,
          revision: currentRevision,
          lastEditedBy: artifact.lastEditedBy,
        },
      };
    }
    const patch: {
      content?: string;
      title?: string;
      lastEditedBy: "scholar";
      revision?: number;
      hasTutorTranscription?: boolean;
      tutorTranscribedExcerpts?: string[];
    } = {
      lastEditedBy: "scholar",
    };
    if (args.content !== undefined) patch.content = args.content;
    if (args.title !== undefined) patch.title = args.title;
    // The transcription marker describes the TEXT, not the document's history.
    // A scholar who rewrites the passage the tutor typed for them has taken
    // authorship of it back, so re-verify the recorded excerpts against the new
    // content rather than letting the marker stick. Erring toward keeping it:
    // only an excerpt that is no longer present verbatim is dropped.
    if (args.content !== undefined && artifact.hasTutorTranscription) {
      const nextContent = args.content;
      const stillPresent = (artifact.tutorTranscribedExcerpts ?? []).filter(
        (excerpt) => nextContent.includes(excerpt),
      );
      patch.tutorTranscribedExcerpts = stillPresent;
      patch.hasTutorTranscription = stillPresent.length > 0;
    }
    const changed =
      (args.content !== undefined && args.content !== artifact.content) ||
      (args.title !== undefined && args.title !== artifact.title);
    if (changed) {
      patch.revision = currentRevision + 1;
      await ctx.db.patch(artifact._id, patch);
      return { ok: true as const, revision: patch.revision };
    }
    return { ok: true as const, revision: currentRevision };
  },
});

/**
 * Scholar creates a new empty artifact.
 */
export const scholarCreate = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) throw new Error("Forbidden");
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }

    return await ctx.db.insert("artifacts", {
      sessionId: args.sessionId,
      title: args.title || "Untitled",
      content: "",
      lastEditedBy: "scholar",
      revision: 0,
    });
  },
});

/**
 * Scholar deletes an artifact.
 */
export const deleteArtifact = authedMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) return;
    const session = await ctx.db.get(artifact.sessionId);
    if (!session) return;
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return;
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }

    await ctx.db.delete(args.artifactId);
  },
});

/**
 * Get all artifacts across all sessions for a scholar (teacher-only).
 * Returns artifacts enriched with session title and ID, sorted newest first.
 */
export const getByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();

    const allArtifacts: {
      _id: string;
      _creationTime: number;
      title: string;
      content: string;
      lastEditedBy: "scholar" | "ai";
      sessionId: string;
      sessionTitle: string;
    }[] = [];

    for (const session of sessions) {
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();

      for (const artifact of artifacts) {
        // No-spoiler redaction: requireTeacherOrSelf returns isTeacher=false
        // for a scholar reading their own work, so redact graded map tasks.
        const content =
          !isTeacher && artifact.type === "map"
            ? redactMapTaskContent(artifact.content) ?? artifact.content
            : artifact.content;
        allArtifacts.push({
          _id: artifact._id,
          _creationTime: artifact._creationTime,
          title: artifact.title,
          content,
          lastEditedBy: artifact.lastEditedBy,
          sessionId: session._id,
          sessionTitle: session.title,
        });
      }
    }

    // Sort newest first
    allArtifacts.sort((a, b) => b._creationTime - a._creationTime);
    return allArtifacts;
  },
});

// ── Internal mutations for AI tool use ────────────────────────────────

function assertArtifactBelongsToSession(
  artifact: { sessionId: Id<"sessions"> } | null,
  sessionId: Id<"sessions">,
) {
  if (artifact && artifact.sessionId !== sessionId) {
    throw new Error("Artifact does not belong to session");
  }
}

/**
 * AI creates a new artifact for a session (no longer deletes existing).
 * Returns the new artifact _id.
 */
export const aiCreate = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    content: v.string(),
    type: v.optional(v.union(v.literal("text"), v.literal("code"))),
    language: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("artifacts", {
      sessionId: args.sessionId,
      title: args.title,
      content: args.content,
      lastEditedBy: "ai",
      revision: 0,
      ...(args.type ? { type: args.type } : {}),
      ...(args.language ? { language: args.language } : {}),
    });
    return id;
  },
});

/**
 * AI replaces text in artifact content (str_replace).
 * Accepts optional artifactId; falls back to first artifact for backwards compat.
 */
export const aiStrReplace = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    oldStr: v.string(),
    newStr: v.string(),
    artifactId: v.optional(v.id("artifacts")),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let artifact;
    if (args.artifactId) {
      artifact = await ctx.db.get(args.artifactId);
      assertArtifactBelongsToSession(artifact, args.sessionId);
    } else {
      artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) =>
          q.eq("sessionId", args.sessionId)
        )
        .collect()
        .then((rows) => rows.find(isTextArtifact) ?? null);
    }
    if (!artifact) {
      return { kind: "refused" as const, error: "Error: No document exists yet. Use create first." };
    }
    const result = editResult(artifact, args.baseRevision);
    if (result.kind !== "ready") return result;
    const match = findExactlyOneLiteral(artifact.content, args.oldStr);
    if (match.kind === "invalid") {
      return {
        kind: "refused" as const,
        error: "Error: old_str must not be empty.",
      };
    }
    if (match.kind === "none") {
      return { kind: "refused" as const, error: "Error: old_str not found in document. Make sure it matches exactly, including whitespace and line breaks." };
    }
    if (match.kind === "many") {
      return { kind: "refused" as const, error: "Error: old_str matches multiple places. Re-view the document and provide a unique exact match." };
    }
    const newContent =
      artifact.content.slice(0, match.index) +
      args.newStr +
      artifact.content.slice(match.index + args.oldStr.length);
    await ctx.db.patch(artifact._id, {
      content: newContent,
      lastEditedBy: "ai",
      revision: result.currentRevision + 1,
    });
    return {
      kind: "success" as const,
      artifact: artifactState({
        ...artifact,
        content: newContent,
        lastEditedBy: "ai",
        revision: result.currentRevision + 1,
      }),
    };
  },
});

/**
 * AI inserts text at a line number (0 = beginning).
 * Accepts optional artifactId; falls back to first artifact for backwards compat.
 */
export const aiInsert = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    insertLine: v.number(),
    insertText: v.string(),
    artifactId: v.optional(v.id("artifacts")),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let artifact;
    if (args.artifactId) {
      artifact = await ctx.db.get(args.artifactId);
      assertArtifactBelongsToSession(artifact, args.sessionId);
    } else {
      artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) =>
          q.eq("sessionId", args.sessionId)
        )
        .collect()
        .then((rows) => rows.find(isTextArtifact) ?? null);
    }
    if (!artifact) return { kind: "refused" as const, error: "Error: No document exists yet. Use create first." };
    const result = editResult(artifact, args.baseRevision);
    if (result.kind !== "ready") return result;
    const lines = artifact.content.split("\n");
    const lineNum = Math.max(0, Math.min(args.insertLine, lines.length));
    lines.splice(lineNum, 0, args.insertText);
    await ctx.db.patch(artifact._id, {
      content: lines.join("\n"),
      lastEditedBy: "ai",
      revision: result.currentRevision + 1,
    });
    return {
      kind: "success" as const,
      artifact: artifactState({
        ...artifact,
        content: lines.join("\n"),
        lastEditedBy: "ai",
        revision: result.currentRevision + 1,
      }),
    };
  },
});

/**
 * The tutor writes the scholar's OWN words into their document.
 *
 * Deliberately separate from aiInsert, because the provenance differs and that
 * difference is consequential: the rubric grades this text, so a teacher reading
 * the deliverable later has to be able to tell "she wrote it" from "she said it
 * and the tutor typed it". `lastEditedBy` is a binary scholar|ai union that
 * cannot carry that distinction, so we stamp `hasTutorTranscription` alongside
 * it. Sticky once set: the document goes on containing transcribed words no
 * matter who edits it next, and un-setting it would overstate the scholar's
 * authorship.
 *
 * Appends rather than taking a line number — the tutor is copying down what the
 * scholar just said, not making a structural edit, and a child watching the box
 * should see their own sentence land at the end of it.
 */
export const aiTranscribe = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
    artifactId: v.optional(v.id("artifacts")),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) {
      return {
        kind: "refused" as const,
        error: "Error: transcribe requires the scholar's own words in transcribe_text.",
      };
    }
    let artifact;
    if (args.artifactId) {
      artifact = await ctx.db.get(args.artifactId);
      assertArtifactBelongsToSession(artifact, args.sessionId);
    } else {
      artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect()
        .then((rows) => rows.find(isTextArtifact) ?? null);
    }
    if (!artifact) {
      return {
        kind: "refused" as const,
        error: "Error: No document exists yet. Use create first.",
      };
    }
    const result = editResult(artifact, args.baseRevision);
    if (result.kind !== "ready") return result;
    const content = artifact.content.trim()
      ? `${artifact.content}\n${text}`
      : text;
    await ctx.db.patch(artifact._id, {
      content,
      lastEditedBy: "ai",
      hasTutorTranscription: true,
      // Kept so a later scholar edit can re-verify whether the transcribed
      // words are still on the page (see scholarUpdate).
      tutorTranscribedExcerpts: [
        ...(artifact.tutorTranscribedExcerpts ?? []),
        text,
      ],
      revision: result.currentRevision + 1,
    });
    return {
      kind: "success" as const,
      artifact: artifactState({
        ...artifact,
        content,
        lastEditedBy: "ai",
        revision: result.currentRevision + 1,
      }),
    };
  },
});

/**
 * AI renames an artifact.
 * Accepts optional artifactId; falls back to first artifact for backwards compat.
 */
export const aiRename = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.string(),
    artifactId: v.optional(v.id("artifacts")),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let artifact;
    if (args.artifactId) {
      artifact = await ctx.db.get(args.artifactId);
      assertArtifactBelongsToSession(artifact, args.sessionId);
    } else {
      artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) =>
          q.eq("sessionId", args.sessionId)
        )
        .collect()
        .then((rows) => rows.find(isTextArtifact) ?? null);
    }
    if (!artifact) return { kind: "refused" as const, error: "Error: No document exists yet. Use create first." };
    const result = editResult(artifact, args.baseRevision);
    if (result.kind !== "ready") return result;
    if (artifact.title === args.title) {
      return { kind: "success" as const, artifact: artifactState(artifact) };
    }
    await ctx.db.patch(artifact._id, {
      title: args.title,
      lastEditedBy: "ai",
      revision: result.currentRevision + 1,
    });
    return {
      kind: "success" as const,
      artifact: artifactState({
        ...artifact,
        title: args.title,
        lastEditedBy: "ai",
        revision: result.currentRevision + 1,
      }),
    };
  },
});

/**
 * AI reads artifact content (for view command).
 * Returns all artifacts when no artifactId specified.
 */
export const aiGetContent = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    artifactId: v.optional(v.id("artifacts")),
  },
  handler: async (ctx, args) => {
    if (args.artifactId) {
      const artifact = await ctx.db.get(args.artifactId);
      assertArtifactBelongsToSession(artifact, args.sessionId);
      return artifact ? artifactState(artifact) : null;
    }
    // Return all artifacts for the session
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) =>
        q.eq("sessionId", args.sessionId)
      )
      .collect();
    return artifacts.filter(isTextArtifact).map(artifactState);
  },
});

// ── GeoMap artifacts (the show_map tool + scholar pins) ───────────────
//
// A session holds at most ONE `type: "map"` artifact (the one-map rule, plan
// §8). Its `content` is a JSON `StoredMapArtifact` = { v, spec, scholarPins }:
// `spec` is the tutor's namespace (written by show_map), `scholarPins` is the
// kid's (written by scholarSetMapPins). The two are merged, never clobbered:
// show_map `create` resets pins, `patch` preserves them; scholarSetMapPins
// never touches `spec`. Every spec passes `validateSpec` (the governance gate)
// before it is stored — a raw style URL / unknown registry key never lands.

/** Find the session's single map artifact, if any. */
async function findMapArtifact(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const rows = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return rows.find((a) => a.type === "map") ?? null;
}

function parseStored(content: string): StoredMapArtifact | null {
  return parseStoredMapArtifact(content);
}

function newSpecId(): string {
  return `map-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A graded task is dead on arrival unless the scholar can actually drop a pin:
 * both renderers default `tapToPin` to `!spec.task`, so a task would silently
 * DISABLE tapping (no pins → the commit button stays disabled → the SERVER
 * CHECK verdict is stuck at "not yet solved"). Enforce tap-to-pin server-side
 * whenever a task is present so every surface agrees. Mutates in place.
 */
function enableTapToPinForTask(spec: GeoMapSpec): void {
  if (!spec.task) return;
  spec.interactions = { ...(spec.interactions ?? {}), tapToPin: true };
}

/**
 * AI creates (or replaces) the session's map from a full GeoMapSpec.
 * One-map rule: if a map artifact already exists we REPLACE its content — the
 * new spec with a FRESH empty `scholarPins` (create resets the kid's marks) —
 * and reuse that row; otherwise we insert. Returns { artifactId, reused }.
 * On validation failure returns { error } so the tool can surface the reason.
 */
export const aiCreateMapArtifact = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.optional(v.string()),
    specJson: v.string(),
  },
  handler: async (ctx, args) => {
    let raw: unknown;
    try {
      raw = JSON.parse(args.specJson);
    } catch {
      return { error: "spec must be valid JSON" as const };
    }
    if (!raw || typeof raw !== "object") {
      return { error: "spec must be an object" as const };
    }
    const spec = raw as GeoMapSpec;
    // Inject the contract version + an id if the model omitted them.
    spec.v = 1;
    if (typeof spec.id !== "string" || !spec.id.trim()) spec.id = newSpecId();

    const result = validateSpec(spec, {
      registryKeys: registryKeys(),
      historicalBasemapKeys: historicalBasemapKeys(),
    });
    if (!result.ok) return { error: result.reason };

    enableTapToPinForTask(spec);
    const stored: StoredMapArtifact = { v: 1, spec, scholarPins: [] };
    const content = JSON.stringify(stored);
    const title = args.title?.trim() || spec.title?.trim() || "Map";

    const existing = await findMapArtifact(ctx, args.sessionId);
    if (existing) {
      const revision = (existing.revision ?? 0) + 1;
      await ctx.db.patch(existing._id, {
        title,
        content,
        lastEditedBy: "ai",
        revision,
      });
      return { artifactId: existing._id, reused: true, revision };
    }
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId: args.sessionId,
      title,
      content,
      lastEditedBy: "ai",
      type: "map",
      revision: 0,
    });
    return { artifactId, reused: false, revision: 0 };
  },
});

/**
 * Read the exact current map spec before an AI patch. The compact MAP prompt
 * deliberately omits bulky GeoJSON, so this is the model's source of truth when
 * a scholar reports a bad path or the tutor needs to edit existing geometry.
 */
export const aiReadMapArtifact = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const artifact = rows.find((row) => row.type === "map") ?? null;
    if (!artifact) {
      return { error: "No map exists for this session yet." as const };
    }
    const stored = parseStored(artifact.content);
    if (!stored) return { error: "Map content is corrupt" as const };
    return {
      artifactId: artifact._id,
      revision: artifact.revision ?? 0,
      spec: stored.spec,
    };
  },
});

/**
 * Apply an id-addressed, all-or-nothing map operation batch. A stale revision is
 * refused rather than overwriting a newer tutor edit. Scholar pins are read
 * inside the transaction and preserved verbatim.
 */
export const aiApplyMapOps = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    opsJson: v.string(),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await findMapArtifact(ctx, args.sessionId);
    if (!existing) {
      return {
        error: "No map exists yet. Use show_map with op:\"create\" first." as const,
      };
    }
    const currentRevision = existing.revision ?? 0;
    if (args.baseRevision === undefined) {
      return {
        error:
          'baseRevision is required. Call show_map with op:"read" before patching.',
      };
    }
    if (args.baseRevision !== currentRevision) {
      return {
        error:
          `Your view of the map is stale (you saw revision ${args.baseRevision}, ` +
          `it is now ${currentRevision}). Read the map again before editing.`,
        staleRevision: currentRevision,
      };
    }

    let ops: unknown;
    try {
      ops = JSON.parse(args.opsJson);
    } catch {
      return { error: "ops must be valid JSON" as const };
    }
    if (!Array.isArray(ops)) return { error: "ops must be an array" as const };

    const prior = parseStored(existing.content);
    if (!prior) return { error: "Map content is corrupt" as const };
    const applied = applyGeoMapOps(prior.spec, ops as GeoMapOp[]);
    if (!applied.ok) return { error: applied.error };

    const result = validateSpec(applied.spec, {
      registryKeys: registryKeys(),
      historicalBasemapKeys: historicalBasemapKeys(),
    });
    if (!result.ok) return { error: result.reason };

    enableTapToPinForTask(applied.spec);
    const stored: StoredMapArtifact = {
      v: 1,
      spec: applied.spec,
      scholarPins: prior.scholarPins,
    };
    const revision = currentRevision + 1;
    await ctx.db.patch(existing._id, {
      title: applied.spec.title?.trim() || existing.title,
      content: JSON.stringify(stored),
      lastEditedBy: "ai",
      revision,
    });
    return { artifactId: existing._id, revision };
  },
});

/**
 * Read one artifact by id (reactive; used by the GeoMap renderer host).
 * Access: the session owner or staff (mirrors getBySession's gate).
 */
export const getById = authedQuery({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) return null;
    const session = await ctx.db.get(artifact.sessionId);
    if (!session) return null;
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return null;
    if (isTeacher && session.userId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    // No-spoiler redaction: a scholar (owner) must never receive a graded
    // task's answer-bearing fields. Teachers/staff keep the raw spec.
    if (!isTeacher) return redactMapRowForScholar(artifact);
    return artifact;
  },
});

/**
 * No-spoiler redaction (pure string→string). Given a stored map artifact's
 * JSON `content`, return a re-serialized copy with `spec.task` replaced by
 * `redactTaskForClient(spec.task)`. Valid taskless maps keep their original
 * content; malformed content returns null so callers can keep it as-is.
 * A graded task's answer-bearing fields (target / targets[].lngLat /
 * targetRegion.registry) must never ship to the scholar's client; grading is
 * server-side (lib/geomap/grade.ts).
 */
function redactMapTaskContent(content: string): string | null {
  return projectStoredMapForScholar(content);
}

/**
 * Apply {@link redactMapTaskContent} to a full artifact row for a NON-teacher
 * (scholar/owner) read: redacts map rows, passes everything else through
 * untouched. Teachers/staff must not route through this — they receive the raw
 * spec. Used by every scholar-reachable read that returns artifact content
 * (getBySession, getByScholar, getById) so the answer never leaves the server.
 */
function redactMapRowForScholar<T extends { type?: string; content: string }>(
  row: T,
): T {
  if (row.type !== "map") return row;
  const redacted = redactMapTaskContent(row.content);
  return redacted === null ? row : { ...row, content: redacted };
}

/**
 * Scholar persists their own pins on a map artifact. OWNER only (a pin is the
 * kid's answer/annotation — staff never write it). Validates the untrusted pins
 * and writes ONLY `scholarPins`, leaving the tutor's `spec` untouched.
 */
export const scholarSetMapPins = authedMutation({
  args: {
    artifactId: v.id("artifacts"),
    pins: v.array(
      v.object({
        id: v.string(),
        lngLat: v.array(v.number()),
        label: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new Error("Map not found");
    if (artifact.type !== "map") throw new Error("Not a map artifact");
    const session = await ctx.db.get(artifact.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== ctx.user._id) throw new Error("Forbidden");

    const check = validateScholarPins(args.pins);
    if (!check.ok) throw new Error(check.reason);

    const prior = parseStored(artifact.content);
    if (!prior) throw new Error("Map content is corrupt");
    const pins = args.pins.map((p) => ({
      id: p.id,
      lngLat: [p.lngLat[0], p.lngLat[1]] as [number, number],
      ...(p.label !== undefined ? { label: p.label } : {}),
    }));
    const stored: StoredMapArtifact = {
      v: 1,
      spec: prior.spec,
      scholarPins: pins,
    };
    await ctx.db.patch(artifact._id, {
      content: JSON.stringify(stored),
      lastEditedBy: "scholar",
    });
  },
});

// ── Manipulative artifacts (the show_manipulative tool) ───────────────
//
// A "manipulative" artifact stores a JSON `StoredManipulativeArtifact`
// ({ v, spec }) in `content` — one ad-hoc, ungraded, poke-able manipulative the
// tutor drops into a live session for Socratic exploration. Same envelope as
// "map"/"slides": structured JSON validated server-side before storage. Unlike
// "map" there is NO one-per-session rule (like create_code, every call inserts
// a fresh row) and no scholar-pins namespace — a manipulative is poked in place,
// not co-authored, so it carries no scholar-write contract.

function newManipulativeSpecId(): string {
  return `manip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * AI drops a new manipulative into the session from a full ManipulativeSpec.
 * Always inserts (no singleton rule). Maps are the show_map tool's job, so a
 * geoLocate spec is refused here with a pointer to show_map. Every other spec
 * passes `validateManipulativeSpec` before it lands; on any failure returns
 * { error } so the tool can surface the reason for the model to self-correct.
 */
export const aiCreateManipulativeArtifact = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.optional(v.string()),
    specJson: v.string(),
  },
  handler: async (ctx, args) => {
    let raw: unknown;
    try {
      raw = JSON.parse(args.specJson);
    } catch {
      return { error: "spec must be valid JSON" as const };
    }
    if (!raw || typeof raw !== "object") {
      return { error: "spec must be an object" as const };
    }
    const draft = raw as { id?: unknown; kind?: unknown };
    // Inject an id if the model omitted one (mirrors the map path).
    if (typeof draft.id !== "string" || !draft.id.trim()) {
      draft.id = newManipulativeSpecId();
    }
    if (draft.kind === "geoLocate") {
      return {
        error: "Maps are the show_map tool's job — call show_map instead." as const,
      };
    }

    // Typed-answer items are graded practice — that seam is serve_practice_problem's
    // (grading lives server-side there, one code path for web + native). Supporting
    // a typed `answer` here would fork grading, so refuse it in the mutation (policy,
    // like the geoLocate refusal above — NOT the domain-honest validator's job).
    if ((raw as { answer?: unknown }).answer != null) {
      return {
        error:
          "Typed-answer items are graded practice — serve them with serve_practice_problem. Use a goal (or no goal) here instead." as const,
      };
    }

    const result = validateManipulativeSpec(raw);
    if (!result.ok) return { error: result.reason };

    const stored: StoredManipulativeArtifact = { v: 1, spec: result.spec };
    const title =
      args.title?.trim() || result.spec.concept?.trim() || "Hands-on model";
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId: args.sessionId,
      title,
      content: JSON.stringify(stored),
      lastEditedBy: "ai",
      type: "manipulative",
      revision: 0,
    });
    return { artifactId };
  },
});

// ─── Slides decks ────────────────────────────────────────────────────────
//
// A "slides" artifact stores a JSON `Deck` (shared/slidesScene.ts) in
// `content`. It follows the "map" precedent — structured JSON in the artifact
// envelope, validated server-side before every write, no new table.
//
// ONE DIFFERENCE FROM MAP, and it is deliberate. The map splits the document
// into a tutor-owned `spec` and a scholar-owned `scholarPins`, so the two can
// never clobber each other. A deck has no such split: the AI and the scholar
// edit the SAME elements. Safety therefore comes from two other places —
//   • every write goes through `applySlideOps`, which is id-addressed, so two
//     edits to different elements commute instead of overwriting each other;
//   • `baseRevision` lets a caller that read the deck some seconds ago (i.e. a
//     model that has been thinking) be told its view is stale rather than
//     silently overwriting work the scholar did in the meantime.
// Never write a whole deck read earlier — that is the one operation that CAN
// destroy concurrent work despite Convex's serializability.

/**
 * Mint ids that are unique within a deck WITHOUT randomness. Convex mutations
 * can be retried, so id minting must be a pure function of the current deck —
 * a random id would differ between attempts. Scans the existing ids for the
 * highest `<prefix><n>` suffix and counts up from there.
 */

async function findSlidesArtifact(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const rows = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return rows.find((a) => a.type === "slides") ?? null;
}

function parseDeck(content: string): Deck | null {
  try {
    const result = validateDeck(JSON.parse(content));
    return result.ok ? result.deck : null;
  } catch {
    return null;
  }
}

/**
 * Create (or replace) the session's deck from a whole-deck JSON payload.
 * Used for the FIRST write only — after that the model patches with
 * `aiApplySlideOps`, so it can never clobber the scholar's edits wholesale.
 */
export const aiCreateSlidesDeck = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    title: v.optional(v.string()),
    deckJson: v.string(),
  },
  handler: async (ctx, args) => {
    let raw: unknown;
    try {
      raw = JSON.parse(args.deckJson);
    } catch {
      return { error: "deck must be valid JSON" as const };
    }
    const result = validateDeck(raw);
    if (!result.ok) return { error: result.errors.join("; ") };

    const deck = result.deck;
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { error: "Session not found" as const };
    const foreign = await rejectForeignAssets(ctx, deck, session.userId);
    if (foreign) return { error: foreign };
    if (args.title?.trim()) deck.title = args.title.trim().slice(0, 200);
    const content = JSON.stringify(deck);

    const existing = await findSlidesArtifact(ctx, args.sessionId);
    if (existing) {
      // REFUSE. The comment above says whole-deck writes are for the first write
      // only; the server used to not enforce it, so a model calling `create` a
      // second time — a normal thing for a model to do in a later turn —
      // replaced the deck wholesale and every scholar edit absent from its
      // payload vanished. That is precisely the whole-document overwrite this
      // design exists to prevent (found by review).
      //
      // Returned as an { error } the model can act on, matching how every other
      // failure on this path is reported, so it re-reads and patches instead.
      return {
        error:
          'A deck already exists for this session. Use op:"read" then op:"patch" to change it — creating again would discard the scholar\'s work.',
      };
    }
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId: args.sessionId,
      title: deck.title,
      content,
      lastEditedBy: "ai",
      type: "slides",
    });
    return { artifactId, reused: false, revision: deck.revision };
  },
});

/**
 * The model patches the deck with an id-addressed operation batch. Returns a
 * structured conflict (never an overwrite) when `baseRevision` is stale, so the
 * model re-reads instead of undoing the scholar.
 */
export const aiApplySlideOps = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    opsJson: v.string(),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await findSlidesArtifact(ctx, args.sessionId);
    if (!existing) {
      return { error: 'No deck exists yet. Create one first.' as const };
    }
    const deck = parseDeck(existing.content);
    if (!deck) return { error: "Deck content is corrupt" as const };

    if (args.baseRevision !== undefined && args.baseRevision !== deck.revision) {
      return {
        error:
          `Your view of the deck is stale (you saw revision ${args.baseRevision}, ` +
          `it is now ${deck.revision}). Read the deck again before editing.`,
        staleRevision: deck.revision,
      };
    }

    let ops: unknown;
    try {
      ops = JSON.parse(args.opsJson);
    } catch {
      return { error: "ops must be valid JSON" as const };
    }
    if (!Array.isArray(ops)) return { error: "ops must be an array" as const };

    const applied = applySlideOps(deck, ops as SlideOp[], makeDeckIdFactory(deck));
    if (!applied.ok) return { error: applied.error };

    const session = await ctx.db.get(args.sessionId);
    if (!session) return { error: "Session not found" as const };
    const foreign = await rejectForeignAssets(ctx, applied.deck, session.userId);
    if (foreign) return { error: foreign };

    await ctx.db.patch(existing._id, {
      title: applied.deck.title,
      content: JSON.stringify(applied.deck),
      lastEditedBy: "ai",
    });
    return {
      artifactId: existing._id,
      createdIds: applied.createdIds,
      revision: applied.deck.revision,
    };
  },
});

/**
 * The scholar's own direct-manipulation edits. Owner-only — mirrors
 * `scholarSetMapPins`: a teacher can READ a scholar's work but never edit it.
 * Same op language as the AI path, so there is exactly one way to mutate a deck.
 */
export const scholarApplySlideOps = authedMutation({
  args: {
    artifactId: v.id("artifacts"),
    ops: v.string(),
    baseRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new Error("Artifact not found");
    if (artifact.type !== "slides") throw new Error("Not a slides artifact");

    const session = await ctx.db.get(artifact.sessionId);
    if (!session) throw new Error("Session not found");
    // Owner-only: this is the kid's own work, and a teacher edit would be
    // indistinguishable from the kid's in the learning record.
    if (session.userId !== ctx.user._id) {
      throw new Error("Only the scholar who owns this deck can edit it");
    }

    const deck = parseDeck(artifact.content);
    if (!deck) throw new Error("Deck content is corrupt");

    if (args.baseRevision !== undefined && args.baseRevision !== deck.revision) {
      return { conflict: true as const, revision: deck.revision };
    }

    let ops: unknown;
    try {
      ops = JSON.parse(args.ops);
    } catch {
      throw new Error("ops must be valid JSON");
    }
    if (!Array.isArray(ops)) throw new Error("ops must be an array");

    const applied = applySlideOps(deck, ops as SlideOp[], makeDeckIdFactory(deck));
    if (!applied.ok) throw new Error(applied.error);

    const foreign = await rejectForeignAssets(ctx, applied.deck, ctx.user._id);
    if (foreign) throw new Error(foreign);

    await ctx.db.patch(artifact._id, {
      title: applied.deck.title,
      content: JSON.stringify(applied.deck),
      lastEditedBy: "scholar",
    });
    return {
      conflict: false as const,
      createdIds: applied.createdIds,
      revision: applied.deck.revision,
    };
  },
});

/** Read a deck for the model — the compact projection, not the raw JSON. */
export const aiReadDeck = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const artifact = rows.find((a) => a.type === "slides") ?? null;
    if (!artifact) return { error: "No deck exists for this session yet." as const };
    const deck = parseDeck(artifact.content);
    if (!deck) return { error: "Deck content is corrupt" as const };
    return {
      artifactId: artifact._id,
      revision: deck.revision,
      summary: summarizeDeckForModel(deck),
    };
  },
});

/**
 * Get-or-create the session's deck for the scholar who owns it. The AI can
 * create a deck via its own tool, but a kid who opens a slides deliverable with
 * no deck yet must land in an editor rather than an empty state — this is the
 * "capture path" the `slides` deliverable kind has been stubbed on.
 *
 * Owner-only, like every other scholar-side deck write.
 */
export const scholarEnsureSlidesDeck = authedMutation({
  args: { sessionId: v.id("sessions"), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    if (session.userId !== ctx.user._id) {
      throw new Error("Only the scholar who owns this session can start a deck");
    }
    const existing = await findSlidesArtifact(ctx, args.sessionId);
    if (existing) return { artifactId: existing._id, created: false as const };

    const deck = emptyDeck(args.title?.trim() || "Untitled slides", "sl1");
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId: args.sessionId,
      title: deck.title,
      content: JSON.stringify(deck),
      lastEditedBy: "scholar",
      type: "slides",
    });
    return { artifactId, created: true as const };
  },
});

/**
 * Record that this user uploaded media intended for a slide.
 *
 * The clients call this immediately after the upload POST. A storage id is not
 * authorization — `_storage` is one namespace shared with scanned health
 * documents — so a slide may only reference an image registered to the deck's
 * owner. Uploads for other features never appear here and therefore can never
 * be pulled onto a slide.
 */
export const registerSlideAsset = authedMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await registerSlideAssetForUser(ctx, args.storageId, ctx.user._id);
  },
});

async function registerSlideAssetForUser(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  uploaderId: Id<"users">,
  source: "upload" | "generated" | "webSearch" = "upload",
  provenance?: {
    searchQuery?: string;
    sourceUrl?: string;
  },
) {
  const existing = await ctx.db
    .query("slideAssets")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (existing) return { storageId };
  await ctx.db.insert("slideAssets", {
    storageId,
    uploaderId,
    source,
    searchQuery: provenance?.searchQuery,
    sourceUrl: provenance?.sourceUrl,
  });
  return { storageId };
}

/**
 * How many picture requests one scholar may make per hour, and the window.
 *
 * WHY THIS EXISTS: every generation spends real money, and the surface is a
 * button a child can press repeatedly. The `llmBudget` breaker is NOT a
 * backstop here — it is documented as inert unless `LLM_DAILY_BUDGET_USD` is
 * set, and production deliberately does not set it, so without this cap a
 * bored nine-year-old holding down "Make it" is unbounded spend.
 *
 * The number is deliberately generous: a scholar illustrating a deck might make
 * a dozen pictures in a sitting, and the cap exists to stop abuse, not to
 * ration ordinary work. Every accepted request counts once before the image
 * model runs, so repeated requests cannot become unbounded spend. Uploading
 * photos never eats into it.
 */
const MAX_GENERATED_IMAGES_PER_HOUR = 30;
const GENERATION_WINDOW_MS = 60 * 60 * 1000;

/**
 * WHY 60/HR: Brave charges $5 per 1,000 queries, so this bounds one scholar at
 * $0.30/hr while remaining generous rather than rationing ordinary slide work,
 * matching the philosophy of the 30/hr image-generation cap.
 */
const MAX_WEB_IMAGE_SEARCHES_PER_HOUR = 60;

/**
 * Atomically admits and reserves one picture request before either paid model
 * call. Convex retries this mutation on write conflict, so concurrent requests
 * cannot all observe the same remaining slot.
 *
 * WHO MAY GENERATE: the deck author (a scholar) and staff who run activities.
 * Despite the `scholar*` name a teacher legitimately reaches this through
 * "Rehearse manually", which drives the real scholar surface as themselves — a
 * scholar-only gate would break rehearsal. Everyone else (parents, operations staff)
 * has no authoring surface here, so they are refused rather than left holding a
 * spend button.
 */
export const claimSlideImageGenerationAttempt = internalMutation({
  args: { uploaderId: v.id("users"), since: v.number() },
  returns: v.object({
    claimed: v.boolean(),
    count: v.number(),
    allowed: v.boolean(),
    role: v.union(v.string(), v.null()),
    institutionId: v.union(v.id("institutions"), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.uploaderId);
    const allowed =
      user?.role === ROLES.SCHOLAR || isTeacherRole(user?.role ?? null);
    const institutionId = user?.role === ROLES.SCHOLAR
      ? user.institutionId ?? null
      : user && isTeacherRole(user.role)
      ? (await resolveActiveMembership(ctx, user))?.institutionId ?? null
      : null;
    const rows = await ctx.db
      .query("slideImageGenerationAttempts")
      .withIndex("by_uploader", (q) =>
        q.eq("uploaderId", args.uploaderId).gte("_creationTime", args.since)
      )
      .take(MAX_GENERATED_IMAGES_PER_HOUR);
    const count = rows.length;
    const claimed = allowed && count < MAX_GENERATED_IMAGES_PER_HOUR;
    if (claimed) {
      await ctx.db.insert("slideImageGenerationAttempts", {
        uploaderId: args.uploaderId,
      });
      const staleRows = await ctx.db
        .query("slideImageGenerationAttempts")
        .withIndex("by_uploader", (q) =>
          q.eq("uploaderId", args.uploaderId).lt("_creationTime", args.since)
        )
        .take(50);
      await Promise.all(staleRows.map((row) => ctx.db.delete(row._id)));
    }
    return {
      claimed,
      count,
      allowed,
      role: user?.role ?? null,
      institutionId,
    };
  },
});

/**
 * Atomically admits and reserves one web-image search before the paid Brave
 * call. The role gate and stale-row cleanup intentionally mirror generation.
 */
export const claimSlideImageSearchAttempt = internalMutation({
  args: { uploaderId: v.id("users"), since: v.number() },
  returns: v.object({
    claimed: v.boolean(),
    count: v.number(),
    allowed: v.boolean(),
    role: v.union(v.string(), v.null()),
    institutionId: v.union(v.id("institutions"), v.null()),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.uploaderId);
    const allowed =
      user?.role === ROLES.SCHOLAR || isTeacherRole(user?.role ?? null);
    const institutionId = user?.role === ROLES.SCHOLAR
      ? user.institutionId ?? null
      : user && isTeacherRole(user.role)
      ? (await resolveActiveMembership(ctx, user))?.institutionId ?? null
      : null;
    const rows = await ctx.db
      .query("slideImageSearchAttempts")
      .withIndex("by_uploader", (q) =>
        q.eq("uploaderId", args.uploaderId).gte("_creationTime", args.since)
      )
      .take(MAX_WEB_IMAGE_SEARCHES_PER_HOUR);
    const count = rows.length;
    const claimed = allowed && count < MAX_WEB_IMAGE_SEARCHES_PER_HOUR;
    if (claimed) {
      await ctx.db.insert("slideImageSearchAttempts", {
        uploaderId: args.uploaderId,
      });
      const staleRows = await ctx.db
        .query("slideImageSearchAttempts")
        .withIndex("by_uploader", (q) =>
          q.eq("uploaderId", args.uploaderId).lt("_creationTime", args.since)
        )
        .take(50);
      await Promise.all(staleRows.map((row) => ctx.db.delete(row._id)));
    }
    return {
      claimed,
      count,
      allowed,
      role: user?.role ?? null,
      institutionId,
    };
  },
});

export const registerGeneratedSlideAsset = internalMutation({
  args: {
    storageId: v.id("_storage"),
    uploaderId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await registerSlideAssetForUser(
      ctx,
      args.storageId,
      args.uploaderId,
      "generated",
    );
  },
});

export const registerWebSearchSlideAsset = internalMutation({
  args: {
    storageId: v.id("_storage"),
    uploaderId: v.id("users"),
    searchQuery: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await registerSlideAssetForUser(
      ctx,
      args.storageId,
      args.uploaderId,
      "webSearch",
      {
        searchQuery: args.searchQuery,
        sourceUrl: args.sourceUrl,
      },
    );
  },
});

/**
 * Bind the request to a slide deck the caller owns. The client supplies only an
 * artifact id; ownership and deck type are server-checked so a learner cannot
 * generate onto someone else's deck.
 */
export const slideImageGenerationContext = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    uploaderId: v.id("users"),
  },
  returns: v.union(v.null(), v.object({ sessionId: v.id("sessions") })),
  handler: async (
    ctx,
    args,
  ): Promise<{ sessionId: Id<"sessions"> } | null> => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.type !== "slides") return null;
    const session = await ctx.db.get(artifact.sessionId);
    if (!session || session.userId !== args.uploaderId) return null;
    return { sessionId: session._id };
  },
});

export const scholarGenerateSlideImage = authedAction({
  args: {
    // Optional for one native-release cycle: already-installed iPads from the
    // original image release call with { prompt } only. Refuse legibly instead
    // of exposing Convex argument-validation text until the fleet updates.
    artifactId: v.optional(v.id("artifacts")),
    prompt: v.string(),
  },
  returns: v.union(
    v.object({
      status: v.literal("generated"),
      storageId: v.id("_storage"),
      // Pixel size so the client can fit the element's frame to the real image
      // instead of the fixed preset box, which letterboxes a wide illustration.
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    }),
    v.object({
      status: v.literal("error"),
      error: v.string(),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        status: "generated";
        storageId: Id<"_storage">;
        width?: number;
        height?: number;
      }
    | { status: "error"; error: string }
  > => {
    const uploaderId = await getAuthUserId(ctx);
    if (!uploaderId) {
      return { status: "error", error: "Please sign in and try again." };
    }

    const prompt = args.prompt.trim();
    if (!prompt) {
      return {
        status: "error",
        error: "Tell me what picture you want to make.",
      };
    }
    if (prompt.length > 500) {
      return {
        status: "error",
        error: "Please use 500 characters or fewer.",
      };
    }
    if (!args.artifactId) {
      return {
        status: "error",
        error: "This version needs an update before it can make pictures.",
      };
    }
    if (!process.env.GEMINI_API_KEY) {
      return {
        status: "error",
        error: "Picture making is not available right now.",
      };
    }

    try {
      if ((await llmBudgetExceeded(ctx)) !== null) {
        return {
          status: "error",
          error: "Picture making is taking a break right now. Try again later.",
        };
      }

      const generationContext = await ctx.runQuery(
        internal.artifacts.slideImageGenerationContext,
        { artifactId: args.artifactId, uploaderId },
      );
      if (!generationContext) {
        return {
          status: "error",
          error: "That slide deck isn't available to make a picture.",
        };
      }

      // Refuse BEFORE spending anything. Counted per scholar, not globally, so
      // one child cannot exhaust the class's ability to make pictures.
      const allowance = await ctx.runMutation(
        internal.artifacts.claimSlideImageGenerationAttempt,
        { uploaderId, since: Date.now() - GENERATION_WINDOW_MS },
      );
      if (!allowance.allowed) {
        return {
          status: "error",
          error: "Making pictures isn't available for your account.",
        };
      }
      if (!allowance.claimed) {
        return {
          status: "error",
          error: "That's a lot of pictures! Try again in a little while.",
        };
      }

      // No authorship gate here — the Haiku "guardrail" that once classified
      // briefs at this point was removed 2026-08-25 after its complete
      // production record came back 13/13 false positives, zero true. Anti-
      // offloading judgment belongs to the tutor, which has the assignment
      // context this call site never did: see
      // review/image-offloading-tutor-judgment-plan.html.
      const image = await geminiGenerateImage([
        { text: buildFaithfulSlideImagePrompt(prompt) },
      ]);
      if (!image) {
        return {
          status: "error",
          error: "I couldn't make that picture. Try changing the description.",
        };
      }

      // Meter it. Fire-and-forget: a child's picture must never fail because
      // bookkeeping did. Attributed to the caller's role and institution, which
      // the allowance query above already resolved.
      void recordImageUsage(ctx, {
        source: "slide-illustration",
        model: image.model,
        role: allowance.role,
        institutionId: allowance.institutionId,
      });

      const storageId = await ctx.storage.store(
        toStorageBlob(image.bytes, image.mimeType),
      );
      await ctx.runMutation(internal.artifacts.registerGeneratedSlideAsset, {
        storageId,
        uploaderId,
      });
      const size = readImageSize(image.bytes);
      return {
        status: "generated",
        storageId,
        width: size?.width,
        height: size?.height,
      };
    } catch (error) {
      console.error("[slides] scholar image generation failed:", error);
      return {
        status: "error",
        error: "Something went wrong. Please try making the picture again.",
      };
    }
  },
});

/**
 * Every media asset in the resulting deck must be registered to `ownerId`.
 * Checking the validated deck covers whole-deck creates, addElement, and
 * addSlide restoration without duplicating the slide-operation grammar.
 */
async function rejectForeignAssets(
  ctx: MutationCtx,
  deck: Deck,
  ownerId: Id<"users">,
): Promise<string | null> {
  const assetIds = new Set<string>();
  for (const slide of deck.slides) {
    for (const element of Object.values(slide.elements)) {
      if (element.type === "image" || element.type === "video") {
        assetIds.add(element.assetId);
      }
    }
  }
  for (const assetId of assetIds) {
    const row = await ctx.db
      .query("slideAssets")
      .withIndex("by_storage", (q) => q.eq("storageId", assetId as Id<"_storage">))
      .first();
    if (!row || row.uploaderId !== ownerId) {
      return "That media isn't available to this deck.";
    }
  }
  return null;
}
