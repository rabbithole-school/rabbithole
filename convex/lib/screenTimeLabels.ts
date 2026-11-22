// Labels for the School › Screen time day strip: what each stretch was, as
// specifically as the server's records allow. TITLES AND NAMES ONLY: an app's
// title, an activity or unit title, the class and the teacher who assigned
// it, a practice skill's name. Never message content.
//
// Everything here reuses the teacher app's own resolution:
//   • where a session came from — resolveObserverOrigin (lib/observerOrigin.ts)
//   • an assignment's class      — resolveAssignmentClass (classResolver.ts)
//   • a practice skill's name    — knowledgeNodes.by_nodeKey → label
// Each lookup is cached per id, so a whole school's day costs one read per
// distinct session, assignment, group, teacher and skill.
//
// TENANCY. A label names curriculum, a class and a teacher, so it is only
// drawn from a unit the caller's scope may read (`unitReadable`). A scholar
// who moved schools keeps their old web-activity and practice rows, and
// another school's activity title, class or teacher must not appear on this
// school's page; such a stretch keeps only its type and the app's name.

import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveAssignmentClass } from "../classResolver";
import { resolveObserverOrigin } from "./observerOrigin";

const SEPARATOR = " · ";

export type ScreenTimeLabeler = {
  /** "Volcano app · Volcanoes unit · Seals · with Ms. Torres", or "… · self-started". */
  forSession: (
    session: Doc<"sessions">,
    leading?: string | null,
  ) => Promise<string>;
  forSessionId: (
    sessionId: Id<"sessions">,
    leading?: string | null,
  ) => Promise<string | undefined>;
  /** A web activity session: the activity or app title, plus its class and teacher. */
  forWebActivity: (row: Doc<"webActivitySessions">) => Promise<string | undefined>;
  /** A practice skill's name, falling back to its key. */
  forPracticeNode: (nodeKey: string) => Promise<string>;
};

export function createScreenTimeLabeler(
  ctx: QueryCtx,
  /** Whether a unit's school is one the caller may read (an unstamped unit is the caller's call too). */
  institutionReadable: (institutionId: Id<"institutions"> | undefined) => boolean,
): ScreenTimeLabeler {
  const docs = new Map<string, unknown>();
  async function get<T extends TableNames>(
    id: Id<T> | undefined | null,
  ): Promise<Doc<T> | null> {
    if (!id) return null;
    if (!docs.has(id)) docs.set(id, await ctx.db.get(id));
    return (docs.get(id) as Doc<T> | null) ?? null;
  }
  const classLabels = new Map<string, string | null>();
  const unitReadable = (unit: Doc<"units"> | null) =>
    unit === null || institutionReadable(unit.institutionId);
  const nodeLabels = new Map<string, string>();

  /** "Seals · with Ms. Torres", or whichever half is known. */
  async function assignmentLabel(
    assignmentId: Id<"assignments">,
    activityId?: Id<"activities">,
  ): Promise<string | null> {
    const key = `${assignmentId}::${activityId ?? ""}`;
    if (classLabels.has(key)) return classLabels.get(key) ?? null;
    const assignment = await get(assignmentId);
    if (!unitReadable(await get(assignment?.unitId))) {
      classLabels.set(key, null);
      return null;
    }
    const placed = await resolveAssignmentClass(ctx, assignmentId, activityId);
    const groupId = placed?.groupId ?? assignment?.scholarGroupId;
    const group = await get(groupId);
    const teacher = await get(assignment?.teacherId);
    const parts = [
      group?.name ?? null,
      teacher?.name ? `with ${teacher.name}` : null,
    ].filter((part): part is string => !!part);
    const label = parts.length > 0 ? parts.join(SEPARATOR) : "assigned";
    classLabels.set(key, label);
    return label;
  }

  async function originLabel(
    session: Doc<"sessions">,
    unit: Doc<"units"> | null,
  ): Promise<string | null> {
    if (session.assignmentId) {
      return await assignmentLabel(session.assignmentId, session.activityId);
    }
    const seed = await get(session.seedId);
    const origin = resolveObserverOrigin({
      unitSlug: unit?.slug ?? null,
      assignmentId: session.assignmentId,
      seedId: session.seedId,
      activityId: session.activityId,
      unitId: session.unitId,
      unitForOrigin: unit ? { authorScholarId: unit.authorScholarId } : null,
      seedForOrigin: seed ? { origin: seed.origin } : null,
    });
    switch (origin.kind) {
      case "assigned":
        return "assigned";
      case "onboarding":
        return "Welcome quest";
      case "wonder":
        return "I wonder";
      case "seed":
        return "picked from their Sky";
      case "scholarStarted":
        // A scholar-authored unit is their own Quest.
        return unit?.authorScholarId ? "Quest" : "self-started";
    }
  }

  async function forSession(
    session: Doc<"sessions">,
    leading?: string | null,
  ): Promise<string> {
    const activity = await get(session.activityId);
    const lesson = await get(activity?.lessonId ?? session.lessonId);
    const unit = await get(session.unitId ?? lesson?.unitId);
    const title = leading?.trim() || session.title?.trim() || activity?.title || unit?.title || "Chat";
    const context = activity?.title ?? unit?.title ?? null;
    const parts = [
      title,
      context && context !== title ? context : null,
      await originLabel(session, unit),
    ].filter((part): part is string => !!part);
    return parts.join(SEPARATOR);
  }

  const sessionLabels = new Map<string, string | undefined>();
  async function forSessionId(
    sessionId: Id<"sessions">,
    leading?: string | null,
  ): Promise<string | undefined> {
    const key = `${sessionId}::${leading ?? ""}`;
    if (!sessionLabels.has(key)) {
      const session = await get(sessionId);
      sessionLabels.set(key, session ? await forSession(session, leading) : leading ?? undefined);
    }
    return sessionLabels.get(key);
  }

  async function forWebActivity(
    row: Doc<"webActivitySessions">,
  ): Promise<string | undefined> {
    const activity = await get(row.activityId);
    const lesson = await get(activity?.lessonId);
    const app = await get(row.appId);
    if (!unitReadable(await get(lesson?.unitId))) {
      return app?.name;
    }
    const title = activity?.title ?? app?.name;
    const assigned = row.assignmentId
      ? await assignmentLabel(row.assignmentId, row.activityId)
      : null;
    const parts = [title, assigned].filter((part): part is string => !!part);
    return parts.length > 0 ? parts.join(SEPARATOR) : undefined;
  }

  async function forPracticeNode(nodeKey: string): Promise<string> {
    if (!nodeLabels.has(nodeKey)) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", nodeKey))
        .first();
      nodeLabels.set(nodeKey, node?.label ?? nodeKey);
    }
    return nodeLabels.get(nodeKey)!;
  }

  return { forSession, forSessionId, forWebActivity, forPracticeNode };
}
