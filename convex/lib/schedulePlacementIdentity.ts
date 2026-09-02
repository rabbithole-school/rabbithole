import type { Doc } from "../_generated/dataModel";

export function normalizedSchedulePlacementText(
  value: string | undefined,
): string | null {
  return value?.trim() || null;
}

/** Display casing is preserved, but subject identity is case- and whitespace-insensitive. */
export function normalizedSchedulePlacementSubject(value: string): string {
  return value.trim().toLowerCase();
}

function identityFields(row: Doc<"schedulePlacements">) {
  return {
    ...coreClassIdentityFields(row),
    sequenceId: row.sequenceId ?? null,
    sequenceIndex: row.sequenceIndex ?? null,
    orderOverride: row.orderOverride ?? false,
    dismissedFlags: [...(row.dismissedFlags ?? [])].sort(),
    createdFromStrategy: row.createdFromStrategy ?? null,
  };
}

function coreClassIdentityFields(row: Doc<"schedulePlacements">) {
  return {
    periodId: String(row.periodId),
    groupId: String(row.groupId),
    weekday: row.weekday,
    blockId: row.blockId == null ? null : String(row.blockId),
    subject: normalizedSchedulePlacementSubject(row.subject),
    teacherId: row.teacherId == null ? null : String(row.teacherId),
    mode: row.mode ?? "classFocus",
    spanBlocks: row.spanBlocks ?? null,
    note: normalizedSchedulePlacementText(row.note),
  };
}

/**
 * Canonical semantic identity for a persisted placement. This deliberately
 * normalizes authored text and default-valued metadata before comparing rows.
 */
export function exactSchedulePlacementKey(
  row: Doc<"schedulePlacements">,
): string {
  return JSON.stringify({
    ...identityFields(row),
    weekStartMs: row.weekStartMs ?? null,
    assignmentId: row.assignmentId == null ? null : String(row.assignmentId),
    activityId: row.activityId == null ? null : String(row.activityId),
    externalAppId: row.externalAppId == null ? null : String(row.externalAppId),
  });
}

/**
 * Identity used only by the conservative production cleanup. Only a placed,
 * unlinked row can be a bare recurring shadow.
 */
export function bareRecurringShadowKey(
  placement: Doc<"schedulePlacements">,
): string | null {
  if (
    placement.weekday == null ||
    placement.blockId == null ||
    placement.assignmentId != null ||
    placement.activityId != null ||
    placement.externalAppId != null
  ) {
    return null;
  }
  return JSON.stringify(identityFields(placement));
}

/**
 * Class identity for the effective-week read layer. Concrete metadata describes
 * how that week's placement was generated, not a distinct scheduled class, so
 * it intentionally does not participate in replacing a recurring bare shell.
 */
export function barePlacementWeekOverrideKey(
  placement: Doc<"schedulePlacements">,
): string | null {
  if (
    placement.weekday == null ||
    placement.blockId == null ||
    placement.assignmentId != null ||
    placement.activityId != null ||
    placement.externalAppId != null
  ) {
    return null;
  }
  return JSON.stringify(coreClassIdentityFields(placement));
}
