// Games — the server side of the sibling-to-manipulatives games platform.
//
// A scholar's pass through a kind="game" activity: start/resume, evidence
// ingest, completion. The game itself is CODE that ships in the native binary
// (native/src/games/<gameId>/); this file owns nothing about its rules and
// everything about its record.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO INVARIANTS THIS FILE HOLDS
//
// 1 · A GAME'S OUTCOME NEVER MINTS SR CREDIT (D-3). Games emit evidence; the
//     server draws conclusions. Nothing reachable from `requestCompletion`
//     writes a `practiceMastery` or `practiceAttempts` row — that leg is
//     ABSOLUTE and deliberately unimportable here, and
//     `convex/__tests__/games.test.ts` asserts the cardinality. Green fluency
//     is minted only by ordinary practice's later bare reps (green = decaying,
//     re-probed SR state), full stop. A game is deliberately adjacent to the
//     skills it touches (a practice beat is bound to skillKeys, and the
//     scheduler keeps serving fresh, cold, unassisted items on those same
//     skills), so the practice engine is already the transfer instrument. There
//     is no separate "transfer item" mechanism, and none is planned: building
//     one would duplicate the scheduler.
//
//     Game evidence DOES reach the learning record, but only through the
//     OBSERVER and only as PORTRAIT observations: `requestCompletion` schedules
//     `gameObserver.observeGameSession` AFTER the digest is stored, and that
//     async pass may write `masteryObservations` anchored on the game session
//     (nodeKey optional). The SYNCHRONOUS completion path below stays pure —
//     it writes zero `masteryObservations`/`analyses` directly.
//
// 2 · THE SERVER RE-DERIVES (lib/manipulative/practiceContract.ts, in its games
//     shape). Nothing the client computes about its own session is stored: the
//     digest is rebuilt here from the append-only `gameEvents` log. The game's
//     `outcomeKey` is recorded as a CLAIM, not a grade. `stateJson` is opaque —
//     never parsed, never digested, never sent anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import { v, type Infer } from "convex/values";

import {
  effectiveEvidencePlan,
  getGame,
  type EvidencePlan,
} from "../lib/games/catalog";
import {
  MAX_CONFIG_JSON_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENTS_PER_SESSION,
  MAX_FINAL_STATE_JSON_BYTES,
  byteLength,
  isHostEventKey,
  type GameActor,
  type GameEvent,
  type GameEventPayload,
  gameEventInputError,
} from "../lib/games/contract";
import { buildGameSessionDigest } from "../lib/games/digest";
import { renderDigestForModel } from "../lib/games/promptContext";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { maybeAwardUnitBadge } from "./lib/badgeAward";
import { authedMutation, authedQuery, teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { entryTargetsScholar } from "./assignments";

/**
 * Grace on the active-time clamp. Absorbs clock jitter and the round trip
 * without letting a client claim time it did not spend.
 */
const ACTIVE_MS_SLACK = 5_000;

/** Batch-shaped mirror of `GameEventInput`, for Convex arg validation. */
const actorValidator = v.union(
  v.literal("scholar"),
  v.literal("opponent"),
  v.literal("system"),
);
// The three literals above are restated for Convex's sake — it needs literal
// types, not a spread — so tie them back to the contract. Adding a `GameActor`
// without widening the validator (or vice versa) is a type error here rather
// than a row the server silently refuses at runtime.
type _ActorsMatchContract = [
  Exclude<GameActor, Infer<typeof actorValidator>> extends never ? true : never,
  Exclude<Infer<typeof actorValidator>, GameActor> extends never ? true : never,
];
const _actorsMatchContract: _ActorsMatchContract = [true, true];
void _actorsMatchContract;

const eventInputValidator = v.object({
  eventKey: v.string(),
  actor: v.optional(actorValidator),
  // The payload's ten closed shapes are validated by
  // `gameEventInputError` from the shared contract rather than restated
  // as a v.union here — one implementation, no drift between client and
  // server. Convex only needs to know it's an object.
  payload: v.any(),
});

async function requireOwnSession(
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"gameSessions">,
  userId: Id<"users">,
): Promise<Doc<"gameSessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Game session not found");
  if (String(session.scholarId) !== String(userId)) throw new Error("Forbidden");
  return session;
}

