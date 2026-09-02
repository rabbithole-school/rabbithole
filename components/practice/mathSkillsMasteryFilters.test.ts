import { describe, expect, it } from "vitest";
import {
  DEFAULT_MASTERY_FILTERS,
  MASTERY_FILTER_ORDER,
  allMasteryFilters,
  defaultMasteryFilters,
  masteryFilterKey,
  parseMasteryFilters,
  readingMatchesMasteryFilters,
  serializeMasteryFilters,
} from "./mathSkillsMasteryFilters";

describe("math skills mastery filters", () => {
  it("defaults to every mastery band when the URL omits the filter", () => {
    expect([...parseMasteryFilters(null)]).toEqual([...DEFAULT_MASTERY_FILTERS]);
    expect([...DEFAULT_MASTERY_FILTERS]).toEqual([...MASTERY_FILTER_ORDER]);
    expect(serializeMasteryFilters(defaultMasteryFilters())).toBeNull();
    // The full set IS the default, so it serializes to null (no param), not a
    // spelled-out list.
    expect(serializeMasteryFilters(allMasteryFilters())).toBeNull();
  });

  it("no longer carries a teacher-locked band (serving is a separate axis)", () => {
    // Access ("Not yet serving") moved to the serving avatars + All | Served
    // toggle; the mastery filter is pure mastery bands now.
    expect(MASTERY_FILTER_ORDER).not.toContain("teacher-locked");
    expect(parseMasteryFilters("fluent,teacher-locked")).toEqual(
      new Set(["fluent"]),
    );
  });

  it("round-trips a canonical subset and preserves an explicit empty filter", () => {
    const subset = parseMasteryFilters("fluent,frontier,unknown");
    expect([...subset]).toEqual(["fluent", "frontier"]);
    // Serialization follows MASTERY_FILTER_ORDER (canonical strand order), where
    // fluent precedes frontier.
    expect(serializeMasteryFilters(subset)).toBe("fluent,frontier");
    expect(parseMasteryFilters("").size).toBe(0);
    expect(serializeMasteryFilters(new Set())).toBe("");
  });

  it("orders bands by strand progression (placed → rock solid → fluent → practicing → needs review → not started)", () => {
    expect([...MASTERY_FILTER_ORDER]).toEqual([
      "placed",
      "overlearned",
      "fluent",
      "frontier",
      // Teacher/parent-facing only; sits just above `locked`, the one lower state.
      "struggling",
      "locked",
    ]);
  });

  it("buckets a reading by its real mastery regardless of serving state", () => {
    // A not-serving scholar who pre-tested out still reads as their true band.
    const fluent = { mastery: "fluent" as const };
    expect(masteryFilterKey(fluent)).toBe("fluent");
    expect(readingMatchesMasteryFilters(fluent, new Set(["fluent"]))).toBe(true);
    expect(readingMatchesMasteryFilters(fluent, new Set(["placed"]))).toBe(false);
  });

  it("keeps placed and fluent as distinct filter states", () => {
    const placed = { mastery: "placed" as const };
    expect(readingMatchesMasteryFilters(placed, new Set(["placed"]))).toBe(true);
    expect(readingMatchesMasteryFilters(placed, new Set(["fluent"]))).toBe(false);
  });
});
