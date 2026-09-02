import { ConvexError, v } from "convex/values";
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
import { requireActiveScholarAccess } from "./lib/access";
import { isPlatformAdminRole, isTeacherRole } from "./lib/roles";
import { requireRoomAccess } from "./lib/rooms";
import {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  MAX_CUSTOM_APP_STATE_KEY_CHARS,
  MAX_CUSTOM_APP_STATE_ROWS,
  MAX_CUSTOM_APP_STATE_USER_ID_CHARS,
  type CustomAppStateRateLimitErrorData,
} from "../shared/appStatePolicy";
import {
  MAX_SHARED_APP_STATE_DOC_BYTES,
  MAX_SHARED_APP_STATE_STRING_CHARS,
  ROOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  ROOM_PRESENCE_KEY,
  ROOM_PRESENCE_STALE_MS,
  ROOM_SHARED_STATE_KEY,
  ROOM_SHARED_USER_ID,
  ROOM_WRITE_RATE_KEY,
  type RoomAppStateRateLimitErrorData,
} from "../shared/roomAppState";
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

export const MAX_APP_STATE_DOC_BYTES = 8 * 1024;
export const MAX_APP_STATE_LOG_ENTRIES = 30;
export const MAX_APP_STATE_LOG_CHARS = 300;
export {
  CUSTOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
  MAX_CUSTOM_APP_STATE_KEY_CHARS,
  MAX_CUSTOM_APP_STATE_ROWS,
  MAX_CUSTOM_APP_STATE_USER_ID_CHARS,
  MAX_SHARED_APP_STATE_DOC_BYTES,
  MAX_SHARED_APP_STATE_STRING_CHARS,
  ROOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
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
  log: AppStateLogEntry[];
  version: number;
  updatedAt: number;
};

type StateKey = {
  scope: "session" | "customApp" | "room";
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

function validateDocSize(
  doc: unknown,
  maxBytes = MAX_APP_STATE_DOC_BYTES,
): void {
  const bytes = serializedBytes(doc);
  if (bytes > maxBytes) {
    throw new Error(
      `App state exceeds the ${maxBytes}-byte limit (${bytes} bytes)`,
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

const ansiControlSequence =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const unsafeControlCharacters =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function sanitizeSharedString(value: string): string {
  const sanitized = value
    .replace(ansiControlSequence, "")
    .replace(unsafeControlCharacters, "")
    .replace(/<(\/?live_app_state_data)/gi, "&lt;$1");
  if (sanitized.length > MAX_SHARED_APP_STATE_STRING_CHARS) {
    throw new Error(
      `Shared app state strings are limited to ${MAX_SHARED_APP_STATE_STRING_CHARS} characters`,
    );
  }
  return sanitized;
}

function sanitizeSharedValue(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error("Shared app state is nested too deeply");
  if (typeof value === "string") return sanitizeSharedString(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) =>
      sanitizeSharedValue(entry, depth + 1),
    );
  }
  if (isObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [rawKey, entry] of Object.entries(value).slice(0, 100)) {
      const key = sanitizeSharedString(rawKey).slice(0, 128);
      if (!key || entry === undefined) continue;
      sanitized[key] = sanitizeSharedValue(entry, depth + 1);
    }
    return sanitized;
  }
  throw new Error("Shared app state must contain JSON values");
}

export function sanitizeSharedAppStatePatch(
  patch: unknown,
): Record<string, unknown> {
  validatePatch(patch);
  return sanitizeSharedValue(patch) as Record<string, unknown>;
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
    maxDocBytes?: number;
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
  validateDocSize(doc, limits?.maxDocBytes);

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
    const snapshot = snapshotFromRow(
      await findStateRow(ctx, stateKey, {
        sessionId: session._id,
        artifactId: artifact._id,
      }),
    );
    // Teachers may inspect the state/log/registry, but only the owner host is
    // allowed to receive and execute the tutor's live invocation mailbox.
    return snapshot && session.userId !== ctx.user._id
      ? { ...snapshot, actionRequest: undefined }
      : snapshot;
  },
});

/**
 * Read the final saved state for each of a scholar's Vibecode sessions.
 * This is the Portfolio companion to artifacts.getByScholar: teacher-only,
 * institution-scoped, and deliberately has no mutation counterpart.
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
    }> = [];

    for (const session of sessions) {
      if (session.sessionMode !== "vibecode" || session.isTestDrive) continue;
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      const latest = await readLatestSessionState(
        ctx,
        session._id,
        session.userId,
        artifacts,
      );
      if (!latest) continue;
      snapshots.push({
        sessionId: session._id,
        sessionTitle: session.title,
        artifactId: latest.artifact._id,
        artifactTitle: latest.artifact.title,
        ...latest.snapshot,
      });
    }

    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt);
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
 * The static custom-app launcher has no Convex identity. Its unguessable app
 * token is therefore the bearer credential, matching `resolveByToken`; the
 * host-origin device id only partitions state and is not an additional secret.
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
        customAppStateKey(app._id, args.userId, args.key),
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
    const app = await liveStaticAppForToken(ctx, args.token);
    return await writeState(
      ctx,
      customAppStateKey(app._id, args.userId, args.key),
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
      artifact.type !== "code" ||
      (session.sessionMode !== "vibecode" &&
        session.sessionMode !== "workbench")
    ) {
      throw new Error("App actions are available only in the owner's live app");
    }
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

/** Staff-only read surface for a custom app's per-device snapshots. */
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
    return rows.map((row) => ({
      userId: row.userId,
      key: row.key,
      ...snapshotFromRow(row)!,
    }));
  },
});

