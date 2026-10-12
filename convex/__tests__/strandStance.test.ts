import { describe, expect, test } from "vitest";
import { PCM_DIMENSIONS, PCM_STRAND_STANCE } from "../lib/pcm";
import type { LessonContext } from "../sessionHelpers";
import { buildSystemPrompt } from "../sessionHelpers";

// ── buildSystemPrompt: strand → stance wiring ────────────────────────

function buildWithLesson(lessonContext: LessonContext | null): string {
  return buildSystemPrompt(
    null, // teacherWhisper
    null, // readingLevel
    "Kai", // scholarName
    null, // unitContext
    null, // personaContext
    null, // perspectiveContext
    null, // processContext
    null, // processStateData
    null, // artifactData
    null, // dossierContent
    null, // seedsData
    null, // masteryContext
    null, // signalContext
    null, // timingContext
    lessonContext, // lessonContext
    null, // teacherDirectives
    null, // lessonActivityContext
    null, // priorActivityContext
    null, // activityContext
    null, // standaloneDeliverableContext
    null, // currentVerdictsContext
  );
}

function lesson(strand: string | null): LessonContext {
  return {
    title: "Tide Pools",
    strand,
    systemPrompt: null,
    durationMinutes: null,
    processTitle: null,
    processEmoji: null,
  };
}

describe("buildSystemPrompt — PCM strand stance", () => {
  test("each strand injects its own stance", () => {
    for (const dim of PCM_DIMENSIONS) {
      const prompt = buildWithLesson(lesson(dim));
      expect(prompt).toContain(`Strand: ${dim}`);
      expect(prompt).toContain(PCM_STRAND_STANCE[dim]);
    }
  });

  test("a lesson with NO strand includes no stance line", () => {
    const prompt = buildWithLesson(lesson(null));
    expect(prompt).not.toContain("Strand:");
    for (const dim of PCM_DIMENSIONS) {
      expect(prompt).not.toContain(PCM_STRAND_STANCE[dim]);
    }
  });

  test("an unrecognized strand value keeps the label but adds no stance", () => {
    const prompt = buildWithLesson(lesson("bogus"));
    expect(prompt).toContain("Strand: bogus");
    for (const dim of PCM_DIMENSIONS) {
      expect(prompt).not.toContain(PCM_STRAND_STANCE[dim]);
    }
  });
});
