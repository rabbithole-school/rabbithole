import { describe, it, expect } from "vitest";
import {
  pickAdmonishment,
  RELATIONAL_LINE,
  TEACHER_LINE,
} from "./admonishments";

describe("pickAdmonishment", () => {
  it("defaults ordinary chat to the relational line", () => {
    expect(pickAdmonishment()).toBe(RELATIONAL_LINE);
    expect(pickAdmonishment({ isHomework: false })).toBe(RELATIONAL_LINE);
  });

  it("homework overrides the default with the teacher-visibility line", () => {
    expect(pickAdmonishment({ isHomework: true })).toBe(TEACHER_LINE);
  });

  it("the relational line is third-person + tool-framed, not first-person", () => {
    expect(RELATIONAL_LINE).toContain("Rabbithole has no feelings");
    expect(RELATIONAL_LINE).not.toMatch(/\bI('m| am)\b/);
  });

  it('never uses the rejected "no memory" copy', () => {
    expect(RELATIONAL_LINE.toLowerCase()).not.toContain("no memory");
    expect(TEACHER_LINE.toLowerCase()).not.toContain("no memory");
  });

  it("re-exports the canonical shared copy", async () => {
    const shared = await import("@/shared/admonishments");
    expect(RELATIONAL_LINE).toBe(shared.RELATIONAL_LINE);
    expect(TEACHER_LINE).toBe(shared.TEACHER_LINE);
  });
});
