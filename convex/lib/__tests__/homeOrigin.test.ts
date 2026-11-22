import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import {
  assignedWorkMode,
  decidingEntry,
  decidingEntryByActivity,
  startedWorkMode,
} from "../homeOrigin";
import type { ScheduleEntry } from "../pushes";

// The schedule's array order carries no meaning (Linear TRA-13 write switch):
// when one activity has several pushed entries for a scholar, the most
// recently activated one decides the mode, whatever order they come in.

const activityId = "act1" as Id<"activities">;
const kai = "kai" as Id<"users">;
const mia = "mia" as Id<"users">;
const NOW = 1_000_000;

function assignment(schedule: ScheduleEntry[]) {
  return { archivedAt: undefined, scholarIds: [kai, mia], selfPaced: false, schedule };
}

const homeworkEarlier: ScheduleEntry = { activityId, mode: "homework", setAt: 100 };
const focusLater: ScheduleEntry = { activityId, mode: "classFocus", setAt: 200, endsAt: NOW + 5000 };

describe("homeOrigin picks the most recently activated entry", () => {
  test("assignedWorkMode: same answer in either order", () => {
    expect(assignedWorkMode(assignment([homeworkEarlier, focusLater]), activityId, kai, NOW)).toBe("classFocus");
    expect(assignedWorkMode(assignment([focusLater, homeworkEarlier]), activityId, kai, NOW)).toBe("classFocus");
  });

  test("assignedWorkMode: with none live, the most recently activated expired entry", () => {
    const focusExpired: ScheduleEntry = { activityId, mode: "classFocus", setAt: 300, endsAt: NOW - 1 };
    const homeworkExpired: ScheduleEntry = { activityId, mode: "homework", setAt: 100, endsAt: NOW - 1 };
    expect(assignedWorkMode(assignment([homeworkExpired, focusExpired]), activityId, kai, NOW)).toBe("classFocus");
    expect(assignedWorkMode(assignment([focusExpired, homeworkExpired]), activityId, kai, NOW)).toBe("classFocus");
  });

  test("startedWorkMode: same answer in either order, ignoring who an entry targets", () => {
    const focusForMia: ScheduleEntry = { ...focusLater, scholarIds: [mia] };
    const homeworkForMia: ScheduleEntry = { ...homeworkEarlier, scholarIds: [mia] };
    expect(startedWorkMode(assignment([homeworkForMia, focusForMia]), activityId, kai, NOW)).toBe("classFocus");
    expect(startedWorkMode(assignment([focusForMia, homeworkForMia]), activityId, kai, NOW)).toBe("classFocus");
  });
});

describe("decidingEntry: the one rule for picking an activity's entry", () => {
  const other = "act2" as Id<"activities">;
  test("live beats expired, newest activation wins, homework wins a tie", () => {
    const expiredNewer: ScheduleEntry = { activityId, mode: "classFocus", setAt: 900, endsAt: NOW - 1 };
    const liveOlder: ScheduleEntry = { activityId, mode: "classFocus", setAt: 100, endsAt: NOW + 1 };
    expect(decidingEntry([expiredNewer, liveOlder], NOW)).toBe(liveOlder);
    const focusTie: ScheduleEntry = { activityId, mode: "classFocus", setAt: 500, endsAt: NOW + 1 };
    const homeworkTie: ScheduleEntry = { activityId, mode: "homework", setAt: 500 };
    expect(decidingEntry([homeworkTie, focusTie], NOW)).toBe(homeworkTie);
    expect(decidingEntry([focusTie, homeworkTie], NOW)).toBe(homeworkTie);
  });

  test("a live entry beats a planned one; among planned, the soonest start", () => {
    const planned: ScheduleEntry = { activityId, mode: "homework", startsAt: NOW + 10 };
    const plannedLater: ScheduleEntry = { activityId, mode: "classFocus", startsAt: NOW + 99 };
    expect(decidingEntry([planned, homeworkEarlier], NOW)).toBe(homeworkEarlier);
    expect(decidingEntry([plannedLater, planned], NOW)).toBe(planned);
  });

  test("decidingEntryByActivity picks per activity, whatever the input order", () => {
    const otherEntry: ScheduleEntry = { activityId: other, mode: "homework", setAt: 50 };
    for (const order of [
      [homeworkEarlier, focusLater, otherEntry],
      [otherEntry, focusLater, homeworkEarlier],
    ]) {
      const map = decidingEntryByActivity(order, NOW);
      expect(map.get(String(activityId))).toBe(focusLater);
      expect(map.get(String(other))).toBe(otherEntry);
    }
  });
});
