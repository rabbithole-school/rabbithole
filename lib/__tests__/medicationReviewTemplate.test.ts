import { describe, expect, test } from "vitest";

import { medicationReplacementNoteTemplate } from "../medicationReviewTemplate";

describe("medicationReplacementNoteTemplate", () => {
  test("auto-fills the expiration date and leaves doses as a placeholder", () => {
    const note = medicationReplacementNoteTemplate([
      { name: "Albuterol", date: "2026-10-01" },
    ]);
    expect(note).toContain("Albuterol: expires October 1, 2026");
    expect(note).toContain("___ doses remaining");
  });

  test("lists every named medication row", () => {
    const note = medicationReplacementNoteTemplate([
      { name: "Albuterol", date: "2026-10-01" },
      { name: "EpiPen", date: "2026-11-15" },
    ]);
    expect(note).toContain("Albuterol: expires October 1, 2026");
    expect(note).toContain("EpiPen: expires November 15, 2026");
  });

  test("drops blank rows but keeps a placeholder when nothing is transcribed", () => {
    const note = medicationReplacementNoteTemplate([{ name: "", date: "" }]);
    expect(note).toContain("[medication name]: expires [expiration date]");
  });

  test("falls back to a placeholder expiration date when a row has no date yet", () => {
    const note = medicationReplacementNoteTemplate([
      { name: "Albuterol", date: "" },
    ]);
    expect(note).toContain("Albuterol: expires [expiration date]");
  });
});
