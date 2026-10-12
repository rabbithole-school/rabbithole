/**
 * The `appAiTurns` record behind server-backed AI in sandboxed apps
 * (shared/appAiPolicy.ts): the transactional half of `appAiActions.say` /
 * `appAiActions.judge` (authorize, refuse, open a pending row, close it) and
 * the read the session owner and staff use. Directions and asides are written
 * by the tutor's tools elsewhere; this file only reads them.
 */
import { v, type Infer } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { requireActiveSessionOwnerInstitution } from "./lib/scholarEnrollment";
import { isTeacherRole } from "./lib/roles";
import {
  MAX_CHARACTER_LINE_CHARS,
  MAX_JUDGE_ANSWER_CHARS,
} from "../shared/appAiPolicy";

/**
 * A pending exchange (or judgment) younger than this blocks a new one of the
 * same kind: one line, and one ruling, at a time.
 */
export const APP_AI_PENDING_BUSY_MS = 30_000;
/** Prior exchange + aside rows the actor sees. */
export const APP_AI_PRIOR_TURNS = 30;
// Finished rows read per kind to find those prior turns. Reads go through
// by_session_kind_status, so failed rows never take a slot; the slack covers
// a session holding several apps, whose rows interleave.
const PRIOR_TURN_SCAN = 200;
// Direction rows read to find this artifact's latest one (other apps in the
// same session interleave).
const DIRECTION_SCAN = 50;
/** Newest rows returned by `listForSession`. */
export const APP_AI_LIST_CAP = 500;

const refusalValidator = v.object({
  ok: v.literal(false),
  code: v.union(
    v.literal("unavailable"),
    v.literal("busy"),
    v.literal("invalid"),
  ),
  retryAfterSec: v.optional(v.number()),
});

type Refusal = {
  ok: false;
  code: "unavailable" | "busy" | "invalid";
  retryAfterSec?: number;
};

type OwnedApp = {
  user: Doc<"users">;
  artifact: Doc<"artifacts">;
  session: Doc<"sessions">;
};

/**
 * Owner-only, like `appStates.updateSessionState`: the scholar playing the app
 * (or a teacher rehearsing in their own test-drive session). The tenant comes
 * from the session itself. Returns a refusal for a session that can no longer
 * take turns; throws for anything that is an authorization failure.
 */
async function loadOwnedApp(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  artifactId: Id<"artifacts">,
): Promise<OwnedApp | Refusal> {
  const user = await ctx.db.get(callerUserId);
  if (!user) throw new Error("User not found");
  const artifact = await ctx.db.get(artifactId);
  if (!artifact) throw new Error("Artifact not found");
  const session = await ctx.db.get(artifact.sessionId);
  if (!session) throw new Error("Session not found");
  if (session.userId !== user._id) throw new Error("Forbidden");
  await requireActiveSessionOwnerInstitution(ctx, user, session);

  if (artifact.type !== "code") return { ok: false, code: "unavailable" };
  if (session.isArchived) return { ok: false, code: "unavailable" };
  // Same rule as sessions.sendMessage: the timer binds scholars, not staff.
  if (
    !isTeacherRole(user.role) &&
    session.sessionTimeLimit &&
    session.sessionStartTime &&
    Date.now() - session.sessionStartTime >= session.sessionTimeLimit * 60_000
  ) {
    return { ok: false, code: "unavailable" };
  }
  return { user, artifact, session };
}

function effectiveVerdict(row: Doc<"appAiTurns">): string | undefined {
  return row.verdictOverride?.verdict ?? row.verdict;
}

/** Seconds until a pending row of this kind stops blocking, or null. */
async function pendingRetryAfterSec(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  kind: "exchange" | "judgment",
  now: number,
): Promise<number | null> {
  const pending = await ctx.db
    .query("appAiTurns")
    .withIndex("by_session_kind_status", (q) =>
      q
        .eq("sessionId", sessionId)
        .eq("kind", kind)
        .eq("status", "pending")
        .gt("createdAt", now - APP_AI_PENDING_BUSY_MS),
    )
    .first();
  if (!pending) return null;
  return Math.max(
    1,
    Math.ceil((pending.createdAt + APP_AI_PENDING_BUSY_MS - now) / 1000),
  );
}

/** The newest finished rows of one kind, newest first, at most `limit`. */
function newestDone(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  kind: Doc<"appAiTurns">["kind"],
  limit: number,
) {
  return ctx.db
    .query("appAiTurns")
    .withIndex("by_session_kind_status", (q) =>
      q.eq("sessionId", sessionId).eq("kind", kind).eq("status", "done"),
    )
    .order("desc")
    .take(limit);
}

