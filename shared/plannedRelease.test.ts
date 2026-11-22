import { describe, expect, test } from "vitest";
import { plannedReleaseArgs } from "./plannedRelease";

const NOW = 1_700_000_000_000;
const TZ = "Pacific/Honolulu";
const DAY = 24 * 60 * 60_000;

describe("plannedReleaseArgs", () => {
  test("homework keeps the due date the teacher already chose", () => {
    const dueAt = NOW + 3 * 24 * 60 * 60_000;
    expect(
      plannedReleaseArgs(
        { mode: "homework", endsAt: null, dueAt, scholarIds: null },
        NOW,
        TZ,
      ),
    ).toEqual({ mode: "homework", endsAt: undefined, dueAt, scholarIds: undefined });
  });

  test("per-scholar targeting survives the release", () => {
    const args = plannedReleaseArgs(
      { mode: "homework", endsAt: null, dueAt: NOW, scholarIds: ["a", "b"] },
      NOW,
      TZ,
    );
    expect(args.scholarIds).toEqual(["a", "b"]);
  });

  test("an empty target list is treated as untargeted, never as nobody", () => {
    const args = plannedReleaseArgs(
      { mode: "classFocus", endsAt: null, dueAt: null, scholarIds: [] },
      NOW,
      TZ,
    );
    expect(args.scholarIds).toBeUndefined();
  });

  test("a class-focus end that already elapsed is dropped without inventing one", () => {
    const args = plannedReleaseArgs(
      { mode: "classFocus", endsAt: NOW - 60_000, dueAt: null, scholarIds: null },
      NOW,
      TZ,
    );
    expect(args.endsAt).toBeUndefined();
  });

  test("a class-focus window still ahead is re-read at release, not carried over", () => {
    // Planned for tomorrow's block and started today: the old end belongs to
    // tomorrow's class, so the server re-derives it from today's bell.
    const args = plannedReleaseArgs(
      { mode: "classFocus", endsAt: NOW + 26 * 60 * 60_000, dueAt: null, scholarIds: null },
      NOW,
      TZ,
    );
    expect(args).toEqual({ mode: "classFocus", endsAt: undefined, dueAt: undefined, scholarIds: undefined });
  });

  test("a due date never leaks onto class focus, nor a window onto homework", () => {
    expect(
      plannedReleaseArgs(
        { mode: "classFocus", endsAt: null, dueAt: NOW, scholarIds: null },
        NOW,
        TZ,
      ).dueAt,
    ).toBeUndefined();
    expect(
      plannedReleaseArgs(
        { mode: "homework", endsAt: NOW + 60_000, dueAt: NOW, scholarIds: null },
        NOW,
        TZ,
      ).endsAt,
    ).toBeUndefined();
  });

  test("an open-until end still ahead is carried over (TRA-638)", () => {
    // Planned to show up at NOW, open until three days later.
    const endsAt = NOW + 3 * DAY;
    const args = plannedReleaseArgs(
      { mode: "classFocus", startsAt: NOW, endsAt, dueAt: null, scholarIds: null },
      NOW + 60_000,
      TZ,
    );
    expect(args.endsAt).toBe(endsAt);
    expect(args.openUntilKind).toBe(true);
  });

  test("a stored open-until finish released on its closing day keeps the close and says so (TRA-726)", () => {
    // Starts and closes the same day: the date test alone would read in-class.
    const endsAt = NOW + 60 * 60_000;
    const entry = { mode: "classFocus" as const, startsAt: NOW, endsAt, dueAt: null, scholarIds: null };
    expect(plannedReleaseArgs(entry, NOW, TZ)).not.toHaveProperty("openUntilKind");
    expect(plannedReleaseArgs({ ...entry, openUntilKind: true }, NOW, TZ)).toMatchObject({
      endsAt, openUntilKind: true,
    });
  });

  test("an open-until end that already passed is dropped", () => {
    const args = plannedReleaseArgs(
      { mode: "classFocus", startsAt: NOW - 5 * DAY, endsAt: NOW - DAY, dueAt: null, scholarIds: null },
      NOW,
      TZ,
    );
    expect(args.endsAt).toBeUndefined();
  });
});
