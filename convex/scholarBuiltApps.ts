// The apps scholars built, for the teacher Apps page
// (review/teacher-apps-scholar-rows-options.html, Option 2): they sit in All
// beside catalog apps, in a By scholars tab of their own, and in Archived.
//
// An app here is the code artifact in a scholar's app session — the same thing
// sessions.archiveApp / restoreApp (PR #4258) act on, and the same rule the
// scholar Home uses (lib/homeOrigin: couldHoldBuiltApp + a code artifact).
// Archive state is the session's `teacherArchivedAt`; nothing new is stored.
//
// PAGING OVER THE TENANT. A page walks the scope's sessions newest first —
// one scholar's (`by_user`) or their schools' (`by_institution`) — never the
// whole deployment, and stops when it has `numItems` cards or has looked at
// SCAN_BUDGET sessions, returning a cursor either way. So a page never fills
// up with another school's apps, and "Show more" always moves forward. A
// free build can live in a chat-primary session that no session field marks,
// so the walk tests each session rather than reading an app-only index.
//
// A row joins the scope through its builder today; if scholar apps are later
// shared, `inScope` below is where reach widens.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { teacherQuery } from "./lib/customFunctions";
import { requireScholarsAccessible } from "./lib/access";
import { couldHoldBuiltApp } from "./lib/homeOrigin";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { MAX_SCOPE_SCHOLARS } from "../shared/teacherAppsScope";

export type ScholarBuiltApp = {
  sessionId: Id<"sessions">;
  title: string;
  builder: { id: Id<"users">; name: string; image: string | null };
  /** The activity it was built in, or null for a free build. */
  activityTitle: string | null;
  /** Built in a Quest the scholar wrote themselves. */
  ownQuest: boolean;
  /** Set when the app began as a teacher's starter (and has since changed). */
  fromStarter: { teacherName: string | null; starterName: string } | null;
  lastActiveAt: number;
  /** When the app's code last changed: the App designer's revision row for the
   *  artifact's current revision (`codeArtifactRevisions`), else the session's
   *  last activity when no revision row was recorded. */
  lastEditedAt: number;
  /** The activity it was built in carries a learning contract (`buildContract`). */
  hasLearningContract: boolean;
  archivedAt: number | null;
};

/** Narrow the walk to apps whose activity has (or lacks) a learning contract.
 *  Applied while paging, so a page still fills with matching apps. */
export type LearningContractFilter = "with" | "without";

/** Sessions one page may look at before handing back a cursor. */
export const SCAN_BUDGET = 300;
/** Sessions read per source per step of the walk. */
const CHUNK = 60;
const MAX_PAGE = 50;

/**
 * A starter copy the scholar has not touched is the teacher's app, not theirs:
 * the setup seeds it at revision 0 (lib/sessionActivitySetup.ts), and every
 * write bumps the revision. A copy with no revision at all predates that
 * stamping and is shown, so a legacy copy is never hidden for good.
 */
export function isUnchangedStarterCopy(
  session: Pick<Doc<"sessions">, "vibecodeStarterUsedAt">,
  artifact: Pick<Doc<"artifacts">, "revision">,
): boolean {
  return session.vibecodeStarterUsedAt != null && artifact.revision === 0;
}

type Source = (cursor: number | null) => Promise<Doc<"sessions">[]>;

