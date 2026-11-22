import { describe, expect, test } from "vitest";
import {
  blockRunsOn,
  blocksForGroup,
  linkedLabel,
  removalEffect,
  settleDraft,
  oneWeekClasses,
  orderForStart,
  sameDayMeeting,
  shelfClasses,
  weeklyClassMeetings,
  type MeetingBlock,
  type MeetingPlacement,
} from "./classMeetings";

const block = (over: Partial<MeetingBlock> & { _id: string }): MeetingBlock => ({
  groupId: null,
  label: over._id,
  startLocal: "08:00",
  endLocal: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  order: 0,
  kind: "class",
  ...over,
});

const row = (over: Partial<MeetingPlacement> & { _id: string }): MeetingPlacement => ({
  groupId: "g1",
  weekday: 1,
  blockId: "a",
  subject: "Humanities",
  teacherId: null,
  teacherName: null,
  assignmentId: null,
  activityId: null,
  activityTitle: null,
  externalAppId: null,
  externalAppName: null,
  mode: null,
  weekStartMs: null,
  ...over,
});

const blocks = [
  block({ _id: "b", startLocal: "09:45", endLocal: "10:30", order: 1 }),
  block({ _id: "a", startLocal: "08:30", endLocal: "09:30", order: 0 }),
  block({ _id: "hw", kind: "homework", order: 9999 }),
  block({ _id: "other", groupId: "g2", order: 2, startLocal: "11:00" }),
];

describe("weeklyClassMeetings", () => {
  test("every recurring placed row of the group, in day then bell order", () => {
    const meetings = weeklyClassMeetings(
      [
        row({ _id: "tue", weekday: 2, blockId: "a" }),
        row({ _id: "mon-b", weekday: 1, blockId: "b", subject: "Math" }),
        row({ _id: "mon-a", weekday: 1, blockId: "a" }),
        row({ _id: "concrete", weekStartMs: 123 }),
        row({ _id: "shelf", weekday: null, blockId: null }),
        row({ _id: "hw-mode", mode: "homework" }),
        row({ _id: "g2", groupId: "g2" }),
      ],
      blocks,
      "g1",
    );
    expect(meetings.map((m) => m._id)).toEqual(["mon-a", "mon-b", "tue"]);
  });

  test("a filled recurring slot and a standing app slot are still meetings", () => {
    const meetings = weeklyClassMeetings(
      [
        row({
          _id: "filled",
          weekday: 3,
          activityId: "act",
          assignmentId: "as",
          activityTitle: "Mapping our islands",
        }),
        row({ _id: "app", weekday: 4, subject: "Robotics", externalAppId: "app", externalAppName: "LEGO SPIKE" }),
      ],
      blocks,
      "g1",
    );
    expect(meetings.map((m) => m._id)).toEqual(["filled", "app"]);
    expect(linkedLabel(meetings[0])).toBe("Activity: Mapping our islands");
    expect(linkedLabel(meetings[1])).toBe("App: LEGO SPIKE");
    expect(linkedLabel(row({ _id: "bare" }))).toBeNull();
  });
});

describe("shelf and one-week classes", () => {
  const rows = [
    row({ _id: "shelf-bare", weekday: null, blockId: null, subject: "Art" }),
    row({ _id: "shelf-work", weekday: null, blockId: null, activityId: "act" }),
    row({ _id: "shelf-hw", weekday: null, blockId: null, mode: "homework" }),
    row({ _id: "shelf-app", weekday: null, blockId: null, subject: "Robotics", externalAppId: "app" }),
    row({ _id: "wk2", weekStartMs: 2000, weekday: 2 }),
    row({ _id: "wk1", weekStartMs: 1000, weekday: 1 }),
    row({ _id: "wk1-work", weekStartMs: 1000, activityId: "act" }),
    row({ _id: "recurring" }),
  ];

  test("classes with no day are listed, an app class included; legacy shelved work isn't", () => {
    expect(shelfClasses(rows, "g1").map((p) => p._id)).toEqual(["shelf-bare", "shelf-app"]);
  });

  test("one-week bare classes group by week in date order", () => {
    expect(
      oneWeekClasses(rows, blocks, "g1").map((w) => [w.weekStartMs, w.classes.map((c) => c._id)]),
    ).toEqual([
      [1000, ["wk1"]],
      [2000, ["wk2"]],
    ]);
  });
});