/**
 * Same assignment-scope check the web-activity path uses: the assignment must
 * exist, be live, include this scholar, and (unless self-paced) list this
 * activity as currently set.
 */
async function validateAssignmentScope(
  ctx: Pick<QueryCtx, "db">,
  assignmentId: Id<"assignments"> | undefined,
  scholarId: Id<"users">,
  activity: Doc<"activities">,
): Promise<Id<"assignments"> | undefined> {
  if (!assignmentId) return undefined;
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) throw new Error("Assignment not found");
  if (assignment.archivedAt) throw new Error("Assignment is archived");
  if (!assignment.scholarIds.some((id) => String(id) === String(scholarId))) {
    throw new Error("Assignment does not include scholar");
  }
  if (activity.lessonId) {
    const lesson = await ctx.db.get(activity.lessonId);
    if (lesson && String(lesson.unitId) !== String(assignment.unitId)) {
      throw new Error("Assignment does not match activity");
    }
  }
  if (assignment.selfPaced) return assignmentId;
  const now = Date.now();
  const entry = (assignment.activitySchedule ?? []).find(
    (e) => String(e.activityId) === String(activity._id),
  );
  if (!entry || !entryTargetsScholar(entry, scholarId)) {
    throw new Error("Assignment does not include activity");
  }
  if (entry.setAt == null || (entry.endsAt != null && entry.endsAt <= now)) {
    throw new Error("Assignment activity is not live");
  }
  return assignmentId;
}

/**
 * A session seed. Server-generated so a client can never pick its own
 * randomness, and stable for the session's life so the same round cannot be
 * re-rolled for a friendlier draw.
 */
function makeSeed(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requireGameActivity(activity: Doc<"activities">) {
  if (activity.kind !== "game") throw new Error("Not a game activity");
  const gameId = activity.game?.gameId;
  if (!gameId) throw new Error("Game activity has no game configured");
  const entry = getGame(gameId);
  if (!entry) throw new Error(`Unknown game "${gameId}"`);
  return { gameId, entry };
}

/**
 * Close an in-flight session and build its record. One code path for every way
 * a round can end other than completion: the scholar backed out, the renderer
 * crashed, or a new round superseded it. The evidence collected up to that
 * point is valid and is kept — losing it would punish the scholar for an
 * interruption. No `activityCompletions` row is written.
 */
async function closeSession(
  ctx: MutationCtx,
  session: Doc<"gameSessions">,
  status: "crashed" | "abandoned",
): Promise<Id<"gameSessionDigests"> | null> {
  const now = Date.now();
  await ctx.db.patch(session._id, { status, endedAt: now, lastActivityAt: now });
  return buildAndStoreDigest(ctx, session);
}

/**
 * Start a fresh round.
 *
 * A ROUND IS NEVER RESUMED — deliberately, and this is the load-bearing
 * simplification of the whole host. What has to survive an interruption is the
 * EVIDENCE, and that is already durable: it streams to `gameEvents` per move,
 * so whatever arrived before the lid closed is digested and readable.
 * The POSITION is not worth the same protection. Restoring it costs a scholar
 * seconds, but it costs every game author serializable + versioned +
 * rebuildable state (including derived presentation state), and it was the
 * single largest source of defects in the host's first pass. The sharper
 * hazard was never losing state — it was resuming INTO the state that crashed,
 * which on a kiosk iPad with no app switch is a trap with no exit.
 *
 * So: any session still open for this activity is closed, digested and left in
 * the record, and a new one begins.
 */
export const start = authedMutation({
  args: {
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity) throw new Error("Activity not found");
    const { gameId, entry } = requireGameActivity(activity);
    const assignmentId = await validateAssignmentScope(
      ctx,
      args.assignmentId,
      ctx.user._id,
      activity,
    );

    // Close every still-open round of this activity, across assignments — a
    // scholar cannot be playing two at once, and leaving one dangling would
    // strand its evidence undigested.
    const open = await ctx.db
      .query("gameSessions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", ctx.user._id).eq("activityId", args.activityId),
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
    for (const stale of open) {
      await closeSession(ctx, stale, "abandoned");
    }

    // The authored config is FROZEN onto the session. Read back when the digest
    // is built, so a mid-round teacher edit cannot reinterpret a finished round
    // under different rules.
    const configJson = activity.game?.configJson ?? JSON.stringify(entry.defaultConfig);
    if (byteLength(configJson) > MAX_CONFIG_JSON_BYTES) {
      throw new Error(`Game config exceeds ${MAX_CONFIG_JSON_BYTES} bytes`);
    }

    const now = Date.now();
    const sessionId = await ctx.db.insert("gameSessions", {
      scholarId: ctx.user._id,
      activityId: args.activityId,
      assignmentId,
      gameId,
      // The catalog is the server's view of the shipped module; the module's own
      // manifest.version is asserted to match it by the CI conformance test.
      gameVersion: entry.version,
      configJson,
      seed: makeSeed(),
      lastSeq: 0,
      activeMs: 0,
      startedAt: now,
      lastActivityAt: now,
      status: "active",
    });
    const session = (await ctx.db.get(sessionId))!;
    return {
      sessionId,
      gameId,
      seed: session.seed,
      configJson,
      lastSeq: 0,
      activeMs: 0,
    };
  },
});

