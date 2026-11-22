import { ConvexError, v, type Infer } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authedMutation,
  authedQuery,
  staffQuery,
  teacherQuery,
} from "./lib/customFunctions";
import {
  accessibleScholarIds,
  requireActiveScholarAccess,
  resolveActiveMembership,
} from "./lib/access";
import { assertCanWrite, getCurrentUser } from "./lib/auth";
import { isPlatformAdminRole, isTeacherRole } from "./lib/roles";
import {
  assertNotTeacherArchived,
  mayReadTeacherArchived,
} from "./lib/teacherArchive";
import {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  MAX_CUSTOM_APP_STATE_KEY_CHARS,
  MAX_CUSTOM_APP_STATE_ROWS,
  MAX_CUSTOM_APP_STATE_USER_ID_CHARS,
  type CustomAppStateRateLimitErrorData,
} from "../shared/appStatePolicy";
import {
  APP_ACTION_TIMEOUT_MS,
  MAX_APP_ACTION_ARGS_BYTES,
  MAX_APP_ACTION_ERROR_CHARS,
  MAX_APP_ACTION_RESULT_BYTES,
  type AppActionRegistration,
  type AppActionRequest,
  type AppActionResult,
  jsonByteLength,
  normalizeAppActionRegistry,
} from "../shared/appActionPolicy";
import { characterLineValidator } from "./lib/appAiValidators";
import {
  readLatestAppPlayForArtifact,
  readLatestAppPlayForSession,
  type LatestAppPlay,
} from "./appPlaySessions";

export const MAX_APP_STATE_DOC_BYTES = 8 * 1024;
export const MAX_APP_STATE_LOG_ENTRIES = 30;
export const MAX_APP_STATE_LOG_CHARS = 300;
export {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  MAX_CUSTOM_APP_STATE_KEY_CHARS,
  MAX_CUSTOM_APP_STATE_ROWS,
  MAX_CUSTOM_APP_STATE_USER_ID_CHARS,
  MAX_APP_ACTION_ARGS_BYTES,
  MAX_APP_ACTION_RESULT_BYTES,
};

const appStateLogLevel = v.union(
  v.literal("log"),
  v.literal("warn"),
  v.literal("error"),
);
const appStateLogInput = v.object({
  level: appStateLogLevel,
  message: v.string(),
});
const appActionRegistrationInput = v.object({
  name: v.string(),
  description: v.string(),
});
const appActionResultInput = v.object({
  requestId: v.string(),
  ok: v.boolean(),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
});

export type AppStateLogEntry = {
  level: "log" | "warn" | "error";
  message: string;
  at: number;
};

export type AppStateSnapshot = {
  doc: unknown;
  actions: AppActionRegistration[];
  actionRequest?: AppActionRequest;
  characterLine?: Infer<typeof characterLineValidator>;
  log: AppStateLogEntry[];
  version: number;
  updatedAt: number;
};

type StateKey = {
  scope: "session" | "customApp";
  scopeId: string;
  userId: string;
  key: string;
};

type DbReader = Pick<QueryCtx, "db">;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializedBytes(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("App state must be JSON-serializable");
  }
  if (json === undefined) {
    throw new Error("App state must be JSON-serializable");
  }
  return new TextEncoder().encode(json).byteLength;
}

function validatePatch(patch: unknown): asserts patch is Record<string, unknown> {
  if (!isObject(patch)) {
    throw new Error("App state patch must be a JSON object");
  }
}

function validateDocSize(doc: unknown): void {
  const bytes = serializedBytes(doc);
  if (bytes > MAX_APP_STATE_DOC_BYTES) {
    throw new Error(
      `App state exceeds the ${MAX_APP_STATE_DOC_BYTES}-byte limit (${bytes} bytes)`,
    );
  }
}

function validateActionRegistry(value: unknown): AppActionRegistration[] {
  if (!Array.isArray(value)) {
    throw new Error("App action registry must be an array");
  }
  const actions = normalizeAppActionRegistry(value);
  if (actions.length !== value.length) {
    throw new Error("App action registry contains an invalid or duplicate entry");
  }
  return actions;
}

function validateActionArgs(
  value: unknown,
): asserts value is Record<string, unknown> {
  validatePatch(value);
  const bytes = jsonByteLength(value);
  if (bytes > MAX_APP_ACTION_ARGS_BYTES) {
    throw new Error(
      `App action args exceed the ${MAX_APP_ACTION_ARGS_BYTES}-byte limit`,
    );
  }
}

