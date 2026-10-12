/**
 * The pure placement decision behind the scholar's evening Home, kept out of
 * the page so it has a truth table instead of a screenshot.
 *
 * See app/scholar/page.tsx (and native/src/app/index.tsx).
 */

/**
 * True for the after-Prep evening on the Home Now tab: the Now tab shows the
 * homework digest AND we are past the Prep window. That window is where the
 * dated "Coming up" forecast joins the Now tab (inside Prep it lives on the
 * Prep tab; during school hours `shouldShowHomeworkInNow` keeps homework off
 * Now altogether).
 *
 * This used to decide that the retired "To do tonight" plan card owned the
 * homework on Now. That card is gone, so the digest always renders homework
 * itself; only the forecast placement still keys off the evening.
 */
export function afterPrepEvening({
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
