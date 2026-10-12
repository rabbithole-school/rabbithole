import type { Doc } from "../../_generated/dataModel";
import { DOMAIN_REACHABILITY_STATIC } from "../../knowledgeNodes";
import {
  automaticPlacementGrade,
  domainHasAffectSafeEntry,
} from "./placement";
import {
  practiceScopeAllowsDomain,
  type PracticeScope,
} from "./mathPlan";

/** Structural map-completion predicate: static registry metadata plus the
 * scholar's grade and placement rows, with no graph-table reads. */
export function allEligibleDomainsMapped(
  gradeLevel: string | undefined,
  practiceScope: PracticeScope,
  placements: readonly Doc<"practicePlacements">[],
): boolean {
  const placementByDomain = new Map(
    placements.map((row) => [row.domain, row]),
  );
  const ringGrade = automaticPlacementGrade(gradeLevel);
  let eligible = 0;
  for (const domain of DOMAIN_REACHABILITY_STATIC) {
    if (!practiceScopeAllowsDomain(practiceScope, domain.domain)) continue;
    const placement = placementByDomain.get(domain.domain);
    const opened =
      placement?.status === "complete" ||
      (placement?.probeLog?.length ?? 0) > 0;
    if (
      !opened &&
      (domain.elective ||
        !domainHasAffectSafeEntry(domain.nodeGrades, ringGrade))
    ) {
      continue;
    }
    eligible += 1;
    if (placement?.status !== "complete") return false;
  }
  return eligible > 0;
}