function isExpiredActionRequest(request: AppActionRequest, now: number): boolean {
  return now - request.requestedAt >= APP_ACTION_TIMEOUT_MS;
}

function validateActionResult(result: AppActionResult): AppActionResult {
  if (!result.requestId.trim()) {
    throw new Error("App action result requires a request id");
  }
  if (result.ok) {
    const bytes = jsonByteLength(result.result ?? null);
    if (bytes > MAX_APP_ACTION_RESULT_BYTES) {
      throw new Error(
        `App action result exceeds the ${MAX_APP_ACTION_RESULT_BYTES}-byte limit`,
      );
    }
    return {
      requestId: result.requestId,
      ok: true,
      result: result.result ?? null,
    };
  }
  return {
    requestId: result.requestId,
    ok: false,
    error:
      typeof result.error === "string" && result.error.trim()
        ? result.error.trim().slice(0, MAX_APP_ACTION_ERROR_CHARS)
        : "Action failed",
  };
}

function validateKeyPart(label: string, value: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars) {
    throw new Error(`${label} must be between 1 and ${maxChars} characters`);
  }
  return normalized;
}

function snapshotFromRow(row: Doc<"appStates"> | null): AppStateSnapshot | null {
  if (!row) return null;
  return {
    // `state` is the spike field. New writes always use `doc`.
    doc: row.doc ?? row.state ?? {},
    actions: normalizeAppActionRegistry(row.actions),
    actionRequest: row.actionRequest,
    characterLine: row.characterLine,
    log: row.log ?? [],
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

async function findStateRow(
  ctx: DbReader,
  stateKey: StateKey,
  legacy?: { sessionId: Id<"sessions">; artifactId: Id<"artifacts"> },
): Promise<Doc<"appStates"> | null> {
  const current = await ctx.db
    .query("appStates")
    .withIndex("by_scope_scopeId_userId_key", (q) =>
      q
        .eq("scope", stateKey.scope)
        .eq("scopeId", stateKey.scopeId)
        .eq("userId", stateKey.userId)
        .eq("key", stateKey.key),
    )
    .unique();
  if (current || !legacy) return current;

  return await ctx.db
    .query("appStates")
    .withIndex("by_session_artifact", (q) =>
      q
        .eq("sessionId", legacy.sessionId)
        .eq("artifactId", legacy.artifactId),
    )
    .unique();
}

async function writeState(
  ctx: MutationCtx,
  stateKey: StateKey,
  args: {
    patch?: unknown;
    logs?: Array<{ level: "log" | "warn" | "error"; message: string }>;
    actions?: unknown;
  },
  legacy?: { sessionId: Id<"sessions">; artifactId: Id<"artifacts"> },
  limits?: {
    maxScopeRows?: number;
    minWriteIntervalMs?: number;
  },
): Promise<AppStateSnapshot> {
  if (
    args.patch === undefined &&
    (args.logs?.length ?? 0) === 0 &&
    args.actions === undefined
  ) {
    throw new Error(
      "App state update must include a patch, log entry, or action registry",
    );
  }
  if (args.patch !== undefined) validatePatch(args.patch);
  const existing = await findStateRow(ctx, stateKey, legacy);
  const actions =
    args.actions === undefined
      ? normalizeAppActionRegistry(existing?.actions)
      : validateActionRegistry(args.actions);

  const updatedAt = Date.now();
  if (existing && limits?.minWriteIntervalMs !== undefined) {
    const elapsed = Math.max(0, updatedAt - existing.updatedAt);
    if (elapsed < limits.minWriteIntervalMs) {
      throw new ConvexError<CustomAppStateRateLimitErrorData>({
        code: "CUSTOM_APP_STATE_RATE_LIMITED",
        message: `Custom app state may be updated at most once every ${limits.minWriteIntervalMs}ms`,
        retryAfterMs: limits.minWriteIntervalMs - elapsed,
      });
    }
  }
  if (!existing && limits?.maxScopeRows !== undefined) {
    const rows = await ctx.db
      .query("appStates")
      .withIndex("by_scope_scopeId", (q) =>
        q.eq("scope", stateKey.scope).eq("scopeId", stateKey.scopeId),
      )
      .take(limits.maxScopeRows);
    if (rows.length >= limits.maxScopeRows) {
      throw new Error(
        `Custom app state is limited to ${limits.maxScopeRows} device/key partitions`,
      );
    }
  }
  const previous = snapshotFromRow(existing);
  const baseDoc = isObject(previous?.doc) ? previous.doc : {};
  const doc =
    args.patch === undefined ? baseDoc : { ...baseDoc, ...args.patch };
  validateDocSize(doc);

  const appendedLog = (args.logs ?? [])
    .slice(-MAX_APP_STATE_LOG_ENTRIES)
    .map((entry) => ({
      level: entry.level,
      message: entry.message.slice(0, MAX_APP_STATE_LOG_CHARS),
      at: updatedAt,
    }));
  const log = [...(previous?.log ?? []), ...appendedLog].slice(
    -MAX_APP_STATE_LOG_ENTRIES,
  );
  const version = (previous?.version ?? 0) + 1;
  const value = {
    ...stateKey,
    doc,
    actions: actions.length > 0 ? actions : undefined,
    log,
    version,
    updatedAt,
  };

  if (existing) {
    await ctx.db.patch(existing._id, value);
  } else {
    await ctx.db.insert("appStates", value);
  }
  return { doc, actions, log, version, updatedAt };
}

async function sessionStateKey(
  ctx: DbReader,
  artifactId: Id<"artifacts">,
): Promise<{
  artifact: Doc<"artifacts">;
  session: Doc<"sessions">;
  stateKey: StateKey;
}> {
  const artifact = await ctx.db.get(artifactId);
  if (!artifact) throw new Error("Artifact not found");
  const session = await ctx.db.get(artifact.sessionId);
  if (!session) throw new Error("Session not found");
  return {
    artifact,
    session,
    stateKey: {
      scope: "session",
      scopeId: String(session._id),
      userId: String(session.userId),
      key: String(artifact._id),
    },
  };
}

async function liveStaticAppForToken(ctx: DbReader, rawToken: string) {
  const token = rawToken.trim();
  if (!token) throw new Error("Invalid custom app token");
  const app = await ctx.db
    .query("customApps")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!app || app.kind !== "static" || app.status !== "live") {
    throw new Error("Invalid custom app token");
  }
  return app;
}

function customAppStateKey(
  customAppId: Id<"customApps">,
  rawUserId: string,
  rawKey: string,
): StateKey {
  return {
    scope: "customApp",
    scopeId: String(customAppId),
    userId: validateKeyPart(
      "userId",
      rawUserId,
      MAX_CUSTOM_APP_STATE_USER_ID_CHARS,
    ),
    key: validateKeyPart("key", rawKey, MAX_CUSTOM_APP_STATE_KEY_CHARS),
  };
}

/** Read one code artifact's state as its owner or an authorized teacher. */
export const getSessionState = authedQuery({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const { artifact, session, stateKey } = await sessionStateKey(
      ctx,
      args.artifactId,
    );
    if (session.userId !== ctx.user._id) {
      if (!isTeacherRole(ctx.user.role)) throw new Error("Forbidden");
      await requireActiveScholarAccess(ctx, ctx.user, session.userId);
    }
    // Put away by a teacher: the owner's subscribed app host gets nothing
    // (null, not a throw, so the frame's tree survives). Teachers still read.
    if (!mayReadTeacherArchived(ctx.user, session)) return null;
    const snapshot = snapshotFromRow(
      await findStateRow(ctx, stateKey, {
        sessionId: session._id,
        artifactId: artifact._id,
      }),
    );
    // Teachers may inspect the state/log/registry, but only the owner host is
    // allowed to receive the tutor's live mailboxes (an action to run, a line
    // to speak through the app's character).
    return snapshot && session.userId !== ctx.user._id
      ? { ...snapshot, actionRequest: undefined, characterLine: undefined }
      : snapshot;
  },
});