/**
 * The scholar backed out of a round. Closes and digests it exactly as a crash
 * does; the next launch starts fresh. On a kiosk iPad in ASAM there is no app
 * switch and no home button, so an explicit way out of a round the scholar
 * cannot finish is not a nicety — it is the only exit that exists.
 */
export const abandon = authedMutation({
  args: { sessionId: v.id("gameSessions") },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    if (session.status !== "active") return { digestId: null };
    const digestId = await closeSession(ctx, session, "abandoned");
    return { digestId };
  },
});

type IngestInput = {
  events: readonly {
    eventKey: string;
    payload: unknown;
    actor?: GameActor;
    /** Set by the host channel only. Gates the reserved `host.` prefix. */
    fromHost?: boolean;
  }[];
  atActiveMs: number;
  expectedLastSeq: number;
};

/**
 * The one write path for evidence. A batch lands in a single Convex
 * transaction, so a checkpoint is never half-applied.
 *
 * `expectedLastSeq` is optimistic concurrency, not politeness — a duplicate
 * in-flight batch (a retried request after a flaky network) is REJECTED rather
 * than appended twice.
 *
 * Host lifecycle keys are refused here. `plan` deliberately contains them (the
 * digest must be able to interpret them), so without this check a game could
 * forge `host.help` through `checkpoint.transact` and fake its own help
 * request. The host's own writes go through `hostIngest`.
 */
async function ingest(
  ctx: MutationCtx,
  session: Doc<"gameSessions">,
  plan: EvidencePlan,
  input: IngestInput,
) {
  if (session.status !== "active") throw new Error("Game session is not active");
  if (input.events.length > MAX_EVENTS_PER_BATCH) {
    throw new Error(`Batch exceeds ${MAX_EVENTS_PER_BATCH} events`);
  }
  if (session.lastSeq + input.events.length > MAX_EVENTS_PER_SESSION) {
    throw new Error(`Session exceeds ${MAX_EVENTS_PER_SESSION} events`);
  }
  if (input.expectedLastSeq !== session.lastSeq) {
    throw new Error(
      `Stale checkpoint: expected seq ${session.lastSeq}, got ${input.expectedLastSeq}`,
    );
  }
  // Active time is client-reported and monotonic by contract, so clamp it: it
  // may not run backwards, and it may not outpace wall-clock time since the
  // session started. Telemetry, not a grade — but a teacher reads it as fact.
  const receivedAt = Date.now();
  const atActiveMs = Math.min(
    Math.max(session.activeMs, Math.max(0, Math.round(input.atActiveMs))),
    session.activeMs + Math.max(0, receivedAt - session.lastActivityAt) + ACTIVE_MS_SLACK,
  );

  // Validate the WHOLE batch before writing any of it — a partially-ingested
  // batch would leave the client's seq and the server's out of step.
  for (const event of input.events) {
    const shapeError = gameEventInputError(event);
    if (shapeError) throw new Error(`Invalid game event: ${shapeError}`);
    if (!event.fromHost && isHostEventKey(event.eventKey)) {
      throw new Error(`Reserved eventKey "${event.eventKey}" — the host owns host.* events`);
    }
    // The evidence plan is server-owned: a game emits keys, this decides what
    // they mean. An undeclared key is rejected rather than stored unlabelled —
    // that is the boundary that stops a game labelling its own evidence.
    if (!plan[event.eventKey]) {
      throw new Error(`Undeclared eventKey "${event.eventKey}" for game ${session.gameId}`);
    }
  }

  let seq = session.lastSeq;
  for (const event of input.events) {
    seq += 1;
    await ctx.db.insert("gameEvents", {
      sessionId: session._id,
      scholarId: session.scholarId,
      seq,
      eventKey: event.eventKey,
      payloadJson: JSON.stringify(event.payload),
      // Defaulted here rather than trusted from the client's omission, so a
      // stored row always answers "who did this" explicitly.
      actor: event.actor ?? "scholar",
      atActiveMs,
      receivedAt,
    });
  }
  await ctx.db.patch(session._id, {
    lastSeq: seq,
    activeMs: atActiveMs,
    lastActivityAt: receivedAt,
  });
  return { lastSeq: seq };
}

