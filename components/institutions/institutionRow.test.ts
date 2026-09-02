import { describe, expect, test } from "vitest";
import {
  institutionActions,
  institutionStatus,
  scholarCountLabel,
} from "./institutionRow";

describe("institutionActions", () => {
  test("the primary institution offers NO lifecycle actions (never pausable or deletable)", () => {
    expect(institutionActions({ isPrimary: true, disabled: false })).toEqual({
      canPause: false,
      canResume: false,
      canDelete: false,
    });
    // Even a (hypothetical) disabled primary stays fully locked down — the UI
    // must never expose a control the server would refuse.
    expect(institutionActions({ isPrimary: true, disabled: true })).toEqual({
      canPause: false,
      canResume: false,
      canDelete: false,
    });
  });

  test("an active non-primary can pause + delete, not resume", () => {
    expect(institutionActions({ isPrimary: false, disabled: false })).toEqual({
      canPause: true,
      canResume: false,
      canDelete: true,
    });
  });

  test("a paused non-primary can resume + delete, not pause", () => {
    expect(institutionActions({ isPrimary: false, disabled: true })).toEqual({
      canPause: false,
      canResume: true,
      canDelete: true,
    });
  });
});

describe("institutionStatus", () => {
  test("active", () => {
    expect(institutionStatus({ disabled: false })).toEqual({
      label: "Active",
      palette: "green",
    });
  });

  test("paused keeps the existing suspension vocabulary", () => {
    expect(institutionStatus({ disabled: true })).toEqual({
      label: "Paused",
      palette: "orange",
    });
  });
});

describe("scholarCountLabel", () => {
  test("singular", () => expect(scholarCountLabel(1)).toBe("1 scholar"));
  test("zero pluralizes", () => expect(scholarCountLabel(0)).toBe("0 scholars"));
  test("many", () => expect(scholarCountLabel(12)).toBe("12 scholars"));
  test("thousands are deterministically grouped with en-US formatting", () =>
    expect(scholarCountLabel(1234)).toBe("1,234 scholars"));
});