/**
 * Read the final saved state for each of a scholar's Vibecode sessions.
 * This is the Portfolio companion to artifacts.getByScholar: teacher-only,
 * institution-scoped, and deliberately has no mutation counterpart.
 *
 * Also lists every TEACHER-ARCHIVED app session, in any sessionMode, and
 * stamps `teacherArchivedAt` on it: this row is where a teacher finds a
 * put-away app to restore it (review/teacher-archive-scholar-apps.html). An
 * archived app that never saved state still appears, as its newest code
 * artifact with an empty snapshot (doc null, no log, version 0, updatedAt =
 * the archive time).
 *
 * Each row also carries `latestPlay`, the newest on-screen interval from
 * appPlaySessions.ts, so "when did they last play it?" has an answer even for
 * an app that never saves. A session with play history but no saved state
 * (any sessionMode — a normal session's app counts) appears with an empty
 * snapshot whose `updatedAt` is 0 (never saved).
 */
export const listSessionStatesForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    const snapshots: Array<{
      sessionId: Id<"sessions">;
      sessionTitle: string;
      artifactId: Id<"artifacts">;
      artifactTitle: string;
      doc: unknown;
      log: AppStateLogEntry[];
      version: number;
      updatedAt: number;
      teacherArchivedAt?: number;
      latestPlay?: LatestAppPlay;
    }> = [];

    for (const session of sessions) {
      if (session.isTestDrive) continue;
      const teacherArchivedAt = session.teacherArchivedAt;
      const played = await readLatestAppPlayForSession(ctx, session._id);
      if (
        session.sessionMode !== "vibecode" &&
        teacherArchivedAt == null &&
        played === null
      ) {
        continue;
      }
      const playStamp = played ? { latestPlay: played.play } : {};
      // A session can hold more than one app: a row titled for the saved app
      // carries THAT app's play, not the session's newest.
      const latestPlayStampFor = async (artifactId: Id<"artifacts">) => {
        if (!played) return {};
        if (played.artifactId === artifactId) return playStamp;
        const play = await readLatestAppPlayForArtifact(ctx, artifactId);
        return play ? { latestPlay: play } : {};
      };
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      const archivedStamp =
        teacherArchivedAt != null ? { teacherArchivedAt } : {};
      const latest = await readLatestSessionState(
        ctx,
        session._id,
        session.userId,
        artifacts,
      );
      if (!latest) {
        if (teacherArchivedAt == null && played === null) continue;
        const playedApp = played
          ? artifacts.find((artifact) => artifact._id === played.artifactId)
          : undefined;
        const newestApp =
          playedApp ??
          artifacts
            .filter((artifact) => artifact.type === "code")
            .sort((a, b) => b._creationTime - a._creationTime)[0];
        if (!newestApp) continue;
        snapshots.push({
          sessionId: session._id,
          sessionTitle: session.title,
          artifactId: newestApp._id,
          artifactTitle: newestApp.title,
          doc: null,
          log: [],
          version: 0,
          updatedAt: teacherArchivedAt ?? 0,
          ...archivedStamp,
          ...(await latestPlayStampFor(newestApp._id)),
        });
        continue;
      }
      snapshots.push({
        sessionId: session._id,
        sessionTitle: session.title,
        artifactId: latest.artifact._id,
        artifactTitle: latest.artifact.title,
        ...latest.snapshot,
        ...archivedStamp,
        ...(await latestPlayStampFor(latest.artifact._id)),
      });
    }

    const lastTouched = (row: (typeof snapshots)[number]) =>
      Math.max(row.updatedAt, row.latestPlay?.lastActiveAt ?? 0);
    return snapshots.sort((a, b) => lastTouched(b) - lastTouched(a));
  },
});