/**
 * Checkpoint: queued evidence, atomically. Called by the native host's
 * `checkpoint.transact`, never by a game directly — a game has no network
 * access at all.
 */
export const checkpoint = authedMutation({
  args: {
    sessionId: v.id("gameSessions"),
    events: v.optional(v.array(eventInputValidator)),
    atActiveMs: v.number(),
    expectedLastSeq: v.number(),
    /**
     * The host's OWN lifecycle events. A separate argument, not a flag on the
     * batch, because that is what makes the reserved `host.` prefix a real
     * boundary: a game hands its events to the host, and only the host can put
     * anything on this channel. Without the split a game forges `host.help`
     * and manufactures help requests the scholar never made.
     */
    hostEvents: v.optional(v.array(eventInputValidator)),
  },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    const plan = effectiveEvidencePlan(session.gameId);
    if (!plan) throw new Error(`Unknown game "${session.gameId}"`);
    for (const event of args.hostEvents ?? []) {
      if (!isHostEventKey(event.eventKey)) {
        throw new Error(`"${event.eventKey}" is not a host event`);
      }
    }
    // ONE ingest, so `expectedLastSeq` still guards the whole write. Splitting
    // it into two calls silently defeated the staleness check: the second read
    // the freshly-patched seq and could never be stale.
    return ingest(ctx, session, plan, {
      events: [
        ...(args.hostEvents ?? []).map((e) => ({ ...e, fromHost: true as const })),
        ...(args.events ?? []),
      ],
      atActiveMs: args.atActiveMs,
      expectedLastSeq: args.expectedLastSeq,
    });
  },
});

/**
 * End the session and build the record.
 *
 * The digest is RE-DERIVED here from `gameEvents` — the client never supplies a
 * summary, so there is nothing to trust. The `outcomeKey` is written as a claim.
 * Completion inserts exactly one `activityCompletions` row (idempotent) and
 * mints the unit badge, the same as every other activity kind. The synchronous
 * path writes NO SR row (`practiceMastery`/`practiceAttempts`) and no mastery/
 * analysis row directly; it then SCHEDULES the game observer, which may record
 * portrait `masteryObservations` asynchronously — see invariant 1 at the top.
 */
