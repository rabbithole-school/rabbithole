// TRA-519 A4: the write side of "an app activity is an online activity with
// app settings". The read side (isAppActivity / effectiveActivityKind) lives in
// shared/appSurface.ts; this file owns how every activity WRITER turns its
// input into the stored shape, so tool layers, the aide, MCP callers and old
// clients may keep passing the legacy kind "vibecode" and still produce
// { kind: "online", appActivity: true }.

import type { Doc } from "../_generated/dataModel";
import { effectiveActivityKind, isAppActivity } from "../../shared/appSurface";
import type { DeliverableSpec } from "./deliverable";

export type StoredActivityKind = Doc<"activities">["kind"];
/** A kind as a NEW write stores it: never the legacy "vibecode" token. */
export type WrittenActivityKind = Exclude<StoredActivityKind, "vibecode">;

type ShapeInput = {
  kind: StoredActivityKind;
  appActivity?: boolean | null;
};

export type ActivityWriteTarget = {
  /** The kind to store (an app activity stores "online"). */
  kind: WrittenActivityKind;
  /** The resulting row is an app activity. */
  isApp: boolean;
  /** The kind behavior keys on after the write (see effectiveActivityKind). */
  effectiveKind: StoredActivityKind;
  /** The write names a shape (kind and/or appActivity) — as opposed to only
   *  editing other fields of the row it finds. */
  shapeSupplied: boolean;
  /** The row was an app activity and the write turns it into something else. */
  leavesApp: boolean;
  /** The write turns a non-app row (or nothing) into an app activity. */
  becomesApp: boolean;
};

/**
 * Resolve the shape a write leaves an activity in.
 *
 * - `kind: "vibecode"` (legacy input, still accepted everywhere) → an app.
 * - `appActivity` supplied → app iff true; only an online activity can be one.
 * - `kind` supplied alone → that kind, not an app ("online" means a plain
 *   online activity, exactly as picking "online" away from "vibecode" did).
 * - neither supplied → the row's current shape (an edit of other fields).
 */
export function resolveActivityWriteTarget(
  current: ShapeInput | null,
  patch: { kind?: StoredActivityKind; appActivity?: boolean | null },
): ActivityWriteTarget {
  const wasApp = isAppActivity(current);
  const shapeSupplied =
    patch.kind !== undefined ||
    (patch.appActivity !== undefined && patch.appActivity !== null);
  let isApp: boolean;
  let kind: WrittenActivityKind;
  if (patch.kind === "vibecode") {
    if (patch.appActivity === false) {
      throw new Error(
        'kind "vibecode" is an app activity; it cannot also set appActivity: false.',
      );
    }
    isApp = true;
    kind = "online";
  } else if (patch.appActivity !== undefined && patch.appActivity !== null) {
    const base: StoredActivityKind =
      patch.kind ?? current?.kind ?? "online";
    const baseKind: WrittenActivityKind = base === "vibecode" ? "online" : base;
    if (patch.appActivity && baseKind !== "online") {
      throw new Error("Only an online activity can be an app activity.");
    }
    isApp = patch.appActivity;
    kind = baseKind;
  } else if (patch.kind !== undefined) {
    isApp = false;
    kind = patch.kind;
  } else if (current) {
    isApp = wasApp;
    kind = current.kind === "vibecode" ? "online" : current.kind;
  } else {
    isApp = false;
    kind = "online";
  }
  return {
    kind,
    isApp,
    effectiveKind: effectiveActivityKind({ kind, appActivity: isApp }),
    shapeSupplied,
    leavesApp: wasApp && !isApp,
    becomesApp: !wasApp && isApp,
  };
}

/** The two shape fields a writer stores for a resolved target. A non-app row
 * stores no flag at all (absent reads as false). */
export function storedShapeFields(target: ActivityWriteTarget): {
  kind: WrittenActivityKind;
  appActivity: true | undefined;
} {
  return { kind: target.kind, appActivity: target.isApp ? true : undefined };
}

/** Fields that mean something only on an app activity and are cleared when a
 * row stops being one. The starter app and teacher brief are kept, so
 * flipping back restores the teacher's setup. */
export const APP_ONLY_CLEARED_FIELDS = {
  tutorModel: undefined,
  buildContract: undefined,
  allowSilence: undefined,
  editAccess: undefined,
} as const;

/** The scholar-visible prompt an app activity's deliverable carries when the
 * teacher wrote none. Never the systemPrompt or the teacher's appRequest —
 * the deliverable prompt is shown to scholars. */
export const DEFAULT_APP_DELIVERABLE_PROMPT = "Build your app and try it out.";