/** Reset app state (Play): clear this session artifact's persisted app-state
 * document so a remount comes back to a clean slate. App state is
 * server-persisted (the host re-posts the saved doc after each iframe reload),
 * so remounting the frame alone does NOT reset it — this must run first (F10).
 * Owner-gated, mirroring `getSessionState`'s ownership check. */
export const clearSessionState = authedMutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const { artifact, session, stateKey } = await sessionStateKey(
      ctx,
      args.artifactId,
    );
    if (session.userId !== ctx.user._id) throw new Error("Forbidden");
    assertNotTeacherArchived(session);
    const existing = await findStateRow(ctx, stateKey, {
      sessionId: session._id,
      artifactId: artifact._id,
    });
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/** Shallow-merge state and append console lines from the owner's sandbox. */
export const updateSessionState = authedMutation({
  args: {
    artifactId: v.id("artifacts"),
    patch: v.optional(v.any()),
    logs: v.optional(v.array(appStateLogInput)),
    actions: v.optional(v.array(appActionRegistrationInput)),
    actionResult: v.optional(appActionResultInput),
  },
  handler: async (ctx, args) => {
    const { artifact, session, stateKey } = await sessionStateKey(
      ctx,
      args.artifactId,
    );
    if (session.userId !== ctx.user._id) throw new Error("Forbidden");
    // A put-away game doesn't keep saving when played (an old build or a
    // stale tab can still be running it).
    assertNotTeacherArchived(session);
    if (args.actionResult !== undefined) {
      if (
        args.patch !== undefined ||
        args.logs !== undefined ||
        args.actions !== undefined
      ) {
        throw new Error("App action results must be acknowledged separately");
      }
      const result = validateActionResult(args.actionResult);
      const existing = await findStateRow(ctx, stateKey, {
        sessionId: session._id,
        artifactId: artifact._id,
      });
      // A second iframe instance (a remount, a reload mid-flight) can run the
      // same request and ack it again; the first ack already recorded the
      // result, so a repeat is a no-op rather than an error on the scholar's
      // screen.
      if (existing?.actionResult?.requestId === result.requestId) {
        return snapshotFromRow(existing);
      }
      if (
        !existing?.actionRequest ||
        existing.actionRequest.id !== result.requestId
      ) {
        throw new Error("App action request is no longer pending");
      }
      const completedAt = Date.now();
      await ctx.db.patch(existing._id, {
        actionRequest: undefined,
        actionResult: { ...result, completedAt },
        version: existing.version + 1,
        updatedAt: completedAt,
      });
      return snapshotFromRow(await ctx.db.get(existing._id));
    }
    return await writeState(
      ctx,
      stateKey,
      { patch: args.patch, logs: args.logs, actions: args.actions },
      { sessionId: session._id, artifactId: artifact._id },
    );
  },
});

