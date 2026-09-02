import type { MasteryState } from "../../../vendor/shared/treeMapLayout";

export function canPracticeNode(
  mastery: MasteryState,
  domainNeedsPlacement: boolean | undefined,
  practiceServeable: boolean | undefined,
): boolean {
  return mastery !== "locked" && domainNeedsPlacement === false && practiceServeable === true;
}
