import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../sessionHelpers";

// buildLessonSection (private to sessionHelpers.ts) labels the lesson's
// systemPrompt differently depending on whether the project is anchored to a
// specific activity. When it IS ("Lesson Background"), that text is
// teacher-authored planning context the scholar has never read — production
// used to label it with no warning, so the tutor could quote a detail that
// lived only there (a case, an example, a specific phrase) as if the scholar
// had already seen it (review/experiment-detective-tutor-audit.html, Moment
// C). These tests guard the fix: the label must carry an explicit
// not-shared-reading warning whenever an activity is present, and must NOT
// when there is no separate activity (the lesson prompt IS the operative
// instructions in that case). The fix frames the Activity Instructions as
// authoritative for THIS session (content precedence), not as something the
// scholar has "seen" — the activity's own systemPrompt is ALSO AI-facing
// planning text (labeled "Tutor prompt" in the curriculum editor), so an
// earlier draft's claim that it was "shared with" the scholar was itself
// inaccurate and has been corrected.

const LESSON_SYSTEM_PROMPT =
  "The model case: Maya changed water temperature, food, and sunlight all at once, and the fish 'gobbled it up.'";

function build(opts: {
  hasActivity: boolean;
}) {
  return buildSystemPrompt(
    null, // 1 teacherWhisper
    null, // 2 readingLevel
    "Kai", // 3 scholarName
    null, // 4 unitContext
    null, // 5 personaContext
    null, // 6 perspectiveContext
    null, // 7 processContext
    null, // 8 processStateData
    null, // 9 artifactData
    null, // 10 dossierContent
    null, // 11 seedsData
    null, // 12 masteryContext
    null, // 13 signalContext
    null, // 14 timingContext
    {
      title: "Experimental Design",
      strand: null,
      systemPrompt: LESSON_SYSTEM_PROMPT,
      durationMinutes: null,
      processTitle: null,
      processEmoji: null,
    }, // 15 lessonContext
    null, // 16 teacherDirectives
    opts.hasActivity
      ? {
          title: "Experiment Detective",
          description: null,
          kind: "online",
          systemPrompt: "Read Maya's write-up in the activity and find the flaw.",
          durationMinutes: null,
          processTitle: null,
          processEmoji: null,
        }
      : null, // 17 lessonActivityContext
  );
}

describe("lesson background labeling (Moment C)", () => {
  test("with an activity present: labels it teacher-facing and warns against quoting it as shared reading", () => {
    const prompt = build({ hasActivity: true });
    expect(prompt).toContain("Lesson Background (teacher-facing planning notes");
    expect(prompt).toContain("the scholar has NOT read this");
    expect(prompt).toContain("Never quote or paraphrase its wording");
    expect(prompt).toContain(
      "The Activity Instructions below are what actually governs this session",
    );
    expect(prompt).toContain("the activity's version is authoritative");
    // The original content must still reach the tutor — this is a framing
    // fix, not a redaction.
    expect(prompt).toContain(LESSON_SYSTEM_PROMPT);
    // Never the bare, unwarned "Lesson Instructions:" label in this branch.
    expect(prompt).not.toContain(`Lesson Instructions: ${LESSON_SYSTEM_PROMPT}`);
  });

  test("with no activity: keeps the plain 'Lesson Instructions' label, no teacher-facing warning", () => {
    const prompt = build({ hasActivity: false });
    expect(prompt).toContain(`Lesson Instructions: ${LESSON_SYSTEM_PROMPT}`);
    expect(prompt).not.toContain("teacher-facing planning notes");
    expect(prompt).not.toContain("the scholar has NOT read this");
  });
});