/**
 * Where a static custom app's state lives for this caller. Signed in (a
 * scholar on their BunnyPad or in a browser), it is theirs: keyed to their
 * own user id, which comes from their auth and never from the client, so it
 * follows them across devices and nobody else on the same device sees it.
 * Signed out, it is the device's, keyed by the host's device id as before.
 * Viewing as a scholar (getCurrentUser's effective user), staff read that
 * scholar's work; writes are refused then (assertCanWrite).
 *
 * There is deliberately no fallback to the device's row for a signed-in
 * user: a device row records no writer, so on a shared iPad it is whoever
 * used the tile last, and reading or copying it would hand one child's work
 * to the next. Device rows saved before this are kept, readable signed out.
 */
const USER_PARTITION_PREFIX = "user:";

async function customAppPartition(
  ctx: QueryCtx | MutationCtx,
  customAppId: Id<"customApps">,
  deviceUserId: string,
  key: string,
): Promise<StateKey> {
  const user = await getCurrentUser(ctx);
  if (user) return customAppStateKey(customAppId, `user:${user._id}`, key);
  // `user:` keys are minted only above, from auth. A signed-out caller holding
  // the tile's token must not name one, or it could read or overwrite any
  // scholar's saved work.
  if (deviceUserId.trim().startsWith(USER_PARTITION_PREFIX)) {
    throw new Error("userId must be a device id");
  }
  return customAppStateKey(customAppId, deviceUserId, key);
}

/**
 * The static custom-app launcher may run without a Convex identity. Its
 * unguessable app token is therefore the bearer credential, matching
 * `resolveByToken`. Which partition the state lives in is
 * `customAppPartition`'s call; the device id is not an additional secret.
 */
export const getCustomAppState = query({
  args: {
    token: v.string(),
    userId: v.string(),
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const app = await liveStaticAppForToken(ctx, args.token);
    return snapshotFromRow(
      await findStateRow(
        ctx,
        await customAppPartition(ctx, app._id, args.userId, args.key),
      ),
    );
  },
});

/** Public bearer-token write used only by the static custom-app host. */
export const updateCustomAppState = mutation({
  args: {
    token: v.string(),
    userId: v.string(),
    key: v.string(),
    patch: v.optional(v.any()),
    logs: v.optional(v.array(appStateLogInput)),
    actions: v.optional(v.array(appActionRegistrationInput)),
  },
  handler: async (ctx, args) => {
    // The token is the credential here and the app host may call anonymously,
    // so that path is unchanged. A caller that IS signed in as a read-only
    // identity, or is viewing as someone else, is refused: holding a token
    // must not let it write. (Read-only identities are also never handed the
    // token: ./lib/readOnlyRedaction.ts.)
    await assertCanWrite(ctx);
    const app = await liveStaticAppForToken(ctx, args.token);
    return await writeState(
      ctx,
      await customAppPartition(ctx, app._id, args.userId, args.key),
      { patch: args.patch, logs: args.logs, actions: args.actions },
      undefined,
      {
        maxScopeRows: MAX_CUSTOM_APP_STATE_ROWS,
        minWriteIntervalMs: CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
      },
    );
  },
});