export const requestCompletion = authedMutation({
  args: {
    sessionId: v.id("gameSessions"),
    outcomeKey: v.string(),
    events: v.optional(v.array(eventInputValidator)),
    atActiveMs: v.number(),
    expectedLastSeq: v.number(),
    /** Forensic record only. Never read back into a running game. */
    finalStateJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    const plan = effectiveEvidencePlan(session.gameId);
    if (!plan) throw new Error(`Unknown game "${session.gameId}"`);
    if (
      args.finalStateJson !== undefined &&
      byteLength(args.finalStateJson) > MAX_FINAL_STATE_JSON_BYTES
    ) {
      throw new Error(`Final state exceeds ${MAX_FINAL_STATE_JSON_BYTES} bytes`);
    }

    await ingest(ctx, session, plan, {
      events: args.events ?? [],
      atActiveMs: args.atActiveMs,
      expectedLastSeq: args.expectedLastSeq,
    });

    const fresh = (await ctx.db.get(args.sessionId))!;
    const now = Date.now();
    await ctx.db.patch(args.sessionId, {
      status: "completed",
      endedAt: now,
      outcomeKey: args.outcomeKey.slice(0, 120),
      lastActivityAt: now,
      ...(args.finalStateJson !== undefined
        ? { finalStateJson: args.finalStateJson }
        : {}),
    });

    const digestId = await buildAndStoreDigest(ctx, {
      ...fresh,
      activeMs: Math.max(fresh.activeMs, Math.max(0, Math.round(args.atActiveMs))),
    });
    const completed = await recordActivityCompletion(ctx, fresh);

    // Game evidence enters the learning record through the OBSERVER, not
    // through SR. Now that the digest is stored, schedule a post-hoc pass that
    // may record `masteryObservations` anchored on this game session (the
    // portrait layer — nodeKey optional). It runs async and gates itself
    // (dedupe, min length, per-scholar daily cap); its failure never affects
    // this round's outcome. It writes NO practiceAttempts/practiceMastery —
    // green fluency stays the practice engine's monopoly (invariant 1).
    //
    // The enqueue itself is wrapped: a scheduler failure here would otherwise
    // roll back this whole (already-successful) completion. The round outcome
    // must never depend on observer scheduling, so a failed enqueue logs and is
    // swallowed — the digest + completion are already durable above.
    try {
      await ctx.scheduler.runAfter(0, internal.gameObserver.observeGameSession, {
        gameSessionId: args.sessionId,
      });
    } catch (err) {
      console.error(
        `[games] failed to schedule game observer for ${args.sessionId}:`,
        err,
      );
    }

    return { digestId, completed };
  },
});

/**
 * The host's error boundary caught a crash in the game's renderer. Close the
 * session honestly and still build the digest: the evidence collected before
 * the crash is valid, and losing it would punish the scholar for our bug.
 * Explicitly does NOT record an activity completion.
 */
export const reportCrash = authedMutation({
  args: { sessionId: v.id("gameSessions") },
  handler: async (ctx, args) => {
    const session = await requireOwnSession(ctx, args.sessionId, ctx.user._id);
    if (session.status !== "active") return { digestId: null };
    const digestId = await closeSession(ctx, session, "crashed");
    return { digestId };
  },
});

async function readEvents(
  ctx: Pick<QueryCtx, "db">,
  sessionId: Id<"gameSessions">,
): Promise<GameEvent[]> {
  const rows = await ctx.db
    .query("gameEvents")
    .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
    .collect();
  return rows
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({
      eventKey: row.eventKey,
      payload: JSON.parse(row.payloadJson) as GameEventPayload,
      actor: row.actor,
      atActiveMs: row.atActiveMs,
      seq: row.seq,
      receivedAt: row.receivedAt,
    }));
}

async function buildAndStoreDigest(
  ctx: MutationCtx,
  session: Doc<"gameSessions">,
): Promise<Id<"gameSessionDigests"> | null> {
  const plan = effectiveEvidencePlan(session.gameId);
  if (!plan) return null;
  const events = await readEvents(ctx, session._id);
  const digest = buildGameSessionDigest({
    gameId: session.gameId,
    gameVersion: session.gameVersion,
    totalActiveMs: session.activeMs,
    events,
    plan,
  });
  const existing = await ctx.db
    .query("gameSessionDigests")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .first();
  const digestJson = JSON.stringify(digest);
  if (existing) {
    await ctx.db.patch(existing._id, { digestJson, builtAt: Date.now() });
    return existing._id;
  }
  return ctx.db.insert("gameSessionDigests", {
    sessionId: session._id,
    scholarId: session.scholarId,
    activityId: session.activityId,
    assignmentId: session.assignmentId,
    gameId: session.gameId,
    builtAt: Date.now(),
    digestJson,
  });
}

