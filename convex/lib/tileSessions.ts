/**
 * TILE SESSIONS: a scholar's first-party app tile opens an ordinary session.
 *
 * Tapping a first-party tile (v1: only the Python bench) opens a `sessions`
 * row shown in the Workshop (sessionMode "vibecode") in Play: the app in
 * front, the tutor behind the Workshop's existing chat toggle, closed by
 * default. There is no separate "launch" concept; the one new fact is
 * provenance (`sessions.sourceCustomAppId` / `sourceExternalAppId`). The
 * mutations live in convex/vibecode.ts; this module holds the rules every
 * reader shares:
 *
 *  - which custom app opens a session at all (`tileSessionApp`): one with a
 *    reviewed tutor brief, marked `customApps.fixedApp`. A generic "beside
 *    any app" posture is how a tutor drifts into doing the work, so an app
 *    without a brief keeps today's bare host;
 *  - the default title ("Python bench · Nov 10") and whether a title is still
 *    that default, so the first-exchange auto-title may replace it the way it
 *    replaces "New Project" (a manual rename is never overwritten);
 *  - visibility: a tile session never shows on scholar Home (the tile and its
 *    switcher are its home) or on the teacher Apps page (the scholar did not
 *    build the app), and an UNSTARTED one (no message, no saved work) shows
 *    in no list at all.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { CUSTOM_APP_URL_PREFIX, isCustomAppUrl } from "../../shared/appKind";
import { firstPlayedRow } from "../../shared/appPlaySession";
import { ROLES } from "./roles";
import { timeZoneForInstitution } from "./institutionTime";
import { PYTHON_BENCH_FIXED_APP } from "./pythonBench";
import { PYTHON_BENCH_STARTER_CODE } from "./pythonBenchApp.generated";
import { resolveAppIconUrl } from "./externalAppIconUrl";

type DbCtx = Pick<QueryCtx, "db">;

/** The custom-app partition a scholar's tile work lived in before tile
 *  sessions (appStates.customAppPartition for a signed-in user). */
export function customAppUserPartition(userId: Id<"users">): string {
  return `user:${userId}`;
}
/** The key the bench (and every SDK app by default) saves under. */
export const CUSTOM_APP_DEFAULT_STATE_KEY = "default";

/** A session a first-party tile opened. */
export function isTileSession(
  session: Pick<Doc<"sessions">, "sourceCustomAppId">,
): boolean {
  return session.sourceCustomAppId != null;
}

/** What a tile session is opened on: a live static app with a reviewed brief. */
export type TileSessionApp = Doc<"customApps"> & {
  html: string;
  fixedApp: NonNullable<Doc<"customApps">["fixedApp"]>;
};

/**
 * May this custom app open a tile session? Only a live static app that
 * carries a reviewed tutor brief, which today means `fixedApp:
 * "python-bench"`: the bench's brief (PYTHON_BENCH_BRIEF) keeps the tutor a
 * lab partner that never names the bug, and `fixedApp` makes every AI write
 * path refuse the session's copy.
 */
export function tileSessionApp(
  app: Doc<"customApps"> | null | undefined,
): TileSessionApp | null {
  if (!app) return null;
  if (app.kind !== "static" || app.status !== "live") return null;
  if (app.fixedApp !== PYTHON_BENCH_FIXED_APP) return null;
  if (typeof app.html !== "string" || app.html.trim() === "") return null;
  return app as TileSessionApp;
}

/**
 * The custom app behind a launcher tile, resolved server-side from the tile's
 * stored `/custom-apps?token=` URL. The custom app must point back at this
 * catalog row (`customApps.externalAppId`), so another tile that merely
 * carries the same token (a hand-made web tile to the URL) never opens it.
 */
export async function customAppForTile(
  ctx: DbCtx,
  app: Pick<Doc<"externalApps">, "_id" | "webUrl">,
): Promise<Doc<"customApps"> | null> {
  if (!isCustomAppUrl(app.webUrl)) return null;
  const token = app.webUrl
    .slice(CUSTOM_APP_URL_PREFIX.length)
    .split("&")[0]
    .trim();
  if (!token) return null;
  const customApp = await ctx.db
    .query("customApps")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();
  if (!customApp || customApp.externalAppId !== app._id) return null;
  return customApp;
}

/** The tile-session app behind a catalog row, or null when it opens no session. */
export async function tileSessionAppForExternalApp(
  ctx: DbCtx,
  externalAppId: Id<"externalApps">,
): Promise<TileSessionApp | null> {
  const app = await ctx.db.get(externalAppId);
  if (!app) return null;
  return tileSessionApp(await customAppForTile(ctx, app));
}

/** Tile sessions are for a signed-in scholar on their own launcher. */
export function userOpensTileSessions(user: Pick<Doc<"users">, "role">): boolean {
  return user.role === ROLES.SCHOLAR;
}

function monthDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(ms);
}

/** "Python bench · Nov 10": the app and the day, in the school's time zone. */
export function tileSessionTitle(
  appName: string,
  createdAtMs: number,
  timeZone: string,
): string {
  return `${appName.trim()} · ${monthDay(createdAtMs, timeZone)}`;
}

/**
 * Is this tile session still titled with its default (the app name and the
 * day it was made)? The first-exchange auto-title replaces it then, as it
 * replaces "New Project". Recomputed from the app's current name and the
 * session's own creation day, so a scholar's rename, which can be anything
 * else, is never mistaken for the default.
 */
