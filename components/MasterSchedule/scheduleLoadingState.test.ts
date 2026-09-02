import { describe, expect, test } from "vitest";
import { computeScheduleLoadingState } from "./scheduleLoadingState";

describe("computeScheduleLoadingState", () => {
  test("still fetching the term queries → loading, not noTermConfigured", () => {
    const state = computeScheduleLoadingState({
      terms: undefined,
      currentTerm: undefined,
      termId: null,
      grid: undefined,
    });
    expect(state).toEqual({ loading: true, noTermConfigured: false });
  });

  test("terms resolved but currentTerm still in flight → still loading", () => {
    // Both term queries must resolve before we can tell "no term" apart from
    // "still fetching" — a lone resolved query isn't enough.
    const state = computeScheduleLoadingState({
      terms: [],
      currentTerm: undefined,
      termId: null,
      grid: undefined,
    });
    expect(state.loading).toBe(true);
    expect(state.noTermConfigured).toBe(false);
  });

  test("both term queries resolved to nothing → noTermConfigured, not loading (the bug)", () => {
    // The day-one case: zero reportingPeriods rows in the whole institution
    // (true of a fresh install — neither the base nor rich dev seed creates
    // any). `terms` resolves to `[]`, `currentTerm` resolves to `null`, and
    // termId can never leave null — the grid query never even runs. Before
    // the fix this rendered "Loading schedule…" forever.
    const state = computeScheduleLoadingState({
      terms: [],
      currentTerm: null,
      termId: null,
      grid: undefined,
    });
    expect(state).toEqual({ loading: false, noTermConfigured: true });
  });

  test("a term is resolved but its grid is still in flight → loading", () => {
    const state = computeScheduleLoadingState({
      terms: [{ _id: "period1" }],
      currentTerm: null,
      termId: "period1",
      grid: undefined,
    });
    expect(state).toEqual({ loading: true, noTermConfigured: false });
  });

  test("term + grid both resolved → neither loading nor noTermConfigured", () => {
    const state = computeScheduleLoadingState({
      terms: [{ _id: "period1" }],
      currentTerm: { _id: "period1" },
      termId: "period1",
      grid: { blocks: [], placements: [], groups: [], teachers: [], shelf: [], flags: [] },
    });
    expect(state).toEqual({ loading: false, noTermConfigured: false });
  });
});
