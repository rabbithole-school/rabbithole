/**
 * The two pure decisions behind the scholar's take-home lane, kept out of the
 * components so they have a truth table instead of a screenshot:
 *
 * 1. WHO renders tonight's homework on Home (the duplicate-render guard), and
 * 2. WHAT the take-home header says about how much is left.
 *
 * See components/TakeHomePlanCard.tsx and app/scholar/page.tsx.
 */

/**
 * True when the take-home card owns the current plan's homework on the
 * Home Now tab — and therefore when the Now digest must stand down.
 *
 * Inside the Prep window the card lives on the Prep tab, so Now keeps its own
 * homework groups; during school hours the digest's deadline policy
 * (`shouldShowHomeworkInNow`) already hides homework and the card stays away
 * rather than reintroducing it early. That leaves exactly one window — after
 * Prep — where the card renders on Home and the digest yields.
 */
export function takeHomePlanOwnsNow({
  isRemoteMode,
  showHomeworkInNow,
  isPrepTime,
}: {
  isRemoteMode: boolean;
  showHomeworkInNow: boolean;
  isPrepTime: boolean;
}): boolean {
  return !isRemoteMode && showHomeworkInNow && !isPrepTime;
}

/**
 * The header's count reads as what is LEFT, never as a standing debt: assigned
 * homework plus the chosen items still unchecked. An empty list says nothing at
 * all (the empty state carries the message), and a finished list says "All
 * done" rather than "0 left".
 */
export function remainingLabel({
  assignedCount,
  selected,
}: {
  assignedCount: number;
  selected: readonly { checked: boolean }[];
}): string | null {
  const total = assignedCount + selected.length;
  if (total === 0) return null;
  const remaining =
    assignedCount + selected.filter((item) => !item.checked).length;
  return remaining === 0 ? "All done" : `${remaining} left`;
}