export async function hasDefaultTileTitle(
  ctx: DbCtx,
  session: Pick<
    Doc<"sessions">,
    "sourceCustomAppId" | "institutionId" | "title" | "_creationTime"
  >,
): Promise<boolean> {
  if (!session.sourceCustomAppId) return false;
  const app = await ctx.db.get(session.sourceCustomAppId);
  if (!app) return false;
  const timeZone = await timeZoneForInstitution(ctx, session.institutionId);
  return (
    session.title === tileSessionTitle(app.name, session._creationTime, timeZone)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameProgram(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
  return norm(a) === norm(b);
}

/**
 * Does one saved app-state doc hold the scholar's work? The bench saves its
 * state on every open (restore, then again when Python is ready), so for the
 * bench a doc counts only when the program differs from the starter or
 * something ran. Any other app: a non-empty doc.
 */
export function savedDocHoldsWork(
  fixedApp: string | null | undefined,
  doc: unknown,
): boolean {
  if (!isRecord(doc)) return false;
  if (fixedApp !== PYTHON_BENCH_FIXED_APP) return Object.keys(doc).length > 0;
  if (doc.lastRun != null || doc.trace != null) return true;
  // Present only when the program outgrew the tutor's view or the save cap.
  if (doc.workspace != null || doc.codeNotSaved != null) return true;
  if (typeof doc.code === "string") {
    return !sameProgram(doc.code, PYTHON_BENCH_STARTER_CODE);
  }
  // An excerpt object: a program far longer than the starter.
  return doc.code != null;
}

/** Saved work in a tile session's own (session-scope) app state. */
export async function tileSessionHasSavedWork(
  ctx: DbCtx,
  session: Pick<Doc<"sessions">, "_id">,
): Promise<boolean> {
  const rows = await ctx.db
    .query("appStates")
    .withIndex("by_scope_scopeId", (q) =>
      q.eq("scope", "session").eq("scopeId", String(session._id)),
    )
    .collect();
  for (const row of rows) {
    const artifactId = row.key ? ctx.db.normalizeId("artifacts", row.key) : null;
    const artifact = artifactId ? await ctx.db.get(artifactId) : null;
    if (savedDocHoldsWork(artifact?.fixedApp, row.doc ?? row.state)) return true;
  }
  return false;
}

/**
 * A tile session nobody has used yet: no message and no saved work. Teacher,
 * aide and parent lists skip it until either exists; after that it is an
 * ordinary session titled after the app.
 */
export async function isUnstartedTileSession(
  ctx: DbCtx,
  session: Pick<Doc<"sessions">, "_id" | "sourceCustomAppId" | "lastMessageAt">,
): Promise<boolean> {
  if (!isTileSession(session)) return false;
  if (session.lastMessageAt != null) return false;
  return !(await tileSessionHasSavedWork(ctx, session));
}

/** Drop unstarted tile sessions from a list, keeping its order. */
export async function withoutUnstartedTileSessions<
  T extends Pick<Doc<"sessions">, "_id" | "sourceCustomAppId" | "lastMessageAt">,
>(ctx: DbCtx, sessions: T[]): Promise<T[]> {
  const kept: T[] = [];
  for (const session of sessions) {
    if (!(await isUnstartedTileSession(ctx, session))) kept.push(session);
  }
  return kept;
}

/**
 * When the scholar last had this session: its newest app play
 * (appPlaySessions), its last message, or its creation. Orders the switcher
 * and picks which session a tile tap reopens, so the two agree.
 */
export async function tileSessionLastOpenedAt(
  ctx: DbCtx,
  session: Pick<Doc<"sessions">, "_id" | "_creationTime" | "lastMessageAt">,
): Promise<number> {
  // An untouched foreground bounce is not the scholar opening it.
  const play = await firstPlayedRow(
    ctx.db
      .query("appPlaySessions")
      .withIndex("by_session_startedAt", (q) => q.eq("sessionId", session._id))
      .order("desc"),
  );
  return Math.max(
    session._creationTime,
    session.lastMessageAt ?? 0,
    play?.lastActiveAt ?? 0,
    play?.startedAt ?? 0,
  );
}

/** The launcher tile a tile session came from, as a teacher list row draws it
 *  (`AppTileIcon` takes these four fields). */
export type TileSessionSourceApp = {
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
};

/**
 * The app behind a tile session, for list rows that label it "<app> · free
 * play" with the tile's own mark instead of "Tutoring session". Null for any
 * other session, and for a tile session whose catalog row is gone (the row
 * then reads as an ordinary session, which it is).
 */
export async function tileSessionSourceApp(
  ctx: Pick<QueryCtx, "db" | "storage">,
  session: Pick<Doc<"sessions">, "sourceCustomAppId" | "sourceExternalAppId">,
): Promise<TileSessionSourceApp | null> {
  if (!isTileSession(session) || !session.sourceExternalAppId) return null;
  const app = await ctx.db.get(session.sourceExternalAppId);
  if (!app) return null;
  return {
    name: app.name,
    iconUrl: await resolveAppIconUrl(ctx, app),
    iconEmoji: app.iconEmoji ?? null,
    color: app.color ?? null,
  };
}
