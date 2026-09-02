import { describe, expect, test } from "vitest";
import { buildDocumentNotesSection, type DocumentNote } from "../prompts";
import { buildSystemPrompt } from "../sessionHelpers";

// The "background notes" section replaces the old report→dossier auto-append.
// It must (a) render only the REDACTED fields, (b) omit itself when empty, and
// (c) actually reach the tutor system prompt. A regression here would either
// leak score-bearing teacher text to the scholar-facing prompt or silently drop
// teacher reports from the tutor's context.

const note = (over: Partial<DocumentNote> = {}): DocumentNote => ({
  kind: "teacher_report",
  title: "Quarter 2 narrative",
  redactedSummary: "Strong argument writing; resists revision.",
  redactedKeyFindings: ["Pairs well with a clear rubric"],
  ...over,
});

describe("buildDocumentNotesSection", () => {
  test("returns null for null or empty input", () => {
    expect(buildDocumentNotesSection(null)).toBeNull();
    expect(buildDocumentNotesSection([])).toBeNull();
  });

  test("renders the redacted summary under a private heading", () => {
    const out = buildDocumentNotesSection([note()]) ?? "";
    expect(out).toContain("Background notes from teachers");
    expect(out).toContain("PRIVATE");
    expect(out).toContain("Quarter 2 narrative");
    expect(out).toContain("Strong argument writing; resists revision.");
  });

  test("falls back to redacted key findings when there is no summary", () => {
    const out =
      buildDocumentNotesSection([
        note({ redactedSummary: null, redactedKeyFindings: ["Loves space", "Quick with patterns"] }),
      ]) ?? "";
    expect(out).toContain("Loves space; Quick with patterns");
  });

  test("skips notes that carry no redacted content at all", () => {
    expect(
      buildDocumentNotesSection([note({ redactedSummary: "", redactedKeyFindings: [] })]),
    ).toBeNull();
  });
});

describe("buildSystemPrompt integration", () => {
  test("includes the notes section when documentNotes are present", () => {
    // documentNotes is the final positional arg of buildSystemPrompt.
    const prompt = buildSystemPrompt(
      null, null, "Kai",
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null,
      false, false, null,
      null, null, null, null, null,
      [note()],
    );
    expect(prompt).toContain("Background notes from teachers");
    expect(prompt).toContain("Strong argument writing; resists revision.");
  });

  test("omits the section entirely when there are no notes", () => {
    const prompt = buildSystemPrompt(null, null, "Kai", null, null, null);
    expect(prompt).not.toContain("Background notes from teachers");
  });
});