/** Queue one owner-only invocation after rechecking the persisted registry. */
export const requestSessionActionForTutor = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    name: v.string(),
    actionArgs: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const { artifact, session, stateKey } = await sessionStateKey(
      ctx,
      args.artifactId,
    );
    if (
      session._id !== args.sessionId ||
      session.userId !== args.callerUserId ||
      // Any session's code app (TRA-519 one app surface: a chat session's app
      // gets run_app_action too); owner + a registered action stay the gate.
      artifact.type !== "code"
    ) {
      throw new Error("App actions are available only in the owner's live app");
    }
    assertNotTeacherArchived(session);
    if (args.actionArgs !== undefined) validateActionArgs(args.actionArgs);
    const existing = await findStateRow(ctx, stateKey, {
      sessionId: session._id,
      artifactId: artifact._id,
    });
    const actions = normalizeAppActionRegistry(existing?.actions);
    if (!existing || !actions.some((action) => action.name === args.name)) {
      throw new Error(`App action "${args.name}" is not registered`);
    }
    const requestedAt = Date.now();
    if (
      existing.actionRequest &&
      !isExpiredActionRequest(existing.actionRequest, requestedAt)
    ) {
      throw new Error("Another app action request is already pending");
    }
    const request: AppActionRequest = {
      id: crypto.randomUUID(),
      name: args.name,
      ...(args.actionArgs !== undefined ? { args: args.actionArgs } : {}),
      requestedAt,
    };
    await ctx.db.patch(existing._id, {
      actionRequest: request,
      actionResult: undefined,
      version: existing.version + 1,
      updatedAt: requestedAt,
    });
    return request;
  },
});

/**
 * Put one tutor-spoken line in the character's mouth; the owner host delivers
 * it on its next update (`rabbithole.character.onLine`). Unlike the action
 * mailbox this UPSERTS: the tutor may speak before the app has ever written
 * state. A newer line replaces an undelivered one; the SDK dedupes by id.
 */
export async function upsertCharacterLine(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    artifactId: Id<"artifacts">;
    line: Infer<typeof characterLineValidator>;
  },
): Promise<void> {
  const { artifact, session, stateKey } = await sessionStateKey(
    ctx,
    args.artifactId,
  );
  if (session._id !== args.sessionId || artifact.type !== "code") {
    throw new Error("Character lines are available only in the owner's app");
  }
  const existing = await findStateRow(ctx, stateKey, {
    sessionId: session._id,
    artifactId: artifact._id,
  });
  const updatedAt = args.line.requestedAt;
  if (existing) {
    await ctx.db.patch(existing._id, {
      characterLine: args.line,
      version: existing.version + 1,
      updatedAt,
    });
    return;
  }
  await ctx.db.insert("appStates", {
    ...stateKey,
    doc: {},
    log: [],
    characterLine: args.line,
    version: 1,
    updatedAt,
  });
}

export const readSessionActionResultForTutor = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const { artifact, session, stateKey } = await sessionStateKey(
      ctx,
      args.artifactId,
    );
    if (
      session._id !== args.sessionId ||
      session.userId !== args.callerUserId ||
      artifact.type !== "code"
    ) {
      throw new Error("Forbidden");
    }
    const row = await findStateRow(ctx, stateKey, {
      sessionId: session._id,
      artifactId: artifact._id,
    });
    return row?.actionResult?.requestId === args.requestId
      ? row.actionResult
      : null;
  },
});

export const cancelSessionActionForTutor = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    requestId: v.string(),
  },
  handler: async (ctx, args) => {
    const { artifact, session, stateKey } = await sessionStateKey(
      ctx,
      args.artifactId,
    );
    if (
      session._id !== args.sessionId ||
      session.userId !== args.callerUserId ||
      artifact.type !== "code"
    ) {
      throw new Error("Forbidden");
    }
    const row = await findStateRow(ctx, stateKey, {
      sessionId: session._id,
      artifactId: artifact._id,
    });
    if (row?.actionRequest?.id === args.requestId) {
      await ctx.db.patch(row._id, { actionRequest: undefined });
      return true;
    }
    return false;
  },
});