function roomStateKey(roomId: Id<"rooms">): StateKey {
  return {
    scope: "room",
    scopeId: String(roomId),
    userId: ROOM_SHARED_USER_ID,
    key: ROOM_SHARED_STATE_KEY,
  };
}

function roomUserStateKey(
  roomId: Id<"rooms">,
  userId: Id<"users">,
  key: typeof ROOM_PRESENCE_KEY | typeof ROOM_WRITE_RATE_KEY,
): StateKey {
  return {
    scope: "room",
    scopeId: String(roomId),
    userId: String(userId),
    key,
  };
}

async function enforceRoomWriterRate(
  ctx: MutationCtx,
  roomId: Id<"rooms">,
  userId: Id<"users">,
): Promise<void> {
  const stateKey = roomUserStateKey(roomId, userId, ROOM_WRITE_RATE_KEY);
  const existing = await findStateRow(ctx, stateKey);
  const now = Date.now();
  if (
    existing &&
    now - existing.updatedAt < ROOM_APP_STATE_MIN_WRITE_INTERVAL_MS
  ) {
    throw new ConvexError<RoomAppStateRateLimitErrorData>({
      code: "ROOM_APP_STATE_RATE_LIMITED",
      message: `Room app state may be updated at most once every ${ROOM_APP_STATE_MIN_WRITE_INTERVAL_MS}ms`,
      retryAfterMs: ROOM_APP_STATE_MIN_WRITE_INTERVAL_MS,
    });
  }
  const value = {
    ...stateKey,
    doc: {},
    log: [],
    version: (existing?.version ?? 0) + 1,
    updatedAt: now,
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else await ctx.db.insert("appStates", value);
}

/** Reactive shared document read for a room member or the owning teacher. */
export const getRoomState = authedQuery({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    await requireRoomAccess(ctx, ctx.user, args.roomId);
    return snapshotFromRow(await findStateRow(ctx, roomStateKey(args.roomId)));
  },
});

/** LWW shallow-merge into the room's one shared, sanitized document. */
export const updateRoomState = authedMutation({
  args: {
    roomId: v.id("rooms"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await requireRoomAccess(ctx, ctx.user, args.roomId);
    const patch = sanitizeSharedAppStatePatch(args.patch);
    await enforceRoomWriterRate(ctx, args.roomId, ctx.user._id);
    return await writeState(
      ctx,
      roomStateKey(args.roomId),
      { patch },
      undefined,
      { maxDocBytes: MAX_SHARED_APP_STATE_DOC_BYTES },
    );
  },
});

/** Server-authoritative presence: the authenticated user is always the subject. */
export const joinRoomPresence = authedMutation({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    await requireRoomAccess(ctx, ctx.user, args.roomId);
    const stateKey = roomUserStateKey(
      args.roomId,
      ctx.user._id,
      ROOM_PRESENCE_KEY,
    );
    const existing = await findStateRow(ctx, stateKey);
    const previous = snapshotFromRow(existing);
    const previousDoc = isObject(previous?.doc) ? previous.doc : {};
    const now = Date.now();
    const joinedAt =
      typeof previousDoc.joinedAt === "number" ? previousDoc.joinedAt : now;
    const value = {
      ...stateKey,
      doc: { joinedAt },
      log: [],
      version: (existing?.version ?? 0) + 1,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("appStates", value);
    return { joinedAt, lastSeenAt: now };
  },
});

export const leaveRoomPresence = authedMutation({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    // Cleanup remains available just after a teacher removes this member.
    // The authenticated user can only delete their own presence partition.
    const existing = await findStateRow(
      ctx,
      roomUserStateKey(args.roomId, ctx.user._id, ROOM_PRESENCE_KEY),
    );
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const getRoomPresence = authedQuery({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    const room = await requireRoomAccess(ctx, ctx.user, args.roomId);
    const allowedUserIds = new Set([
      String(room.ownerTeacherId),
      ...room.memberIds.map(String),
    ]);
    const cutoff = Date.now() - ROOM_PRESENCE_STALE_MS;
    const rows = await ctx.db
      .query("appStates")
      .withIndex("by_scope_scopeId", (q) =>
        q.eq("scope", "room").eq("scopeId", String(args.roomId)),
      )
      .collect();
    const active = rows.filter(
      (row) =>
        row.key === ROOM_PRESENCE_KEY &&
        row.updatedAt >= cutoff &&
        row.userId !== undefined &&
        allowedUserIds.has(row.userId),
    );
    return (
      await Promise.all(
        active.map(async (row) => {
          const userId = ctx.db.normalizeId("users", row.userId!);
          const user = userId ? await ctx.db.get(userId) : null;
          if (!user || !userId) return null;
          const doc = isObject(row.doc) ? row.doc : {};
          return {
            userId,
            name: user.name ?? user.username ?? "Scholar",
            joinedAt:
              typeof doc.joinedAt === "number"
                ? doc.joinedAt
                : row.updatedAt,
            lastSeenAt: row.updatedAt,
          };
        }),
      )
    ).filter((entry) => entry !== null);
  },
});

/** Trusted read used to project one code artifact's state into model context. */
async function readSessionState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  userId: Id<"users">,
  artifactId: Id<"artifacts">,
): Promise<AppStateSnapshot | null> {
  // Peer-authored room state is app-only UGC. Model context reads only the
  // scholar's own session partition.
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
): Promise<{
  artifact: Doc<"artifacts">;
  snapshot: AppStateSnapshot;
} | null> {
  const codeArtifactsNewestFirst = artifacts
    .filter((artifact) => artifact.type === "code")
    .sort((a, b) => b._creationTime - a._creationTime);
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
