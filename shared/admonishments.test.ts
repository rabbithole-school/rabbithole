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
  it("never revives rejected memory claims in exported disclosure copy", () => {
    for (const line of EXPORTED_DISCLOSURE_LINES) {
      expect(line).not.toMatch(REJECTED_MEMORY_CLAIM);
    }
  });
});
