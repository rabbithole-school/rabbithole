import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { isTeacherRole } from "./lib/roles";

export type FlairCriterion = {
  id?: string;
  label: string;
  description?: string;
};

const FLAIR_ART_VERSION = "bold-v1";
const MAX_CRITERIA_PER_WRITE = 24;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const MAX_GENERATION_ATTEMPTS = 3;

function normalizeText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function flairArtKey(criterion: FlairCriterion): string {
  const source = `${normalizeText(criterion.label)}\u0000${normalizeText(
    criterion.description,
  )}`;
  return `${FLAIR_ART_VERSION}:${hash32(source, 0x811c9dc5)}${hash32(
    source,
    0x9e3779b9,
  )}`;
}

function flairInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}

function sanitizeCriteria(
  criteria: readonly FlairCriterion[],
): FlairCriterion[] {
  if (criteria.length > MAX_CRITERIA_PER_WRITE) {
    console.warn(
      `[flairArt] preparing the first ${MAX_CRITERIA_PER_WRITE} of ${criteria.length} criteria`,
    );
  }
  const unique = new Map<string, FlairCriterion>();
  for (const criterion of criteria.slice(0, MAX_CRITERIA_PER_WRITE)) {
    const label = criterion.label.trim().replace(/\s+/g, " ");
    if (!label || label.length > 160) continue;
    const rawDescription = criterion.description?.trim().replace(/\s+/g, " ");
    const description = rawDescription?.slice(0, 600) || undefined;
    const sanitized = { ...criterion, label, description };
    unique.set(flairArtKey(sanitized), sanitized);
  }
  return [...unique.values()];
}

type FlairMutationCtx = Pick<MutationCtx, "db" | "scheduler">;
type FlairReadCtx = Pick<QueryCtx | MutationCtx, "db">;
type FlairDisplayCtx = Pick<QueryCtx, "db" | "storage">;
type FlairGenerationOptions = { scheduleGeneration?: boolean };

type FlairDisplayItem = {
  criterionId: string;
  label: string;
  /** The scholar-facing note snapshotted when this flair was earned. Never the
   *  criterion's `description` — that is grader-facing rubric text. */
  note?: string;
  initial: string;
  earnedAt: number;
  artId: Id<"flairArt"> | null;
  imageUrl: string | null;
};

async function primaryInstitutionId(
  ctx: FlairReadCtx,
): Promise<Id<"institutions"> | undefined> {
  const rows = await ctx.db.query("institutions").collect();
  return rows.find((row) => row.isPrimary)?._id;
}

async function activityInstitutionId(
  ctx: FlairReadCtx,
  activity: Doc<"activities">,
): Promise<Id<"institutions"> | undefined> {
  const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
  const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
  if (unit?.institutionId) return unit.institutionId;
  const author = unit ? await ctx.db.get(unit.teacherId) : null;
  return author?.institutionId ?? (await primaryInstitutionId(ctx));
}

async function ensureCriteria(
  ctx: FlairMutationCtx,
  institutionId: Id<"institutions"> | undefined,
  criteria: readonly FlairCriterion[],
  createdBy?: Id<"users">,
  { scheduleGeneration = true }: FlairGenerationOptions = {},
): Promise<{ created: number; existing: number; retried: number }> {
  if (!institutionId) return { created: 0, existing: 0, retried: 0 };
  const now = Date.now();
  let created = 0;
  let existing = 0;
  let retried = 0;

  for (const criterion of sanitizeCriteria(criteria)) {
    const artKey = flairArtKey(criterion);
    const cached = await ctx.db
      .query("flairArt")
      .withIndex("by_institution_key", (q) =>
        q.eq("institutionId", institutionId).eq("artKey", artKey),
      )
      .unique();
    if (cached) {
      const canRetry =
        cached.status === "failed" &&
        cached.attemptCount < MAX_GENERATION_ATTEMPTS &&
        now - (cached.failedAt ?? cached.lastAttemptAt) >= RETRY_DELAY_MS;
      if (canRetry) {
        await ctx.db.patch(cached._id, {
          status: "pending",
          attemptCount: cached.attemptCount + 1,
          lastAttemptAt: now,
          failedAt: undefined,
        });
        if (scheduleGeneration) {
          await ctx.scheduler.runAfter(
            0,
            internal.flairArtActions.generateFlairArt,
            { id: cached._id },
          );
        }
        retried += 1;
      } else {
        existing += 1;
      }
      continue;
    }

    const id = await ctx.db.insert("flairArt", {
      institutionId,
      artKey,
      sourceLabel: criterion.label,
      sourceDescription: criterion.description,
      status: "pending",
      attemptCount: 1,
      lastAttemptAt: now,
      createdAt: now,
      createdBy,
    });
    if (scheduleGeneration) {
      await ctx.scheduler.runAfter(0, internal.flairArtActions.generateFlairArt, {
        id,
      });
    }
    created += 1;
  }

  return { created, existing, retried };
}

export async function ensureFlairArtForActivity(
  ctx: MutationCtx,
  activityId: Id<"activities">,
  criteria: readonly FlairCriterion[],
  createdBy?: Id<"users">,
  options?: FlairGenerationOptions,
) {
  if (criteria.length === 0) return { created: 0, existing: 0, retried: 0 };
  const activity = await ctx.db.get(activityId);
  if (!activity) throw new Error("Activity not found");
  return await ensureCriteria(
    ctx,
    await activityInstitutionId(ctx, activity),
    criteria,
    createdBy,
    options,
  );
}