/** One idempotent `activityCompletions` row, mirroring the web-activity path. */
async function recordActivityCompletion(
  ctx: MutationCtx,
  session: Doc<"gameSessions">,
): Promise<boolean> {
  const activity = await ctx.db.get(session.activityId);
  if (!activity?.lessonId) return false;
  const lesson = await ctx.db.get(activity.lessonId);
  if (!lesson) return false;

  const existing = session.assignmentId
    ? await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_assignment", (q) =>
          q.eq("scholarId", session.scholarId).eq("assignmentId", session.assignmentId!),
        )
        .filter((q) => q.eq(q.field("activityId"), session.activityId))
        .first()
    : (
        await ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", session.scholarId).eq("activityId", session.activityId),
          )
          .collect()
      ).find((row: Doc<"activityCompletions">) => row.assignmentId === undefined);

  if (existing) {
    await ctx.db.patch(existing._id, { completedAt: Date.now() });
  } else {
    await ctx.db.insert("activityCompletions", {
      scholarId: session.scholarId,
      activityId: session.activityId,
      lessonId: activity.lessonId,
      unitId: lesson.unitId,
      completedAt: Date.now(),
      assignmentId: session.assignmentId,
    });
  }
  await maybeAwardUnitBadge(ctx, session.scholarId, session.activityId);
  return true;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The coach's grounding: same-round evidence for responsive help. The
 * cross-round archive (`gameSessionDigests`) stays teacher-only. Mirrors Ruling
 * 1 of the coaching proposal: same-problem help may see this problem's work.
 */
export const handoffContext = internalQuery({
  args: {
    sessionId: v.id("gameSessions"),
    callerUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.scholarId !== args.callerUserId) return null;

    const plan = effectiveEvidencePlan(session.gameId);
    const catalogEntry = getGame(session.gameId);
    if (!plan || !catalogEntry) return null;

    const events = await readEvents(ctx, session._id);
    const digest = buildGameSessionDigest({
      gameId: session.gameId,
      gameVersion: session.gameVersion,
      totalActiveMs: session.activeMs,
      events,
      plan,
    });
    const currentPhase = digest.phases[digest.phases.length - 1]?.phase;

    return {
      // gameId rides along for the transcript record: handoffTranscripts is
      // anonymous by design (no scholarId), so the stored itemId must be the
      // CONTENT-class identifier `game#<gameId>` — never the gameSessions row
      // id, which would be a stored join path back to the scholar.
      gameId: session.gameId,
      gameTitle: catalogEntry.title,
      blurb: catalogEntry.blurb,
      ...(currentPhase ? { currentPhase } : {}),
      roundSoFar: renderDigestForModel(digest),
    };
  },
});

/** The scholar's own in-flight session for an activity (resume chip). */
export const myLatestForActivity = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("gameSessions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", ctx.user._id).eq("activityId", args.activityId),
      )
      .order("desc")
      .first();
    if (!latest) return null;
    return {
      _id: latest._id,
      gameId: latest.gameId,
      status: latest.status,
      startedAt: latest.startedAt,
      endedAt: latest.endedAt ?? null,
      activeMs: latest.activeMs,
      outcomeKey: latest.outcomeKey ?? null,
    };
  },
});

/**
 * Teacher view: a scholar's recent game sessions with their digests.
 * REVIEWING IS NOT PLAYING — gameplay is iPad-only (D-5) but the evidence is
 * plain data, so a teacher on a laptop keeps their review workflow.
 */
export const listRecentForScholar = teacherQuery({
  args: { scholarId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const sessions = await ctx.db
      .query("gameSessions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .take(limit);
    return Promise.all(
      sessions.map(async (s) => {
        const activity = await ctx.db.get(s.activityId);
        const digestRow = await ctx.db
          .query("gameSessionDigests")
          .withIndex("by_session", (q) => q.eq("sessionId", s._id))
          .first();
        const catalogEntry = getGame(s.gameId);
        const effectiveEnd = s.endedAt ?? s.lastActivityAt;
        return {
          _id: s._id,
          activityId: s.activityId,
          activityTitle: activity?.title ?? "(deleted activity)",
          gameId: s.gameId,
          gameTitle: catalogEntry?.title ?? s.gameId,
          status: s.status,
          startedAt: s.startedAt,
          endedAt: s.endedAt ?? null,
          durationMs: Math.max(0, effectiveEnd - s.startedAt),
          activeMs: s.activeMs,
          outcomeKey: s.outcomeKey ?? null,
          eventCount: s.lastSeq,
          digest: digestRow
            ? (JSON.parse(digestRow.digestJson) as ReturnType<typeof buildGameSessionDigest>)
            : null,
        };
      }),
    );
  },
});
