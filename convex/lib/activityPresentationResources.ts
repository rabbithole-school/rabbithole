import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { validateDeck, type Deck } from "../../shared/slidesScene";

export type PresentationPrincipal =
  | { kind: "personal_oauth"; userId: Id<"users"> }
  | {
      kind: "workspace_bot";
      institutionId: Id<"institutions">;
      credentialId: Id<"institutionGoogleAccounts">;
    }
  | { kind: "legacy_unknown" };

type RefreshablePresentationPrincipal = Exclude<
  PresentationPrincipal,
  { kind: "legacy_unknown" }
>;

export function presentationPrincipalForActingUser(
  principal: PresentationPrincipal,
  actingUserId: Id<"users">,
): RefreshablePresentationPrincipal {
  if (principal.kind === "legacy_unknown") {
    throw new Error(
      "This deck's Google credential is unknown. Reattach it from Drive before using Google Slides.",
    );
  }
  if (
    principal.kind === "personal_oauth" &&
    principal.userId !== actingUserId
  ) {
    throw new Error(
      "This deck is attached through another teacher's Google account. Its owner must edit it, or reattach the deck from your Drive.",
    );
  }
  return principal;
}

type PresentationRow = Doc<"activityResources"> & {
  source:
    | { kind: "rabbit_slides"; deck: string }
    | {
        kind: "google_slides";
        presentationId: string;
        url: string;
        name?: string;
        thumbnailUrl?: string;
        principal: PresentationPrincipal;
      };
};

type PresentationState = {
  rabbit: Extract<PresentationRow["source"], { kind: "rabbit_slides" }> | null;
  google: Extract<PresentationRow["source"], { kind: "google_slides" }> | null;
};

export type MaterialActivityResource = Doc<"activityResources"> & {
  source:
    | {
        kind: "file";
        fileStorageId: Id<"_storage">;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
      }
    | { kind: "link"; url: string }
    | { kind: "video"; url: string };
};

export function isMaterialActivityResource(
  row: Doc<"activityResources">,
): row is MaterialActivityResource {
  return (
    row.source.kind === "file" ||
    row.source.kind === "link" ||
    row.source.kind === "video"
  );
}

function isPresentationRow(row: Doc<"activityResources">): row is PresentationRow {
  return (
    row.source.kind === "rabbit_slides" ||
    row.source.kind === "google_slides"
  );
}

function ordered<T extends { _creationTime: number; _id: unknown }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) =>
    a._creationTime === b._creationTime
      ? String(a._id).localeCompare(String(b._id))
      : a._creationTime - b._creationTime,
  );
}

export function validatedDeckJson(raw: string): string | null {
  try {
    const result = validateDeck(JSON.parse(raw));
    return result.ok ? JSON.stringify(result.deck) : null;
  } catch {
    return null;
  }
}

export function parsedPresentationDeck(raw: string | undefined): Deck | null {
  const normalized = raw ? validatedDeckJson(raw) : null;
  return normalized ? JSON.parse(normalized) : null;
}

export function legacyGoogleSlidesSource(
  activity: Doc<"activities">,
): Extract<PresentationRow["source"], { kind: "google_slides" }> | null {
  const presentationId =
    activity.googleSlidesPresentationId ??
    activity.googleSlidesUrl?.match(/\/presentation\/d\/([^/]+)/)?.[1];
  const url =
    activity.googleSlidesUrl ??
    (presentationId
      ? `https://docs.google.com/presentation/d/${presentationId}/edit`
      : undefined);
  if (!presentationId || !url) return null;
  return {
    kind: "google_slides",
    presentationId,
    url,
    name: activity.googleSlidesName,
    thumbnailUrl: activity.googleSlidesThumbnailUrl,
    principal: activity.googleSlidesOwnerId
      ? {
          kind: "personal_oauth",
          userId: activity.googleSlidesOwnerId,
        }
      : { kind: "legacy_unknown" },
  };
}

export async function presentationRows(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  activityId: Id<"activities">,
): Promise<PresentationRow[]> {
  const rows = await ctx.db
    .query("activityResources")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  return ordered(rows.filter(isPresentationRow));
}

/**
 * Canonical presentation state. Rabbit is deliberately active when both kinds
 * are retained: Google remains a teacher reference rather than being discarded.
 */