export const listForScholars = teacherQuery({
  args: {
    scholarIds: v.array(v.id("users")),
    archived: v.boolean(),
    paginationOpts: paginationOptsValidator,
    // Walk direction over session start time. "desc" (the default) is newest
    // first; "asc" walks the same indexes the other way, so Oldest first costs
    // nothing extra. There is no index on edit time, so no edit-order walk.
    order: v.optional(v.union(v.literal("desc"), v.literal("asc"))),
    learningContract: v.optional(
      v.union(v.literal("with"), v.literal("without")),
    ),
  },
  handler: async (
    ctx,
    { scholarIds, archived, paginationOpts, order, learningContract },
  ) => {
    const asc = order === "asc";
    const ids = [...new Set(scholarIds)].slice(0, MAX_SCOPE_SCHOLARS);
    const done = (page: ScholarBuiltApp[]) => ({
      page,
      isDone: true,
      continueCursor: "",
    });
    if (ids.length === 0) return done([]);
    // Every id must be a scholar this teacher can reach in their current
    // institution context; the role wrapper alone would cross tenants.
    await requireScholarsAccessible(ctx, ctx.user, ids);
    const inScopeIds = new Set(ids.map(String));
    const inScope = (session: Doc<"sessions">) =>
      inScopeIds.has(String(session.userId));

    const sources = await sourcesFor(ctx, ids, asc);
    if (sources.length === 0) return done([]);

    const cache = new Map<string, unknown>();
    const cached = async <T,>(key: string, load: () => Promise<T>) => {
      if (!cache.has(key)) cache.set(key, await load());
      return cache.get(key) as T;
    };

    const want = Math.min(Math.max(paginationOpts.numItems, 1), MAX_PAGE);
    let before =
      paginationOpts.cursor && paginationOpts.cursor !== ""
        ? Number(paginationOpts.cursor)
        : null;
    let scanned = 0;
    const page: ScholarBuiltApp[] = [];

    // Merge the sources in walk order (newest first by default). A source that
    // returned a full chunk may hold more past its last row, so only rows up
    // to the nearest such tail are safe to take this step; the walk resumes
    // past it. ("before" is the cursor in either direction.)
    while (page.length < want && scanned < SCAN_BUDGET) {
      const chunks = await Promise.all(sources.map((source) => source(before)));
      const fullTails = chunks
        .filter((chunk) => chunk.length === CHUNK)
        .map((chunk) => chunk[chunk.length - 1]._creationTime);
      const bound =
        fullTails.length === 0
          ? null
          : asc
            ? Math.min(...fullTails)
            : Math.max(...fullTails);
      const merged = chunks
        .flat()
        .filter(
          (s) =>
            bound === null ||
            (asc ? s._creationTime <= bound : s._creationTime >= bound),
        )
        .sort((a, b) =>
          asc
            ? a._creationTime - b._creationTime
            : b._creationTime - a._creationTime,
        );
      if (merged.length === 0) return done(page);
      for (const session of merged) {
        scanned += 1;
        before = session._creationTime;
        const row = await cardFor(ctx, session, archived, inScope, cached);
        if (
          row &&
          (learningContract === undefined ||
            row.hasLearningContract === (learningContract === "with"))
        ) {
          page.push(row);
        }
        if (page.length >= want || scanned >= SCAN_BUDGET) break;
      }
      const consumedAll = before === merged[merged.length - 1]._creationTime;
      if (consumedAll && bound === null) return done(page);
    }
    return { page, isDone: false, continueCursor: String(before) };
  },
});

/** Where the scope's sessions live: one scholar's own, or their schools'. */
async function sourcesFor(
  ctx: QueryCtx,
  ids: Id<"users">[],
  asc: boolean,
): Promise<Source[]> {
  const direction = asc ? "asc" : "desc";
  if (ids.length === 1) {
    const userId = ids[0];
    return [
      (cursor) =>
        ctx.db
          .query("sessions")
          .withIndex("by_user", (q) =>
            cursor === null
              ? q.eq("userId", userId)
              : asc
                ? q.eq("userId", userId).gt("_creationTime", cursor)
                : q.eq("userId", userId).lt("_creationTime", cursor),
          )
          .order(direction)
          .take(CHUNK),
    ];
  }
  const institutions = new Set<Id<"institutions">>();
  for (const id of ids) {
    const iid = await scholarInstitutionId(ctx, id);
    if (iid) institutions.add(iid);
  }
  return [...institutions].map(
    (institutionId): Source =>
      (cursor) =>
        ctx.db
          .query("sessions")
          .withIndex("by_institution", (q) =>
            cursor === null
              ? q.eq("institutionId", institutionId)
              : asc
                ? q.eq("institutionId", institutionId).gt("_creationTime", cursor)
                : q.eq("institutionId", institutionId).lt("_creationTime", cursor),
          )
          .order(direction)
          .take(CHUNK),
  );
}

