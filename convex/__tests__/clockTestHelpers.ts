import { vi } from "vitest";

/**
 * Run `fn` with `Date.now()` set to `ms`, then restore the real clock. Rows
 * `fn` inserts through convex-test carry that `_creationTime`: convex-test
 * stamps it from `Date`, so faking `Date` moves it (checked 2026-11-21 with a
 * probe insert under `vi.useFakeTimers({ toFake: ["Date"] })`). convex-test
 * also keeps `_creationTime` increasing within one test instance (an insert
 * never gets a time before the last one), so call this BEFORE anything is
 * inserted at the real time: put every insert that must predate the test's
 * "now" inside it.
 *
 * Used to create a scholar BEFORE a term that the test then opens weeks in
 * the past: the pace window starts at the later of the term's start and the
 * scholar's account creation (`paceWindowStart`), so a scholar created "now"
 * would read as a same-day joiner.
 */
export async function atClock<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ now: ms, toFake: ["Date"] });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