export const beginTurn = internalMutation({
  args: {
    callerUserId: v.id("users"),
    artifactId: v.id("artifacts"),
    text: v.string(),
    // Already normalized by the action; stored for the teacher-readable record.
    appContext: v.optional(v.string()),
  },
  returns: v.union(
    refusalValidator,
    v.object({
      ok: v.literal(true),
      turnId: v.id("appAiTurns"),
      sessionId: v.id("sessions"),
      institutionId: v.optional(v.id("institutions")),
      role: v.optional(v.string()),
      scholarLine: v.string(),
      character: v.object({
        name: v.string(),
        persona: v.string(),
        moods: v.array(v.string()),
        verdicts: v.optional(v.array(v.string())),
      }),
      direction: v.string(),
      priorTurns: v.array(
        v.union(
          v.object({
            kind: v.literal("exchange"),
            scholarLine: v.string(),
            line: v.string(),
            mood: v.optional(v.string()),
            verdict: v.optional(v.string()),
          }),
          v.object({
            kind: v.literal("aside"),
            line: v.string(),
            mood: v.optional(v.string()),
            verdict: v.optional(v.string()),
          }),
        ),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const owned = await loadOwnedApp(ctx, args.callerUserId, args.artifactId);
    if ("ok" in owned) return owned;
    const { user, artifact, session } = owned;
    const character = artifact.appAi?.character;
    if (!character) return { ok: false as const, code: "unavailable" as const };

    const scholarLine = args.text.trim().slice(0, MAX_CHARACTER_LINE_CHARS);
    if (!scholarLine) return { ok: false as const, code: "invalid" as const };

    const now = Date.now();
    const retryAfterSec = await pendingRetryAfterSec(
      ctx,
      session._id,
      "exchange",
      now,
    );
    if (retryAfterSec !== null) {
      return { ok: false as const, code: "busy" as const, retryAfterSec };
    }

    // One session can hold several apps; each character keeps its own scene.
    const directionRow = (
      await newestDone(ctx, session._id, "direction", DIRECTION_SCAN)
    ).find((row) => row.artifactId === artifact._id);

    const recent = [
      ...(await newestDone(ctx, session._id, "exchange", PRIOR_TURN_SCAN)),
      ...(await newestDone(ctx, session._id, "aside", PRIOR_TURN_SCAN)),
    ].sort((a, b) => b.createdAt - a.createdAt);
    const priorTurns = recent
      .filter((row) => row.artifactId === artifact._id && row.line !== undefined)
      .slice(0, APP_AI_PRIOR_TURNS)
      .reverse()
      .map((row) => {
        const reply = {
          line: row.line ?? "",
          ...(row.mood !== undefined ? { mood: row.mood } : {}),
          ...(effectiveVerdict(row) !== undefined
            ? { verdict: effectiveVerdict(row) }
            : {}),
        };
        return row.kind === "exchange"
          ? {
              kind: "exchange" as const,
              scholarLine: row.scholarLine ?? "",
              ...reply,
            }
          : { kind: "aside" as const, ...reply };
      });

    const turnId = await ctx.db.insert("appAiTurns", {
      sessionId: session._id,
      artifactId: artifact._id,
      kind: "exchange",
      status: "pending",
      scholarLine,
      ...(args.appContext !== undefined ? { appContext: args.appContext } : {}),
      createdAt: now,
    });

    return {
      ok: true as const,
      turnId,
      sessionId: session._id,
      ...(session.institutionId !== undefined
        ? { institutionId: session.institutionId }
        : {}),
      ...(user.role !== undefined ? { role: user.role } : {}),
      scholarLine,
      character: {
        name: character.name,
        persona: character.persona,
        moods: character.moods,
        ...(character.verdicts !== undefined
          ? { verdicts: character.verdicts }
          : {}),
      },
      direction: directionRow?.direction ?? "",
      priorTurns,
    };
  },
});

export const beginJudgment = internalMutation({
  args: {
    callerUserId: v.id("users"),
    artifactId: v.id("artifacts"),
    judgeId: v.string(),
    answer: v.string(),
    appContext: v.optional(v.string()),
  },
  returns: v.union(
    refusalValidator,
    v.object({
      ok: v.literal(true),
      turnId: v.id("appAiTurns"),
      sessionId: v.id("sessions"),
      institutionId: v.optional(v.id("institutions")),
      role: v.optional(v.string()),
      answer: v.string(),
      judge: v.object({
        id: v.string(),
        rubric: v.string(),
        verdicts: v.array(v.string()),
      }),
    }),
  ),
  handler: async (ctx, args) => {
    const owned = await loadOwnedApp(ctx, args.callerUserId, args.artifactId);
    if ("ok" in owned) return owned;
    const { user, artifact, session } = owned;
    const judge = artifact.appAi?.judges?.find((j) => j.id === args.judgeId);
    if (!judge || judge.verdicts.length === 0) {
      return { ok: false as const, code: "unavailable" as const };
    }
    const answer = args.answer.trim().slice(0, MAX_JUDGE_ANSWER_CHARS);
    if (!answer) return { ok: false as const, code: "invalid" as const };

    const now = Date.now();
    const retryAfterSec = await pendingRetryAfterSec(
      ctx,
      session._id,
      "judgment",
      now,
    );
    if (retryAfterSec !== null) {
      return { ok: false as const, code: "busy" as const, retryAfterSec };
    }

    const turnId = await ctx.db.insert("appAiTurns", {
      sessionId: session._id,
      artifactId: artifact._id,
      kind: "judgment",
      status: "pending",
      scholarLine: answer,
      judgeId: judge.id,
      ...(args.appContext !== undefined ? { appContext: args.appContext } : {}),
      createdAt: now,
    });
    return {
      ok: true as const,
      turnId,
      sessionId: session._id,
      ...(session.institutionId !== undefined
        ? { institutionId: session.institutionId }
        : {}),
      ...(user.role !== undefined ? { role: user.role } : {}),
      answer,
      judge: { id: judge.id, rubric: judge.rubric, verdicts: judge.verdicts },
    };
  },
});

export const completeTurn = internalMutation({
  args: {
    turnId: v.id("appAiTurns"),
    model: v.string(),
    line: v.optional(v.string()),
    mood: v.optional(v.string()),
    verdict: v.optional(v.string()),
    feedback: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { turnId, ...fields }) => {
    await ctx.db.patch(turnId, { ...fields, status: "done" });
    return null;
  },
});

export const failTurn = internalMutation({
  args: { turnId: v.id("appAiTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.turnId, { status: "failed" });
    return null;
  },
});

const turnViewValidator = v.object({
  _id: v.id("appAiTurns"),
  artifactId: v.id("artifacts"),
  kind: v.union(
    v.literal("exchange"),
    v.literal("direction"),
    v.literal("aside"),
    v.literal("judgment"),
  ),
  status: v.union(
    v.literal("pending"),
    v.literal("done"),
    v.literal("failed"),
  ),
  scholarLine: v.optional(v.string()),
  line: v.optional(v.string()),
  mood: v.optional(v.string()),
  verdict: v.optional(v.string()),
  verdictOverride: v.optional(v.object({ verdict: v.string(), at: v.number() })),
  direction: v.optional(v.string()),
  judgeId: v.optional(v.string()),
  feedback: v.optional(v.string()),
  appContext: v.optional(v.string()),
  model: v.optional(v.string()),
  createdAt: v.number(),
});

export type AppAiTurnView = Infer<typeof turnViewValidator>;

/**
 * A session's app-AI record, oldest first (the newest `APP_AI_LIST_CAP` rows).
 * Staff with access to the session's scholar see everything; the owning
 * scholar sees the scene without the tutor's directions, verdict overrides, or
 * the app context the model was given — directions are never shown to scholars.
 */
export const listForSession = authedQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.array(turnViewValidator),
  handler: async (ctx, args): Promise<AppAiTurnView[]> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");
    const isStaffView = isTeacherRole(ctx.user.role);
    if (isStaffView) {
      // A role check alone would read across institutions.
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    } else if (session.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }

    const rows = (
      await ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(APP_AI_LIST_CAP)
    ).reverse();

    return rows.flatMap((row): AppAiTurnView[] => {
      const { _creationTime, sessionId, ...view } = row;
      void _creationTime;
      void sessionId;
      if (isStaffView) return [view];
      if (row.kind === "direction") return [];
      // The scholar sees the verdict that stands, not how it was reached.
      const { verdictOverride, appContext, verdict, ...scholarView } = view;
      void verdictOverride;
      void appContext;
      void verdict;
      const effective = effectiveVerdict(row);
      return [
        effective !== undefined
          ? { ...scholarView, verdict: effective }
          : scholarView,
      ];
    });
  },
});