export async function presentationState(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  activity: Doc<"activities">,
): Promise<PresentationState> {
  const rows = await presentationRows(ctx, activity._id);
  const rabbit = rows.find(
    (row): row is PresentationRow & { source: { kind: "rabbit_slides"; deck: string } } =>
      row.source.kind === "rabbit_slides",
  )?.source;
  const google = rows.find(
    (
      row,
    ): row is PresentationRow & {
      source: Extract<PresentationRow["source"], { kind: "google_slides" }>;
    } => row.source.kind === "google_slides",
  )?.source;

  // During the migration window, fall back only for the missing kind.
  const legacyRabbit = activity.slidesDeck
    ? { kind: "rabbit_slides" as const, deck: activity.slidesDeck }
    : null;
  const legacyGoogle = legacyGoogleSlidesSource(activity);
  const resolvedRabbit = rabbit ?? legacyRabbit;
  const resolvedGoogle = google ?? legacyGoogle;
  return {
    rabbit: resolvedRabbit,
    google: resolvedGoogle,
  };
}

async function nextOrder(ctx: MutationCtx, activityId: Id<"activities">) {
  const rows = await ctx.db
    .query("activityResources")
    .withIndex("by_activity", (q) => q.eq("activityId", activityId))
    .collect();
  return rows.reduce((max, row) => Math.max(max, row.order), -1) + 1;
}

async function verifyWorkspacePrincipal(
  ctx: MutationCtx,
  activityId: Id<"activities">,
  principal: PresentationPrincipal,
) {
  if (principal.kind !== "workspace_bot") return;
  const activity = await ctx.db.get(activityId);
  const lesson = activity?.lessonId ? await ctx.db.get(activity.lessonId) : null;
  const unit = lesson ? await ctx.db.get(lesson.unitId) : null;
  const credential = await ctx.db.get(principal.credentialId);
  if (
    !unit?.institutionId ||
    unit.institutionId !== principal.institutionId ||
    credential?.institutionId !== principal.institutionId ||
    credential?.purpose !== "workspace_bot"
  ) {
    throw new Error(
      "Workspace presentation credential must belong to this activity's institution and be its Workspace bot",
    );
  }
}

async function upsertPresentation(
  ctx: MutationCtx,
  args: {
    activityId: Id<"activities">;
    uploadedBy: Id<"users">;
    title: string;
    source: PresentationRow["source"];
  },
) {
  const existing = (await presentationRows(ctx, args.activityId)).filter(
    (row) => row.source.kind === args.source.kind,
  );
  const [keep, ...duplicates] = existing;
  for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
  if (keep) {
    await ctx.db.patch(keep._id, {
      title: args.title,
      source: args.source,
      uploadedBy: args.uploadedBy,
    });
    return keep._id;
  }
  return await ctx.db.insert("activityResources", {
    activityId: args.activityId,
    title: args.title,
    source: args.source,
    uploadedBy: args.uploadedBy,
    order: await nextOrder(ctx, args.activityId),
  });
}

export async function upsertRabbitSlides(
  ctx: MutationCtx,
  args: { activityId: Id<"activities">; uploadedBy: Id<"users">; deck: string; title?: string },
) {
  const deck = validatedDeckJson(args.deck);
  if (!deck) throw new Error("Presentation deck must be valid Deck JSON");
  return await upsertPresentation(ctx, {
    activityId: args.activityId,
    uploadedBy: args.uploadedBy,
    title: args.title?.trim() || "Rabbit Slides",
    source: { kind: "rabbit_slides", deck },
  });
}

export async function upsertGoogleSlides(
  ctx: MutationCtx,
  args: {
    activityId: Id<"activities">;
    uploadedBy: Id<"users">;
    presentationId: string;
    url: string;
    name?: string;
    thumbnailUrl?: string;
    principal: PresentationPrincipal;
  },
) {
  await verifyWorkspacePrincipal(ctx, args.activityId, args.principal);
  return await upsertPresentation(ctx, {
    activityId: args.activityId,
    uploadedBy: args.uploadedBy,
    title: args.name?.trim() || "Google Slides",
    source: {
      kind: "google_slides",
      presentationId: args.presentationId,
      url: args.url,
      name: args.name,
      thumbnailUrl: args.thumbnailUrl,
      principal: args.principal,
    },
  });
}

export async function removePresentation(
  ctx: MutationCtx,
  activityId: Id<"activities">,
  kind: "rabbit_slides" | "google_slides",
) {
  for (const row of await presentationRows(ctx, activityId)) {
    if (row.source.kind === kind) await ctx.db.delete(row._id);
  }
}
