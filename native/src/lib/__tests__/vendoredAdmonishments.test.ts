import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OVERSIGHT_LINE,
  PARENT_RELATIONAL_LINE,
  RELATIONAL_LINE,
  TEACHER_LINE,
} from "../../../vendor/shared/admonishments";

const REJECTED_MEMORY_CLAIM =
  /\b(?:no memory|(?:can(?:not|'t|’t)|does(?: not|n't|n’t)) remember)\b/i;

describe("vendored anti-parasocial disclosure", () => {
  it("uses approved scholar, parent, and oversight lines", () => {
    expect(RELATIONAL_LINE).toBe(
      "Rabbithole has no feelings. It won't miss you and can't be your friend.",
    );
    expect(PARENT_RELATIONAL_LINE).toBe(
      "Rabbithole is a tool, not a companion — it has no feelings and forms no bond with your child.",
    );
    expect(OVERSIGHT_LINE).toBe(
      "A real teacher can see and change everything it saves.",
    );
  });

  it("rejects memory claims across vendored disclosure copy", () => {
    for (const line of [
      RELATIONAL_LINE,
      PARENT_RELATIONAL_LINE,
      TEACHER_LINE,
      OVERSIGHT_LINE,
    ]) {
      expect(line).not.toMatch(REJECTED_MEMORY_CLAIM);
    }
  });

  it("is byte-identical to the shared source", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "..", "..", "..", "..", "shared", "admonishments.ts"),
      "utf8",
    );
    const vendored = readFileSync(
      join(here, "..", "..", "..", "vendor", "shared", "admonishments.ts"),
      "utf8",
    );
    expect(
      vendored,
      "vendor copy drifted — run `cd native && pnpm sync:vendor`",
    ).toBe(source);
  });
});
