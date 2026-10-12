import { describe, expect, test } from "vitest";
import { plannedReleaseArgs } from "./plannedRelease";

const NOW = 1_700_000_000_000;

describe("plannedReleaseArgs", () => {
  test("homework keeps the due date the teacher already chose", () => {
    const dueAt = NOW + 3 * 24 * 60 * 60_000;
    expect(
      plannedReleaseArgs(
        { mode: "homework", endsAt: null, dueAt, scholarIds: null },
        NOW,
      ),
    ).toEqual({ mode: "homework", endsAt: undefined, dueAt, scholarIds: undefined });
  });

  test("per-scholar targeting survives the release", () => {
    const args = plannedReleaseArgs(
      { mode: "homework", endsAt: null, dueAt: NOW, scholarIds: ["a", "b"] },
      NOW,
    );
    expect(args.scholarIds).toEqual(["a", "b"]);
  });

  test("an empty target list is treated as untargeted, never as nobody", () => {
    const args = plannedReleaseArgs(
      { mode: "classFocus", endsAt: null, dueAt: null, scholarIds: [] },
      NOW,
    );
    expect(args.scholarIds).toBeUndefined();
  });

  test("a class-focus end that already elapsed is dropped without inventing one", () => {
    const args = plannedReleaseArgs(
      { mode: "classFocus", endsAt: NOW - 60_000, dueAt: null, scholarIds: null },
      NOW,
    );
    expect(args.endsAt).toBeUndefined();
  });

  test("a class-focus window still ahead is honored", () => {
    const endsAt = NOW + 20 * 60_000;
    const args = plannedReleaseArgs(
      { mode: "classFocus", endsAt, dueAt: null, scholarIds: null },
      NOW,
    );
    expect(args.endsAt).toBe(endsAt);
  });

  test("a due date never leaks onto class focus, nor a window onto homework", () => {
    expect(
      plannedReleaseArgs(
        { mode: "classFocus", endsAt: null, dueAt: NOW, scholarIds: null },
        NOW,
      ).dueAt,
    ).toBeUndefined();
    expect(
      plannedReleaseArgs(
        { mode: "homework", endsAt: NOW + 60_000, dueAt: NOW, scholarIds: null },
        NOW,
      ).endsAt,
    ).toBeUndefined();
  });
});