async function cardFor(
  ctx: QueryCtx,
  session: Doc<"sessions">,
  archived: boolean,
  inScope: (session: Doc<"sessions">) => boolean,
  cached: <T>(key: string, load: () => Promise<T>) => Promise<T>,
): Promise<ScholarBuiltApp | null> {
  if (!inScope(session)) return null;
  // Rehearsals, offline stubs and exemplars are not a scholar's build.
  if (session.isTestDrive || session.isOffline || session.seedExemplar) {
    return null;
  }
  if ((session.teacherArchivedAt != null) !== archived) return null;
  const activity = session.activityId
    ? await cached(`activity:${session.activityId}`, () =>
        ctx.db.get(session.activityId!),
      )
    : null;
  // An ordinary activity's chat is never read for an artifact.
  if (!couldHoldBuiltApp(session, activity)) return null;
  // The app: the session's first code artifact that has any code in it, read
  // once.
  const artifact = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .filter((q) =>
      q.and(q.eq(q.field("type"), "code"), q.neq(q.field("content"), "")),
    )
    .first();
  if (!artifact || artifact.content.trim() === "") return null;
  if (isUnchangedStarterCopy(session, artifact)) return null;
  // One card per free-play lineage: its newest session. A copy is always
  // newer than what it copies, so a session that has a copy steps aside
  // (archive and restore already act on the whole lineage).
  const copy = await ctx.db
    .query("sessions")
    .withIndex("by_free_play_of", (q) => q.eq("freePlayOf", session._id))
    .first();
  if (copy && copy.userId === session.userId) return null;

  const builder = await cached(`user:${session.userId}`, () =>
    ctx.db.get(session.userId),
  );
  const unit = session.unitId
    ? await cached(`unit:${session.unitId}`, () => ctx.db.get(session.unitId!))
    : null;
  const starter =
    session.vibecodeStarterUsedAt != null && activity?.starterAppId
      ? await cached(`starter:${activity.starterAppId}`, async () => {
          const app = await ctx.db.get(activity.starterAppId!);
          if (!app) return null;
          const teacher = app.createdBy ? await ctx.db.get(app.createdBy) : null;
          return {
            starterName: app.name,
            teacherName: teacher?.name ?? teacher?.username ?? null,
          };
        })
      : null;
  // The code's last change: the revision row stamped for the artifact's
  // current revision, read by its index. The live artifact row carries no edit
  // time of its own, so a session with no recorded revision falls back to its
  // last activity.
  const revisionRow =
    artifact.revision != null
      ? await ctx.db
          .query("codeArtifactRevisions")
          .withIndex("by_artifact_revision", (q) =>
            q.eq("artifactId", artifact._id).eq("revision", artifact.revision!),
          )
          .first()
      : null;
  const lastActiveAt = session.lastMessageAt ?? session._creationTime;
  return {
    sessionId: session._id,
    title: artifact.title || session.title,
    builder: {
      id: session.userId,
      name: builder?.name ?? builder?.username ?? "Scholar",
      image: builder?.image ?? null,
    },
    activityTitle: activity?.title ?? null,
    ownQuest: unit?.authorScholarId === session.userId,
    fromStarter: starter,
    lastActiveAt,
    lastEditedAt: revisionRow?.createdAt ?? lastActiveAt,
    hasLearningContract: activity?.buildContract != null,
    archivedAt: session.teacherArchivedAt ?? null,
  };
}
