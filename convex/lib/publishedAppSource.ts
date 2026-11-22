// Where a published scholar app comes from (convex/publishedApps.ts), shared
// with the teacher Apps page read (convex/scholarBuiltApps.ts).
//
// A scholar's app can move across sessions: the free-play copy made after an
// assignment carries the app forward (`sessions.freePlayOf`). So a published
// app records the lineage ROOT, and "the scholar's latest version" is the
// newest session in that lineage that holds an app — the same session the
// Apps page shows as the scholar's card.

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { freePlayLineage } from "../sessions";
import { codeAppsNewestFirst } from "./focusApp";
export { freePlayRoot as lineageRoot } from "../sessions";

type Db = { db: QueryCtx["db"] };

/** A session's app: its newest code artifact with any code in it — the app
 *  free play copies forward (sessions.startFreePlay) and the version recorder
 *  versions (lib/focusApp.ts), so a session holding two apps publishes and
 *  refreshes the same one its free-play copy carries. */
export async function sessionAppArtifact(
  ctx: Db,
  sessionId: Id<"sessions">,
): Promise<Doc<"artifacts"> | null> {
  const artifacts = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return (
    codeAppsNewestFirst(artifacts, sessionId).find(
      (a) => a.content.trim() !== "",
    ) ?? null
  );
}

/** The lineage root plus the scholar's current app (newest session first). */
export async function publishSource(
  ctx: Db,
  session: Doc<"sessions">,
): Promise<{
  root: Doc<"sessions">;
  current: { session: Doc<"sessions">; artifact: Doc<"artifacts"> } | null;
}> {
  const lineage = await freePlayLineage(ctx, session);
  const newestFirst = [...lineage].sort(
    (a, b) => b._creationTime - a._creationTime,
  );
  for (const candidate of newestFirst) {
    const artifact = await sessionAppArtifact(ctx, candidate._id);
    if (artifact) {
      return { root: lineage[0], current: { session: candidate, artifact } };
    }
  }
  return { root: lineage[0], current: null };
}

/** The live published copy of a lineage, if a teacher published it. A copy
 *  whose launcher tile was archived no longer counts: publishing again makes
 *  a fresh one rather than reviving a tile the teacher retired. */
export async function livePublishedApp(
  ctx: Db,
  rootSessionId: Id<"sessions">,
): Promise<{
  app: Doc<"customApps">;
  catalog: Doc<"externalApps">;
} | null> {
  const rows = await ctx.db
    .query("customApps")
    .withIndex("by_published_session", (q) =>
      q.eq("publishedFrom.sessionId", rootSessionId),
    )
    // Newest first: if a retired tile is restored after a fresh publish, the
    // fresh one is the copy the Apps page shows and refreshes.
    .order("desc")
    .collect();
  for (const app of rows) {
    if (app.status !== "live" || !app.externalAppId) continue;
    const catalog = await ctx.db.get(app.externalAppId);
    if (catalog && !catalog.archived) return { app, catalog };
  }
  return null;
}

/** A short, stable digest of app HTML (FNV-1a, 32-bit). It only has to tell
 *  "the same app" from "an edited app", never resist an adversary. */
export function contentDigest(html: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${html.length}:${(hash >>> 0).toString(16)}`;
}

/** Whether the published copy still matches the scholar's current app: the
 *  same artifact revision, or the same HTML carried into a free-play copy. */
export function isPublishedCopyCurrent(
  app: Pick<
    Doc<"customApps">,
    "sourceArtifactId" | "sourceRevision" | "sourceDigest"
  >,
  artifact: Pick<Doc<"artifacts">, "_id" | "revision" | "content">,
): boolean {
  if (
    app.sourceArtifactId === artifact._id &&
    app.sourceRevision === (artifact.revision ?? 0)
  ) {
    return true;
  }
  return (
    app.sourceDigest !== undefined &&
    app.sourceDigest === contentDigest(artifact.content)
  );
}