/**
 * The deliverable an app activity carries: the app itself (kind "artifact"),
 * with no rubric (mode "none"). Criteria are NOT derived from the build
 * contract: invariants are the discovery the scholar must name themselves,
 * and a copy would drift when the teacher edits the contract. Teachers can
 * author criteria on the deliverable like any other.
 */
export function defaultAppDeliverable(a: {
  scholarDescription?: string | null;
}): DeliverableSpec {
  return {
    kind: "artifact",
    prompt: a.scholarDescription?.trim() || DEFAULT_APP_DELIVERABLE_PROMPT,
    mode: "none",
    criteria: [],
  };
}

/**
 * The criteria generator's instruction for an app deliverable in auto mode
 * (Quest build steps): one criterion is the MAKER'S EXPLANATION — what the
 * app lets someone figure out, and what the scholar figured out building it,
 * in their own words. It rides the existing private rubric, so it is coached
 * one probe at a time, earns flair when full, and never gates completion.
 * Teacher app activities (mode "none" by default) are untouched: a teacher
 * who wants it authors the criterion like any other.
 */
export const APP_MAKER_EXPLANATION_CRITERION =
  "This deliverable is an app the scholar is building. Make exactly ONE " +
  'criterion the maker\'s explanation (a label like "Explains the app"): ' +
  "full when the scholar has said, in their own words — in chat, or in the " +
  "app itself — what someone using the app should notice or figure out, and " +
  "what they figured out themselves while building it. It is judged from " +
  "what they say, never from the code, and a sentence or two at their talk " +
  "level is plenty. This one criterion is the exception to dimensional over " +
  "procedural: an app is not finished until its maker can say what it is " +
  "for. Keep every other criterion about the app itself.";

/** A deliverable nobody has touched since it was defaulted onto an app
 * activity — safe to drop when the row stops being an app. The prompt must
 * still be a default one (the fixed fallback, or the one derived from the
 * row's scholarDescription): a teacher-written prompt is a customization and
 * survives. `scholarDescription` is required so a caller can't silently
 * compare against the wrong default. */
export function isUntouchedDefaultAppDeliverable(
  d: DeliverableSpec | undefined | null,
  scholarDescription: string | null | undefined,
): boolean {
  if (
    !d ||
    d.kind !== "artifact" ||
    d.mode !== "none" ||
    d.criteria.length !== 0 ||
    d.notes
  ) {
    return false;
  }
  const prompt = d.prompt.trim();
  return (
    prompt === DEFAULT_APP_DELIVERABLE_PROMPT ||
    prompt === defaultAppDeliverable({ scholarDescription }).prompt
  );
}

/** One app activity, one evaluation bar: the app. A conversation advance gate
 * would compete with the app deliverable for the same completion path. */
export function assertAppHasNoAdvanceRubric(
  isApp: boolean,
  advanceRubric: unknown,
): void {
  if (isApp && advanceRubric) {
    throw new Error(
      "An app activity's evaluation bar is the app itself; it can't take an " +
        "advanceRubric. Clear the advanceRubric first, or make it a plain " +
        "online activity.",
    );
  }
}

/**
 * The patch the fold migration applies to a legacy kind:"vibecode" row
 * (pure; convex/migrations.ts foldVibecodeIntoOnline). Every flat app field
 * stays in place. A row with no evaluation bar gains the default app
 * deliverable; a row with an advanceRubric or an existing deliverable is left
 * as it is and surfaces in verifyVibecodeFold for review.
 */
export function foldedAppActivityPatch(
  a: Pick<
    Doc<"activities">,
    "kind" | "deliverable" | "advanceRubric" | "scholarDescription"
  >,
): Partial<Doc<"activities">> {
  if (a.kind !== "vibecode") return {};
  return {
    kind: "online",
    appActivity: true,
    ...(!a.deliverable && !a.advanceRubric
      ? { deliverable: defaultAppDeliverable(a) }
      : {}),
  };
}

/**
 * The inverse of foldedAppActivityPatch, for rolling back TRA-519 PR2 after
 * the prod fold (convex/migrations.ts unfoldAppActivities): an app row goes
 * back to the legacy { kind: "vibecode" } with no appActivity flag. The
 * default deliverable the fold added is dropped only while it is untouched;
 * a deliverable a teacher customized (criteria, notes, their own prompt)
 * stays. Flat app fields are never touched — the fold left them in place.
 */
export function unfoldedAppActivityPatch(
  a: Pick<
    Doc<"activities">,
    "kind" | "appActivity" | "deliverable" | "scholarDescription"
  >,
): Partial<Doc<"activities">> {
  if (a.kind !== "online" || a.appActivity !== true) return {};
  return {
    kind: "vibecode",
    appActivity: undefined,
    ...(isUntouchedDefaultAppDeliverable(a.deliverable, a.scholarDescription)
      ? { deliverable: undefined }
      : {}),
  };
}