export async function ensureFlairArtForSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  criteria: readonly FlairCriterion[],
  options?: FlairGenerationOptions,
) {
  if (criteria.length === 0) return { created: 0, existing: 0, retried: 0 };
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error("Session not found");
  const scholar = await ctx.db.get(session.userId);
  const activity = session.activityId
    ? await ctx.db.get(session.activityId)
    : null;
  const institutionId =
    scholar?.institutionId ??
    (activity ? await activityInstitutionId(ctx, activity) : undefined);
  return await ensureCriteria(ctx, institutionId, criteria, undefined, options);
}

async function resolveFlairDisplayItems(
  ctx: FlairDisplayCtx,
  earned: readonly {
    criterionId: string;
    earnedAt: number;
    note?: string;
  }[],
  criteria: readonly FlairCriterion[],
  institutionId: Id<"institutions"> | undefined,
): Promise<FlairDisplayItem[]> {
  const criteriaById = new Map(
    criteria.flatMap((criterion) =>
      criterion.id ? [[criterion.id, criterion] as const] : [],
    ),
  );

  return await Promise.all(
    earned.flatMap((flair) => {
      const criterion = criteriaById.get(flair.criterionId);
      if (!criterion) return [];
      return [
        (async () => {
          const art = institutionId
            ? await ctx.db
                .query("flairArt")
                .withIndex("by_institution_key", (q) =>
                  q
                    .eq("institutionId", institutionId)
                    .eq("artKey", flairArtKey(criterion)),
                )
                .unique()
            : null;
          return {
            criterionId: flair.criterionId,
            label: criterion.label,
            ...(flair.note ? { note: flair.note } : {}),
            initial: flairInitial(criterion.label),
            earnedAt: flair.earnedAt,
            artId: art?._id ?? null,
            imageUrl:
              art?.status === "ready" && art.imageStorageId
                ? await ctx.storage.getUrl(art.imageStorageId)
                : null,
          };
        })(),
      ];
    }),
  );
}

/**
 * Generated-art enrichment for one deliverable. The deliverable id is the
 * scope boundary: two artifacts in one session can earn different Flair and
 * must never borrow each other's marks.
 */
export const forDeliverable = authedQuery({
  args: { deliverableId: v.id("deliverables") },
  handler: async (ctx, { deliverableId }) => {
    const deliverable = await ctx.db.get(deliverableId);
    if (!deliverable) return [];
    const session = await ctx.db.get(deliverable.sessionId);
    if (
      !session ||
      deliverable.scholarId !== session.userId
    ) {
      return [];
    }
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return [];
    const accessScholarId = session.isTestDrive
      ? session.testDriveAsScholarId
      : session.userId;
    if (accessScholarId && accessScholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, accessScholarId);
    }

    const activity = await ctx.db.get(deliverable.activityId);
    if (!activity) return [];
    const usesSessionCriteria =
      session.activityId === deliverable.activityId &&
      session.deliverableCriteria !== undefined;
    const criteria = usesSessionCriteria
      ? session.deliverableCriteria ?? []
      : activity.deliverable?.criteria ?? [];
    const scholar = await ctx.db.get(session.userId);
    const activityInstitution = await activityInstitutionId(ctx, activity);
    const institutionId = usesSessionCriteria
      ? scholar?.institutionId ?? activityInstitution
      : activityInstitution;

    return await resolveFlairDisplayItems(
      ctx,
      deliverable.flairEarned ?? [],
      criteria,
      institutionId,
    );
  },
});

export const forSession = authedQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    const isTeacher = isTeacherRole(ctx.user.role);
    if (!isTeacher && session.userId !== ctx.user._id) return [];
    const accessScholarId = session.isTestDrive
      ? session.testDriveAsScholarId
      : session.userId;
    if (accessScholarId && accessScholarId !== ctx.user._id) {
      await requireActiveScholarAccess(ctx, ctx.user, accessScholarId);
    }

    const activity = session.activityId
      ? await ctx.db.get(session.activityId)
      : null;
    if (!activity) return [];
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    const earnedByCriterion = new Map<
      string,
      { earnedAt: number; note?: string }
    >();
    for (const deliverable of deliverables) {
      if (deliverable.activityId !== activity._id) continue;
      for (const flair of deliverable.flairEarned ?? []) {
        const prior = earnedByCriterion.get(flair.criterionId);
        if (prior === undefined || flair.earnedAt < prior.earnedAt) {
          earnedByCriterion.set(flair.criterionId, {
            earnedAt: flair.earnedAt,
            ...(flair.note ? { note: flair.note } : {}),
          });
        }
      }
    }
    if (earnedByCriterion.size === 0) return [];
    const earned = [...earnedByCriterion].map(([criterionId, entry]) => ({
      criterionId,
      ...entry,
    }));

    const usesSessionCriteria = session.deliverableCriteria !== undefined;
    const criteria =
      session.deliverableCriteria ?? activity.deliverable?.criteria ?? [];
    const scholar = await ctx.db.get(session.userId);
    const activityInstitution = await activityInstitutionId(ctx, activity);
    const institutionId = usesSessionCriteria
      ? scholar?.institutionId ?? activityInstitution
      : activityInstitution;

    return await resolveFlairDisplayItems(ctx, earned, criteria, institutionId);
  },
});
