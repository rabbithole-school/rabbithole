import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { buildActivitySection, type LessonActivityContext } from "../sessionHelpers";
import {
  buildTutorSystemPrompt,
  type TutorPromptContext,
} from "../sessionStreamHelpers";

// Move B, re-reviewed: the build-partner stance is gated to a teacher
// test-drive of a COACHED activity (starter OR carried-in appRequest), the
// teacher's request rides a dedicated never-scholar-facing field, and the
// assembled prompt drops the scholar-only Socratic contradiction. These tests
// assert on the ASSEMBLED prompt (buildTutorSystemPrompt), not the isolated
// section, per .claude/rules/rabbithole-testing.md.

const APP_REQUEST =
  "A rocket shop where scholars pick parts, then run a launch that counts down and animates.";

const FAKE_STARTER = "app_fake_starter_id" as unknown as Id<"customApps">;

/** A full TutorPromptContext for a vibecode session; overrides layer on top. */
function vibecodeCtx(
  overrides: Partial<TutorPromptContext> & {
    activity?: Partial<LessonActivityContext>;
  } = {},
): TutorPromptContext {
  const { activity, ...ctxOverrides } = overrides;
  const lessonActivityContext: LessonActivityContext = {
    title: "Rocket Shop",
    description: null,
    kind: "vibecode",
    systemPrompt: "Build brief: scholars build a rocket shop.",
    durationMinutes: null,
    processTitle: null,
    processEmoji: null,
    starterAppId: null,
    appRequest: null,
    ...activity,
  };
  return {
    teacherWhisper: null,
    readingLevel: null,
    scholarName: "Reference Scholar",
    sessionMode: "vibecode",
    unitContext: null,
    personaContext: null,
    perspectiveContext: null,
    processContext: null,
    processStateData: null,
    artifactData: null,
    appStateContext: null,
    dossierContent: null,
    documentNotes: null,
    seeds: [],
    masteryContext: null,
    signalContext: null,
    timingContext: null,
    lessonContext: null,
    teacherDirectives: [],
    goals: [],
    weeklyGoals: [],
    lessonActivityContext,
    activityResourceContext: null,
    priorActivityContext: null,
    gameRoundContexts: null,
    activityContext: null,
    standaloneDeliverableContext: null,
    currentVerdictsContext: null,
    advanceRubricContext: null,
    conversationCompletionContext: null,
    practiceSkillsContext: null,
    isFirstTurn: false,
    isFirstSession: false,
    lastSessionAt: null,
    webPracticeContext: null,
    granuleStatusContext: null,
    activityRecipe: null,
    baselineEvidenceContext: null,
    seedOriginContext: null,
    physicalEnvironmentContext: null,
    ...ctxOverrides,
  };
}

const SOCRATIC_PROBE_FIRST = "try a Socratic probe FIRST";
const OVERRIDE_MARK = "REPLACE the Socratic tutoring rules";
const BUILD_PARTNER_MARK = "BUILD PARTNER (TEACHER)";
const SCHOLAR_MARK =
  "APP BUILDER MODE: You are a coding collaborator building ONE evolving";

describe("teacher build stance — gated to a coached activity", () => {
  test("test-drive of a coached activity (appRequest) → build-partner stance, request carried, Socratic overridden", () => {
    const prompt = buildTutorSystemPrompt(
      vibecodeCtx({
        isTestDrive: true,
        activity: { appRequest: APP_REQUEST },
      }),
    );
    expect(prompt).toContain(BUILD_PARTNER_MARK);
    // The teacher's request travels in verbatim (dedicated appRequest field).
    expect(prompt).toContain(APP_REQUEST);
    expect(prompt).toContain(
      "Keep the first version compact — a working core you can extend, not the whole spec at once; grow it with edit_document.",
    );
    // The scholar-only Socratic role is explicitly overridden for this session,
    // resolving the contradiction with the base prompt below.
    expect(prompt).toContain(OVERRIDE_MARK);
  });

  test("test-drive of a coached activity (starter) → build-partner stance, iterate not replace", () => {
    const prompt = buildTutorSystemPrompt(
      vibecodeCtx({
        isTestDrive: true,
        vibecodeStarterUsedAt: Date.now(),
        activity: { starterAppId: FAKE_STARTER, appRequest: null },
      }),
    );
    expect(prompt).toContain(BUILD_PARTNER_MARK);
    expect(prompt).toContain("ITERATING on it");
    expect(prompt).toContain(OVERRIDE_MARK);
  });

  test("test-drive of a PLAIN kids-build activity (no starter, no request) → scholar stance preserved", () => {
    const prompt = buildTutorSystemPrompt(
      vibecodeCtx({
        isTestDrive: true,
        activity: { starterAppId: null, appRequest: null },
      }),
    );
    // A teacher rehearsing a kids-build vibecode activity must see exactly what
    // scholars see, so they can preview it.
    expect(prompt).toContain(SCHOLAR_MARK);
    expect(prompt).not.toContain(BUILD_PARTNER_MARK);
    expect(prompt).not.toContain(OVERRIDE_MARK);
  });

  test("scholar (non-test-drive) session never gets the build stance NOR the appRequest text", () => {
    const prompt = buildTutorSystemPrompt(
      vibecodeCtx({
        isTestDrive: false,
        // Even a promoted, live coached activity (starter + a lingering
        // appRequest) must never leak the teacher's request to a scholar.
        activity: { starterAppId: FAKE_STARTER, appRequest: APP_REQUEST },
      }),
    );
    expect(prompt).toContain(SCHOLAR_MARK);
    expect(prompt).not.toContain(BUILD_PARTNER_MARK);
    expect(prompt).not.toContain(APP_REQUEST);
    // The scholar path keeps its Socratic funnel guard.
    expect(prompt).toContain("not a Socratic funnel");
  });
});

describe("buildActivitySection never emits the teacher app request", () => {
  test("appRequest is not rendered; description still is", () => {
    const section = buildActivitySection({
      title: "Rocket Shop",
      description: "Teacher-facing design intent.",
      kind: "vibecode",
      systemPrompt: "Build brief.",
      durationMinutes: null,
      processTitle: null,
      processEmoji: null,
      starterAppId: null,
      appRequest: APP_REQUEST,
    });
    expect(section).toContain("Teacher-facing design intent.");
    expect(section).not.toContain(APP_REQUEST);
  });
});

describe("scholar-facing Socratic guidance still present in a scholar session", () => {
  test("the base probe-first rule ships to a scholar vibecode session", () => {
    const prompt = buildTutorSystemPrompt(vibecodeCtx({ isTestDrive: false }));
    expect(prompt).toContain(SOCRATIC_PROBE_FIRST);
    expect(prompt).not.toContain(OVERRIDE_MARK);
  });
});
