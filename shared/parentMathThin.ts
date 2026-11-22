/**
 * The thin-data rule for the parent Math page: a parent of a young child never
 * reads a grade level that rests on a handful of skills. Parent page only; the
 * server keeps returning the real levels, and the teacher view and the reports
 * print them as they are.
 */

/** An area with fewer credited skills (daily work plus placement check-in)
 *  than this is THIN: its level is not printed. Anchor: in production on
 *  2026-11-21, per-area credited counts across 14 scholars split into a
 *  cluster of 21 areas at 1–7 skills and the rest at 9 or more. */
export const MIN_SKILLS_FOR_AREA_LEVEL = 8;

/** The overall level is printed only when at least this many areas are not
 *  thin: a level across areas means little when one area carries it. */
export const MIN_SOLID_AREAS_FOR_OVERALL = 2;

export interface AreaCredit {
  fluentSkills: number;
  placementSkills: number;
}

const credited = (a: AreaCredit) => a.fluentSkills + a.placementSkills;

/** True when an area has any credited skill at all, so it is listed. */
export function isListedArea(area: AreaCredit): boolean {
  return credited(area) > 0;
}

/** True when an area's level rests on too few skills to print. */
export function isThinArea(area: AreaCredit): boolean {
  return credited(area) < MIN_SKILLS_FOR_AREA_LEVEL;
}

/** True when enough areas are not thin for the overall level to be printed. */
export function showOverallLevel(areas: readonly AreaCredit[]): boolean {
  return areas.filter((a) => !isThinArea(a)).length >= MIN_SOLID_AREAS_FOR_OVERALL;
}

/**
 * A level as the parent page prints it. Below grade 1 it is kindergarten:
 * "Kindergarten" in the tile, "K" in the table. Otherwise "Grade 4.6" in the
 * tile and "4.6" in the table.
 */
export function parentLevelText(value: number, place: "tile" | "table"): string {
  if (value < 1) return place === "tile" ? "Kindergarten" : "K";
  return place === "tile" ? `Grade ${value.toFixed(1)}` : value.toFixed(1);
}
