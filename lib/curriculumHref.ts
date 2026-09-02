import type { Id } from "@/convex/_generated/dataModel";

/** The Curriculum column-view panes (a path segment; `summary` is the bare
 *  unit path). Mirrors `UnitTab` in the designer. */
export type CurriculumPane = "summary" | "edit" | "preflight" | "assign" | "debrief";

/**
 * Canonical URL for the Curriculum column-view:
 *   /teacher/curriculum/<unitId>[/<pane>]?lesson=…|activity=…
 *
 * Use this EVERYWHERE a unit / lesson / activity is linked. Never link the
 * `/teacher/unit/<id>` path — it only ever existed as a redirect into this
 * surface, so linking it forces an unnecessary client redirect hop.
 */
export function curriculumUnitHref(
  unitId: Id<"units"> | string,
  opts: {
    lessonId?: Id<"lessons"> | string | null;
    activityId?: Id<"activities"> | string | null;
    pane?: CurriculumPane;
  } = {},
): string {
  const qs = new URLSearchParams();
  // The column-view reads either selection; activity wins when both are given.
  if (opts.activityId) qs.set("activity", String(opts.activityId));
  else if (opts.lessonId) qs.set("lesson", String(opts.lessonId));
  const q = qs.toString();
  const paneSeg = opts.pane && opts.pane !== "summary" ? `/${opts.pane}` : "";
  return `/teacher/curriculum/${encodeURIComponent(String(unitId))}${paneSeg}${q ? `?${q}` : ""}`;
}
