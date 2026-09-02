import { describe, expect, it } from "vitest";
import {
  OVERSIGHT_LINE,
  PARENT_RELATIONAL_LINE,
  RELATIONAL_LINE,
  TEACHER_LINE,
} from "./admonishments";

const EXPORTED_DISCLOSURE_LINES = [
  RELATIONAL_LINE,
  PARENT_RELATIONAL_LINE,
  TEACHER_LINE,
  OVERSIGHT_LINE,
];
const REJECTED_MEMORY_CLAIM =
  /\b(?:no memory|(?:can(?:not|'t|’t)|does(?: not|n't|n’t)) remember)\b/i;

describe("anti-parasocial disclosure copy", () => {
  it("locks the approved scholar relational line", () => {
    expect(RELATIONAL_LINE).toBe(
      "Rabbithole has no feelings. It won't miss you and can't be your friend.",
    );
  });

  it("keeps the approved parent disclosure distinct from scholar copy", () => {
    expect(PARENT_RELATIONAL_LINE).toBe(
      "Rabbithole is a tool, not a companion — it has no feelings and forms no bond with your child.",
    );
  });

  it("locks the approved teacher-visibility line", () => {
    expect(TEACHER_LINE).toBe("Your teacher can read this.");
  });

  it("locks the approved oversight line", () => {
    expect(OVERSIGHT_LINE).toBe(
      "A real teacher can see and change everything it saves.",
    );
  });

  it("never revives rejected memory claims in exported disclosure copy", () => {
    for (const line of EXPORTED_DISCLOSURE_LINES) {
      expect(line).not.toMatch(REJECTED_MEMORY_CLAIM);
    }
  });
});
