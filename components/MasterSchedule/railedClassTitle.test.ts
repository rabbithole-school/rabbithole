import { describe, expect, it } from "vitest";
import { isAwaitingActivity } from "./PlacementChip";
import { railedClassTitle } from "./railedClassTitle";

const base = {
  _id: "p1",
  groupId: "g1",
  subject: "Language Arts",
  blockId: "b-class",
  weekday: 2,
  assignmentId: "a1",
  activityId: "act1",
  activityTitle: "Persuasive letter",
  unitTitle: "Letters",
  mode: "homework" as const,
  linkState: "live" as const,
};
const isHomeworkBlock = (id: string) => id === "b-hw";

describe("railedClassTitle", () => {
  it("leaves the class's block title in its cell when the card moves to the Homework due row", () => {
    const title = railedClassTitle({ ...base, railWeekday: 4 }, isHomeworkBlock);
    expect(title).toMatchObject({
      subject: "Language Arts",
      blockId: "b-class",
      weekday: 2,
      activityTitle: null,
      railedFrom: "p1",
    });
    expect(title!._id).not.toBe("p1");
    // The grid's bare-class rendering draws it as the block title.
    expect(isAwaitingActivity(title!)).toBe(true);
  });

  it("adds nothing when the card stays in its cell", () => {
    expect(railedClassTitle({ ...base, railWeekday: null }, isHomeworkBlock)).toBeNull();
  });

  it("adds nothing for a card that lives in the homework block itself", () => {
    expect(
      railedClassTitle({ ...base, blockId: "b-hw", railWeekday: 2 }, isHomeworkBlock),
    ).toBeNull();
  });
});
