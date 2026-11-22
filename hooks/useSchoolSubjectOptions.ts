"use client";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";

const HOUR_MS = 3_600_000;

/**
 * The class names a unit's subject is picked from (TRA-723,
 * `convex/units.ts subjectOptions`): the classes on the UNIT's school's
 * timetable this term, whoever is viewing. `undefined` while loading (show
 * the picker disabled, never the free-text field); an empty list means that
 * school has no classes yet, and the designer keeps its free-text subject.
 * The hour-rounded clock re-picks the term when one ends, without re-running
 * the query every minute.
 */
export function useSchoolSubjectOptions(unitId: Id<"units">): string[] | undefined {
  const at = Math.floor(useNow(60_000) / HOUR_MS) * HOUR_MS;
  return useSmoothedQuery(api.units.subjectOptions, { unitId, at }, { resetKey: unitId });
}