describe("blocksForGroup", () => {
  test("shared blocks plus the group's own, without the homework row", () => {
    expect(blocksForGroup(blocks, "g1").map((b) => b._id)).toEqual(["a", "b"]);
    expect(blocksForGroup(blocks, "g2").map((b) => b._id)).toEqual(["a", "b", "other"]);
  });

  test("a block with no weekday list runs every day", () => {
    expect(blockRunsOn({ weekdays: [] }, 3)).toBe(true);
    expect(blockRunsOn({ weekdays: [1, 2] }, 3)).toBe(false);
  });
});

describe("sameDayMeeting", () => {
  const meetings = weeklyClassMeetings(
    [row({ _id: "hum-mon", weekday: 1 }), row({ _id: "math-mon", weekday: 1, blockId: "b", subject: "Math" })],
    blocks,
    "g1",
  );

  test("refuses a second meeting of a class on the same day, ignoring case", () => {
    expect(sameDayMeeting(meetings, { subject: " humanities ", weekday: 1 })?._id).toBe("hum-mon");
  });

  test("allows the class on another day, and a different class that day", () => {
    expect(sameDayMeeting(meetings, { subject: "Humanities", weekday: 2 })).toBeNull();
    expect(sameDayMeeting(meetings, { subject: "Science", weekday: 1 })).toBeNull();
  });

  test("a linked meeting counts toward the once-a-day rule", () => {
    const withLinked = weeklyClassMeetings(
      [row({ _id: "filled", weekday: 2, activityId: "act", assignmentId: "as" })],
      blocks,
      "g1",
    );
    expect(sameDayMeeting(withLinked, { subject: "Humanities", weekday: 2 })?._id).toBe("filled");
  });

  test("the meeting being edited never clashes with itself", () => {
    expect(sameDayMeeting(meetings, { subject: "Humanities", weekday: 1 }, "hum-mon")).toBeNull();
    expect(sameDayMeeting(meetings, { subject: "Humanities", weekday: 1 }, "math-mon")?._id).toBe("hum-mon");
  });
});

describe("orderForStart", () => {
  test("slots a block between its neighbours by start time", () => {
    expect(orderForStart(blocks, "09:00")).toBe(0.5);
  });
  test("before the first block and after the last", () => {
    expect(orderForStart(blocks, "07:00")).toBe(-1);
    expect(orderForStart(blocks, "13:00")).toBe(3);
  });
  test("re-timing a block ignores its own position and the homework row", () => {
    expect(orderForStart(blocks, "07:00", "a")).toBe(0);
    expect(orderForStart([block({ _id: "hw", kind: "homework", order: 9999 })], "08:00")).toBe(0);
  });
});

describe("removalEffect", () => {
  test("an app slot ends access, live or not", () => {
    expect(removalEffect(row({ _id: "a", externalAppId: "app", linkState: "live" }), [])).toBe("app");
    expect(removalEffect(row({ _id: "a", externalAppId: "app" }), [])).toBe("app");
  });

  test("a skill slot retires with its last placement, keeps serving with a sibling", () => {
    const slot = row({ _id: "s1", activityId: "act", assignmentId: "as", isSkillSlot: true, linkState: "live" });
    expect(removalEffect(slot, [slot])).toBe("skillLast");
    expect(removalEffect(slot, [slot, { _id: "s2", activityId: "act" }])).toBe("skillShared");
  });

  test("curriculum work keeps running only once it is live", () => {
    expect(removalEffect(row({ _id: "c", activityId: "act", assignmentId: "as", linkState: "live" }), [])).toBe("liveActivity");
    expect(removalEffect(row({ _id: "c", activityId: "act", assignmentId: "as", linkState: "planned" }), [])).toBe("planned");
  });

  test("a bare class has nothing to wrap up", () => {
    expect(removalEffect(row({ _id: "b" }), [])).toBe("bare");
  });
});

describe("settleDraft", () => {
  test("a settled save clears the draft it submitted", () => {
    expect(settleDraft("Bring rulers", "Bring rulers")).toBeNull();
  });

  test("typing during an outstanding save keeps the newer draft", () => {
    // Submitted "Bring rulers"; the person kept typing before the save landed.
    expect(settleDraft("Bring rulers and glue", "Bring rulers")).toBe("Bring rulers and glue");
  });

  test("a draft already cleared stays cleared", () => {
    expect(settleDraft(null, "Bring rulers")).toBeNull();
  });
});