/**
 * Staff-only read of a custom app's saved state, for the app's maker. A
 * signed-in scholar's row (`user:<id>`) is listed only when the caller can
 * reach that scholar, so an app opened at another school never shows its
 * scholars' work here. Signed-out device rows are listed as before.
 */
export const listCustomAppStatesForStaff = staffQuery({
  args: { customAppId: v.id("customApps") },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.customAppId);
    if (!app) return [];
    if (
      app.createdBy !== ctx.user._id &&
      !isPlatformAdminRole(ctx.user.role)
    ) {
      throw new Error("Forbidden");
    }
    const rows = await ctx.db
      .query("appStates")
      .withIndex("by_scope_scopeId", (q) =>
        q.eq("scope", "customApp").eq("scopeId", String(args.customAppId)),
      )
      .collect();
    const membership = isPlatformAdminRole(ctx.user.role)
      ? null
      : await resolveActiveMembership(ctx, ctx.user);
    const reachable = isPlatformAdminRole(ctx.user.role)
      ? null
      : membership
        ? await accessibleScholarIds(ctx, membership)
        : new Set<Id<"users">>();
    const visible = rows.filter((row) => {
      if (!row.userId?.startsWith("user:")) return true;
      const id = row.userId.slice("user:".length);
      return reachable === null || id === ctx.user._id || reachable.has(id as Id<"users">);
    });
    return visible.map((row) => ({
      userId: row.userId,
      key: row.key,
      ...snapshotFromRow(row)!,
    }));
  },
});

/** Trusted read used to project one code artifact's state into model context. */
async function readSessionState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  userId: Id<"users">,
  artifactId: Id<"artifacts">,
): Promise<AppStateSnapshot | null> {
  return snapshotFromRow(
    await findStateRow(
      ctx,
      {
        scope: "session",
        scopeId: String(sessionId),
        userId: String(userId),
        key: String(artifactId),
      },
      { sessionId, artifactId },
    ),
  );
}

/**
 * Pick the newest code artifact that has saved state. Shared by the tutor /
 * observer context and the teacher Portfolio so both surfaces show the same app.
 */
export async function readLatestSessionState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  userId: Id<"users">,
  artifacts: Doc<"artifacts">[],
  /** The app the turn acts on (TRA-519): its state is read first, so the
   * tutor reads the open app, not a newer one. Absent = newest first. */
  preferredArtifactId?: Id<"artifacts">,
): Promise<{
  artifact: Doc<"artifacts">;
  snapshot: AppStateSnapshot;
} | null> {
  const codeArtifactsNewestFirst = artifacts
    .filter((artifact) => artifact.type === "code")
    .sort((a, b) => b._creationTime - a._creationTime);
  const preferred = preferredArtifactId
    ? codeArtifactsNewestFirst.find((a) => a._id === preferredArtifactId)
    : undefined;
  if (preferred) {
    // The open app's state or none: falling through to another app's state
    // would hand the tutor (and run_app_action) the wrong app.
    const snapshot = await readSessionState(
      ctx,
      sessionId,
      userId,
      preferred._id,
    );
    return snapshot ? { artifact: preferred, snapshot } : null;
  }
  for (const artifact of codeArtifactsNewestFirst) {
    const snapshot = await readSessionState(
      ctx,
      sessionId,
      userId,
      artifact._id,
    );
    if (snapshot) return { artifact, snapshot };
  }
  return null;
}

/** Reset/purge helper: session-scoped app state is deliberately ephemeral. */
export async function deleteSessionAppStates(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<number> {
  const current = await ctx.db
    .query("appStates")
    .withIndex("by_scope_scopeId", (q) =>
      q.eq("scope", "session").eq("scopeId", String(sessionId)),
    )
    .collect();
  const legacy = await ctx.db
    .query("appStates")
    .withIndex("by_session_artifact", (q) => q.eq("sessionId", sessionId))
    .collect();
  const ids = new Set([...current, ...legacy].map((row) => row._id));
  for (const id of ids) await ctx.db.delete(id);
  return ids.size;
}
