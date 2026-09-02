/**
 * homeTabPager — pure page-order logic for the scholar Home's tab pager
 * (native/src/app/index.tsx drives a react-native-pager-view off these).
 *
 * Extracted because this repo has no component render harness (edge-runtime
 * vitest, no jsdom), so the pager JSX itself can't be render-tested — but the
 * index<->key arithmetic that keeps the swiped page and the active tab in sync
 * IS pure, and is where the subtle bugs live. It has its own truth table in
 * __tests__/homeTabPager.test.ts.
 *
 * The pager pages are the FULL ordered tab list, NOT the visit-order
 * `renderableTabs` set: a pager needs every index between 0 and the target to
 * exist for setPage to reach it, and it must page in tab order. "now" is
 * always present (mirroring how `validTabKeys` is built in index.tsx) so an
 * empty/loading tab list still yields one valid page to sit on.
 */
import type { ScholarHomeTab } from "../../vendor/shared/scholarHomeNow";

/**
 * The ordered page-key list: the tab keys in tab order, with "now" guaranteed
 * present and duplicates removed, so page index and tab order agree.
 */
export function homeTabPageKeys(tabs: ScholarHomeTab[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of ["now", ...tabs.map((tab) => tab.key)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * The page index of a tab key, or 0 (the always-present "now" page) when the
 * key is absent — the same fall-back-to-"now" the content layer uses when the
 * active tab disappears mid-day.
 */
export function homeTabIndexForKey(pageKeys: string[], key: string): number {
  const index = pageKeys.indexOf(key);
  return index < 0 ? 0 : index;
}

/**
 * The tab key at a page index, clamped into range. Guards `onPageSelected`
 * against an index that briefly outruns a shrinking page list (a subject tab
 * vanishing mid-day) rather than returning `undefined`.
 */
export function homeTabKeyForIndex(pageKeys: string[], index: number): string {
  if (pageKeys.length === 0) return "now";
  const clamped = Math.min(Math.max(index, 0), pageKeys.length - 1);
  return pageKeys[clamped];
}
