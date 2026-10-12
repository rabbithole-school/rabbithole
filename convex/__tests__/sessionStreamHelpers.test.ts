import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  sseEvent,
  parseSessionStreamBody,
  toolsForWorkshopMode,
  buildTutorSystemPrompt,
  buildTutorSystemPromptParts,
  appendTurnContext,
  TURN_CONTEXT_PREFIX,
  injectPendingWhisper,
  rubricCheckInstruction,
  kickoffInstruction,
  kickoffInstructionForContext,
  teacherBuildKickoffInstruction,
  canRequestRenderCheck,
  renderChecksEnabled,
  runBuildToolWithTruncationGuard,
  RENDER_CHECK_MAX_PER_TURN,
  type TutorPromptContext,
} from "../sessionStreamHelpers";
import { buildSystemPrompt } from "../sessionHelpers";
import {
  buildToolsSection,
  FIRST_DYNAMIC_TUTOR_SECTION,
  TUTOR_PROMPT_SECTION_ORDER,
  TUTOR_TURN_CONTEXT_SECTIONS,
} from "../prompts";
import { withConversationCacheBreakpoint } from "../lib/aideStream";

describe("sseEvent", () => {
  test("formats a data frame terminated by a blank line", () => {
    expect(sseEvent({ text: "hi" })).toBe('data: {"text":"hi"}\n\n');
  });
  test("round-trips through the SSE wire shape", () => {
    const frame = sseEvent({ done: true, messageId: "m1" });
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice("data: ".length, -2))).toEqual({
      done: true,
      messageId: "m1",
    });
  });
});

describe("toolsForWorkshopMode", () => {
  const tools = [
    { name: "create_code" },
    { name: "edit_document" },
    { name: "show_map" },
    { name: "search" },
  ];

  test("Play drops the code tools so the tutor cannot rewrite the app (F9)", () => {
    const play = toolsForWorkshopMode(tools, "play").map((t) => t.name);
    expect(play).not.toContain("create_code");
    expect(play).not.toContain("edit_document");
    expect(play).toEqual(["show_map", "search"]);
  });

  test("Edit keeps the full tool set", () => {
    const edit = toolsForWorkshopMode(tools, "edit").map((t) => t.name);
    expect(edit).toEqual([
      "create_code",
      "edit_document",
      "show_map",
      "search",
    ]);
  });
});

describe("parseSessionStreamBody", () => {
  test("extracts sessionId + assistantMsgId, ignoring streamId", () => {
    expect(
      parseSessionStreamBody({ sessionId: "p1", streamId: "s1", assistantMsgId: "a1" }),
    ).toEqual({ sessionId: "p1", assistantMsgId: "a1", platform: "web", mode: "edit" });
  });

  test("defaults the workshop mode to edit and accepts play explicitly", () => {
    expect(
      parseSessionStreamBody({ sessionId: "p1", assistantMsgId: "a1" }).mode,
    ).toBe("edit");
    expect(
      parseSessionStreamBody({ sessionId: "p1", assistantMsgId: "a1", mode: "play" })
        .mode,
    ).toBe("play");
    expect(
      parseSessionStreamBody({ sessionId: "p1", assistantMsgId: "a1", mode: "bogus" })
        .mode,
    ).toBe("edit");
  });

  test("accepts only an explicit render-check capability", () => {
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        supportsRenderCheck: true,
      }).supportsRenderCheck,
    ).toBe(true);
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        supportsRenderCheck: false,
      }).supportsRenderCheck,
    ).toBeUndefined();
  });

  test("accepts native explicitly and defaults every other platform to web", () => {
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        platform: "native",
      }).platform,
    ).toBe("native");
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        platform: "desktop",
      }).platform,
    ).toBe("web");
  });

  describe("render-check cap", () => {
    test("allows exactly two checks per turn", () => {
      expect(canRequestRenderCheck(0)).toBe(true);
      expect(canRequestRenderCheck(1)).toBe(true);
      expect(canRequestRenderCheck(RENDER_CHECK_MAX_PER_TURN)).toBe(false);
      expect(canRequestRenderCheck(RENDER_CHECK_MAX_PER_TURN + 1)).toBe(false);
    });

    test("requires a capable web or native Vibecode host", () => {
      expect(
        renderChecksEnabled({
          supportsRenderCheck: true,
          platform: "web",
          sessionMode: "vibecode",
        }),
      ).toBe(true);
      expect(
        renderChecksEnabled({
          supportsRenderCheck: true,
          platform: "native",
          sessionMode: "vibecode",
        }),
      ).toBe(true);
      expect(
        renderChecksEnabled({
          supportsRenderCheck: true,
          platform: "web",
          sessionMode: "conversation",
        }),
      ).toBe(false);
      expect(
        renderChecksEnabled({
          platform: "web",
          sessionMode: "vibecode",
        }),
      ).toBe(false);
    });
  });

  test("a normal message body has no rubricCheck", () => {
    expect(
      parseSessionStreamBody({ sessionId: "p1", assistantMsgId: "a1" }).rubricCheck,
    ).toBeUndefined();
  });

  test("accepts bounded app context and ignores invalid context", () => {
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        appRequest: { context: { selectedNode: "mars" } },
      }).appRequest,
    ).toEqual({ context: { selectedNode: "mars" } });
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        appRequest: { context: ["not", "an", "object"] },
      }).appRequest,
    ).toEqual({});
  });

  test("accepts only a boolean true kickoff flag", () => {
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        kickoff: true,
      }).kickoff,
    ).toBe(true);
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        kickoff: false,
      }).kickoff,
    ).toBeUndefined();
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        kickoff: "true",
      }).kickoff,
    ).toBeUndefined();
  });

  test("a rubric-check body surfaces the artifact title", () => {
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        rubricCheck: { artifactTitle: "My Bridge Report" },
      }).rubricCheck,
    ).toEqual({ artifactTitle: "My Bridge Report" });
  });

  test("a rubric-check with no/invalid title still triggers (title undefined)", () => {
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        rubricCheck: { artifactTitle: 42 },
      }).rubricCheck,
    ).toEqual({ artifactTitle: undefined });
    expect(
      parseSessionStreamBody({
        sessionId: "p1",
        assistantMsgId: "a1",
        rubricCheck: {},
      }).rubricCheck,
    ).toEqual({ artifactTitle: undefined });
  });
});

describe("runBuildToolWithTruncationGuard", () => {
  test("blocks missing code, then stops a second output-limited build retry", async () => {
    const mutation = vi.fn(async () => "mutation ran");
    const first = await runBuildToolWithTruncationGuard({
      toolName: "create_code",
      input: { title: "Rocket Shop" },
      truncationsThisTurn: 0,
      run: mutation,
    });
    expect(first).toMatchObject({
      blocked: true,
      truncationsThisTurn: 1,
    });
    expect(first.result).toContain("Build a SMALLER first version now");
    expect(mutation).not.toHaveBeenCalled();

    const second = await runBuildToolWithTruncationGuard({
      toolName: "create_code",
      input: { title: "Rocket Shop", code: "<!doctype html>" },
      stopReason: "max_tokens",
      truncationsThisTurn: first.truncationsThisTurn,
      run: mutation,
    });
    expect(second).toMatchObject({
      blocked: true,
      truncationsThisTurn: 2,
    });
    expect(second.result).toContain(
      "Do not call create_code again this turn",
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  test("lets an empty document create through — it carries no payload to truncate", async () => {
    const mutation = vi.fn(async () => "mutation ran");
    const guarded = await runBuildToolWithTruncationGuard({
      toolName: "edit_document",
      input: { command: "create", title: "My character's want" },
      truncationsThisTurn: 0,
      run: mutation,
    });
    expect(guarded).toMatchObject({ blocked: false, result: "mutation ran" });
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  test("blocks edit_document when its command-specific payload is missing", async () => {
    const mutation = vi.fn(async () => "mutation ran");
    const guarded = await runBuildToolWithTruncationGuard({
      toolName: "edit_document",
      input: {
        command: "str_replace",
        old_str: "old markup",
      },
      truncationsThisTurn: 0,
      run: mutation,
    });
    expect(guarded.blocked).toBe(true);
    expect(guarded.result).toContain("cut off by the output limit");
    expect(mutation).not.toHaveBeenCalled();
  });
});

describe("rubricCheckInstruction", () => {
  test("names the document and tells the tutor to call the scoring tool", () => {
    const out = rubricCheckInstruction("My Report");
    expect(out).toContain('"My Report"');
    expect(out).toContain("update_rubric_score");
    // It must NOT ask the tutor to recite the rubric at the scholar.
    expect(out).toContain("do NOT recite the rubric");
  });

  test("falls back to a generic phrasing when no title is given", () => {
    const out = rubricCheckInstruction();
    expect(out).toContain("their current work");
    expect(out).toContain("update_rubric_score");
  });
});

describe("kickoffInstruction", () => {
  test("is honest, concise, and distinct from the rubric trigger", () => {
    const out = kickoffInstruction();
    expect(out).toContain("NOT a message the scholar typed");
    expect(out).toContain("ONE inviting question");
    expect(out).not.toMatch(/rubric/i);
  });
});

describe("teacherBuildKickoffInstruction", () => {
  test("builds immediately for teacher build contexts and leaves scholar copy unchanged", () => {
    const teacherInstruction = teacherBuildKickoffInstruction();
    expect(teacherInstruction).toBe(
      "[SYSTEM — not a message the teacher typed. The teacher just opened this build session. Build the first working version of the app described in your APP BUILDER MODE lead-in NOW with create_code, then describe what you built and the judgment calls they may want to steer. Do not greet or ask what to build.]",
    );
    expect(
      kickoffInstructionForContext({
        isTestDrive: true,
        lessonActivityContext: {
          starterAppId: null,
          appRequest: "Build a rocket shop.",
        },
      }),
    ).toBe(teacherInstruction);
    expect(
      kickoffInstructionForContext({
        isTestDrive: true,
        lessonActivityContext: {
          starterAppId: "starter" as Id<"customApps">,
          appRequest: null,
        },
      }),
    ).toBe(teacherInstruction);
    expect(
      kickoffInstructionForContext({
        isTestDrive: false,
        lessonActivityContext: {
          starterAppId: null,
          appRequest: "Teacher-only request",
        },
      }),
    ).toBe(kickoffInstruction());
  });
});

const baseCtx: TutorPromptContext = {
  teacherWhisper: null,
  readingLevel: null,
  scholarName: null,
  gameRoundContexts: null,
  practiceSkillsContext: null,
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
  lessonActivityContext: null,
  priorActivityContext: null,
  activityContext: null,
  standaloneDeliverableContext: null,
  currentVerdictsContext: null,
  advanceRubricContext: null,
  conversationCompletionContext: null,
  isFirstTurn: false,
  isFirstSession: false,
  lastSessionAt: null,
  webPracticeContext: null,
  granuleStatusContext: null,
  activityRecipe: null,
  baselineEvidenceContext: null,
  seedOriginContext: null,
  physicalEnvironmentContext: null,
};

describe("buildTutorSystemPrompt", () => {
  test("returns a non-empty prompt from a blank-slate context", () => {
    expect(buildTutorSystemPrompt(baseCtx).length).toBeGreaterThan(0);
  });

  test("named production mapping is byte-identical to the positional builder", () => {
    const rich: TutorPromptContext = {
      ...baseCtx,
      readingLevel: "Grade 5",
      scholarName: "Ari",
      dossierContent: "Ari likes testing geometric claims with counterexamples.",
      unitContext: {
        title: "Equal areas",
        description: "Explore equivalence through geometry.",
        systemPrompt: "Keep area as the invariant.",
        rubric: null,
        youtubeUrl: null,
        videoTranscript: null,
        bigIdea: "Shapes can look different while covering equal area.",
        essentialQuestions: [{ key: "eq-area", text: "What makes two areas equal?" }],
        enduringUnderstandings: null,
      },
      lessonContext: {
        title: "Halving",
        strand: "core",
        systemPrompt: "Use folds as background.",
        durationMinutes: 30,
        processTitle: "Notice and wonder",
        processEmoji: "🔎",
      },
      lessonActivityContext: {
        title: "Fold a rectangle",
        description: "Find two different equal partitions.",
        kind: "online",
        systemPrompt: "Ask for a comparison before an explanation.",
        durationMinutes: 15,
        processTitle: "Fold, compare, explain",
        processEmoji: "📐",
      },
      activityResourceContext: [
        {
          id: "resource-1",
          title: "Area note",
          kind: "file",
          url: null,
          extractedText: "Equal area means equal amounts of surface.",
        },
      ],
      standaloneDeliverableContext: {
        activityTitle: "Fold a rectangle",
        prompt: "Explain why both partitions make equal halves.",
        rubric: "1. [area] Uses area evidence",
        kind: "text",
        isComplete: false,
      },
      isFirstTurn: true,
      isFirstSession: true,
    };

    const positional = buildSystemPrompt(
      rich.teacherWhisper,
      rich.readingLevel,
      rich.scholarName,
      rich.unitContext,
      rich.personaContext,
      rich.perspectiveContext,
      rich.processContext,
      rich.processStateData,
      rich.artifactData,
      rich.dossierContent,
      null,
      rich.masteryContext,
      rich.signalContext,
      rich.timingContext,
      rich.lessonContext,
      null,
      rich.lessonActivityContext,
      rich.priorActivityContext,
      rich.activityContext,
      rich.standaloneDeliverableContext,
      rich.currentVerdictsContext,
      rich.isFirstTurn,
      rich.isFirstSession,
      rich.lastSessionAt,
      rich.webPracticeContext,
      rich.granuleStatusContext,
      rich.activityRecipe,
      rich.baselineEvidenceContext,
      rich.seedOriginContext,
      rich.documentNotes,
      rich.advanceRubricContext,
      rich.practiceSkillsContext,
      rich.physicalEnvironmentContext,
      null,
      rich.conversationCompletionContext,
      null,
      rich.activityResourceContext,
    );
    expect(buildTutorSystemPrompt(rich)).toBe(positional);
  });

  test("empty seeds omit the seeds section; a seed includes it", () => {
    expect(buildTutorSystemPrompt(baseCtx)).not.toContain("EXPLORATION SEEDS");
    const withSeed = buildTutorSystemPrompt({
      ...baseCtx,
      seeds: [
        {
          topic: "arches",
          domain: null,
          approachHint: null,
          suggestionType: "frontier",
          approved: true,
        },
      ],
    });
    expect(withSeed).toContain("EXPLORATION SEEDS");
    expect(withSeed).toContain("arches");
  });

  test("seed-spawned session surfaces its origin focus to the tutor", () => {
    // No originating seed → no SESSION FOCUS block, so the tutor would open
    // cold (the prod bug: it asks "what's the context?" / "can't see materials").
    expect(buildTutorSystemPrompt(baseCtx)).not.toContain("SESSION FOCUS");
    const withOrigin = buildTutorSystemPrompt({
      ...baseCtx,
      seedOriginContext: {
        topic: "Heat transfer and fluid dynamics in fire behavior",
        domain: "Physics",
        rationale: "He's wrestling with gas behavior complexity.",
        approachHint: "Create visible demonstrations of convection currents.",
        connectionTo: "His hypothetical about NO₂ fire safety reversal",
        hasStructure: false,
      },
    });
    expect(withOrigin).toContain("SESSION FOCUS");
    expect(withOrigin).toContain(
      "Heat transfer and fluid dynamics in fire behavior",
    );
    // The tutor is told to dive in, not interrogate for context.
    expect(withOrigin).toContain('When the scholar sends "<start>"');
    expect(withOrigin).toContain("THIS topic");
  });

  test("origin focus is rendered after the suggestion-seeds opener (recency)", () => {
    const prompt = buildTutorSystemPrompt({
      ...baseCtx,
      seeds: [
        {
          topic: "arches",
          domain: null,
          approachHint: null,
          suggestionType: "frontier",
          approved: true,
        },
      ],
      seedOriginContext: {
        topic: "fire behavior",
        domain: "Physics",
        rationale: null,
        approachHint: null,
        connectionTo: null,
        hasStructure: false,
      },
    });
    expect(prompt.indexOf("EXPLORATION SEEDS")).toBeLessThan(
      prompt.indexOf("SESSION FOCUS"),
    );
  });

  test("empty directives omit the directives section; one includes it", () => {
    expect(buildTutorSystemPrompt(baseCtx)).not.toContain(
      "Teacher directives for this scholar",
    );
    const withDirective = buildTutorSystemPrompt({
      ...baseCtx,
      teacherDirectives: [{ label: "Pacing", content: "Slow down on fractions." }],
    });
    expect(withDirective).toContain("Teacher directives for this scholar");
    expect(withDirective).toContain("Slow down on fractions.");
  });

  test("empty goals omit the goals section; one includes it (governed inject)", () => {
    expect(buildTutorSystemPrompt(baseCtx)).not.toContain(
      "This scholar's learning goals",
    );
    const withGoal = buildTutorSystemPrompt({
      ...baseCtx,
      goals: [{ title: "Ask my own research question", kind: "academic" }],
    });
    expect(withGoal).toContain("This scholar's learning goals");
    expect(withGoal).toContain("Ask my own research question");
  });

  test("empty weekly goals omit the section; one includes it (governed inject)", () => {
    expect(buildTutorSystemPrompt(baseCtx)).not.toContain(
      "This scholar's goals for this week",
    );
    const withWeekly = buildTutorSystemPrompt({
      ...baseCtx,
      weeklyGoals: [{ text: "Get better at estimating" }],
    });
    expect(withWeekly).toContain("This scholar's goals for this week");
    expect(withWeekly).toContain("Get better at estimating");
  });

  test("first-turn + first-session triggers the non-human intro", () => {
    expect(buildTutorSystemPrompt(baseCtx)).not.toContain("FIRST MESSAGE");
    expect(
      buildTutorSystemPrompt({
        ...baseCtx,
        isFirstTurn: true,
        isFirstSession: true,
      }),
    ).toContain("FIRST MESSAGE");
  });

  test("returning scholar opening a NEW session gets fresh-start guidance, not a false welcome-back", () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    // Returning scholar (isFirstSession=false) on the opening turn of a brand-new
    // session/quest they've never been in: the tutor must be told this is a fresh
    // start so it doesn't greet a never-had conversation with "welcome back".
    const opening = buildTutorSystemPrompt({
      ...baseCtx,
      isFirstTurn: true,
      isFirstSession: false,
      lastSessionAt: twoDaysAgo,
    });
    expect(opening).toContain("SESSION CONTEXT:");
    expect(opening).toContain("brand-new session");
    expect(opening).toContain('do NOT say "welcome back"');
    // Later turns of that same session have real history → plain returning note.
    const later = buildTutorSystemPrompt({
      ...baseCtx,
      isFirstTurn: false,
      isFirstSession: false,
      lastSessionAt: twoDaysAgo,
    });
    expect(later).toContain("returning scholar");
    expect(later).not.toContain('do NOT say "welcome back"');
  });

  test("workbench mode adds the sideline-coach contract only to workbench sessions", () => {
    const workbench = buildTutorSystemPrompt({
      ...baseCtx,
      sessionMode: "workbench",
    });
    expect(workbench).toContain("SIMULATOR MODE");
    expect(workbench).toContain("view_workbench");
    expect(workbench).toContain("update_world");
    expect(workbench).toContain("ZERO path to write or rewrite");
    expect(workbench).toContain("cannot launch runs");
    expect(workbench).toContain("cannot write the Notebook");
    expect(workbench).toContain("teacher-set graded contract");

    expect(
      buildTutorSystemPrompt({
        ...baseCtx,
        sessionMode: "conversation",
      }),
    ).not.toContain("SIMULATOR MODE");
    expect(
      buildTutorSystemPrompt({
        ...baseCtx,
        sessionMode: "vibecode",
      }),
    ).not.toContain("SIMULATOR MODE");
  });
});

describe("buildTutorSystemPromptParts (prompt-cache split)", () => {
  test("all parts are byte-identical to the full prompt", () => {
    const { stable, dynamic, turnContext } =
      buildTutorSystemPromptParts(baseCtx);
    expect(stable + dynamic + "\n\n" + turnContext).toBe(
      buildTutorSystemPrompt(baseCtx),
    );
  });

  test("invariant holds with a fully-populated dynamic context", () => {
    const rich: TutorPromptContext = {
      ...baseCtx,
      teacherWhisper: "watch for cognitive offloading",
      readingLevel: "grade 4",
      dossierContent: "Prefers visual explanations.",
      seeds: [
        {
          topic: "arches",
          domain: null,
          approachHint: null,
          suggestionType: "frontier",
          approved: true,
        },
      ],
      teacherDirectives: [{ label: "Pacing", content: "Slow down on fractions." }],
      isFirstTurn: true,
      isFirstSession: true,
    };
    const { stable, dynamic, turnContext } =
      buildTutorSystemPromptParts(rich);
    expect(stable + dynamic + "\n\n" + turnContext).toBe(
      buildTutorSystemPrompt(rich),
    );
  });

  test("the cached stable prefix carries the base prompt, not the dynamic suffix", () => {
    const { stable, dynamic } = buildTutorSystemPromptParts({
      ...baseCtx,
      teacherWhisper: "watch for cognitive offloading",
      teacherDirectives: [{ label: "Pacing", content: "Slow down on fractions." }],
    });
    // The large, session-stable base prompt is in the cached prefix…
    expect(stable).toContain("plain prose");
    expect(stable.length).toBeGreaterThan(1000);
    // …while per-turn-varying sections live in the uncached suffix.
    expect(stable).not.toContain("Teacher directives for this scholar");
    expect(dynamic).toContain("Teacher directives for this scholar");
  });
});

describe("buildTutorSystemPromptParts — stable prefix is wall-clock-independent (fixed session state)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression for cache-busters that used to live before the rolling
  // conversation breakpoint:
  //   1. the SESSION CONTEXT gap string (sections[3]) — fixed by anchoring the
  //      gap to sessionCreatedAt instead of Date.now();
  //   2. the clock and timing sections — fixed by moving them after the latest
  //      user message's rolling breakpoint.
  // With both fixed, `stable` and `dynamic` are byte-identical across
  // wall-clock time for FIXED session state. Deliberately NOT covered (known,
  // accepted one-time re-caches, not per-turn churn):
  //   - set_activity_angle disappearing from the tool set once an angle is
  //     chosen (tools precede system in the cache prefix),
  //   - the school-day boundary flipping physicalEnvironmentContext +
  //     suggest_physical_task (a deliberate fail-closed product gate on
  //     Date.now() in getSessionContext; at most one flip per boundary).
  // The turn-1→turn-2 flip of isFirstTurn used to be on this list; TRA-234
  // moved every isFirstTurn-dependent byte into the dynamic tail (covered by
  // the "turn 1 → turn 2" describe below).
  const sessionCreatedAt = 1_700_000_000_000;
  // Last session ended ~3h before THIS session opened (a returning scholar).
  const lastSessionAt = sessionCreatedAt - 3 * 60 * 60 * 1000;
  const returningCtx: TutorPromptContext = {
    ...baseCtx,
    isFirstTurn: false,
    isFirstSession: false,
    lastSessionAt,
    sessionCreatedAt,
  };

  test("system parts are byte-identical while turn context changes with the wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(sessionCreatedAt);
    const first = buildTutorSystemPromptParts({
      ...returningCtx,
      timingContext: {
        sessionStartedAt: sessionCreatedAt,
        unitEndsAt: sessionCreatedAt + 30 * 60 * 1000,
        unitDurationMinutes: 30,
      },
    });

    vi.setSystemTime(sessionCreatedAt + 3 * 60 * 1000);
    const later = buildTutorSystemPromptParts({
      ...returningCtx,
      timingContext: {
        sessionStartedAt: sessionCreatedAt,
        unitEndsAt: sessionCreatedAt + 30 * 60 * 1000,
        unitDurationMinutes: 30,
      },
    });

    expect(later.stable).toBe(first.stable);
    expect(later.dynamic).toBe(first.dynamic);
    expect(later.turnContext).not.toBe(first.turnContext);
    expect(first.stable).toContain("SESSION CONTEXT:");
    expect(first.stable).toContain("their last session was about 3 hours ago");
    expect(first.stable).not.toContain("Current date and time:");
    expect(first.dynamic).not.toContain("Current date and time:");
    expect(first.dynamic).not.toContain("TIMING:");
    expect(later.turnContext.startsWith("Current date and time:")).toBe(true);
    expect(later.turnContext).toContain("TIMING:");
  });

  test("the gap reflects the session-start anchor, not prompt-build wall time", () => {
    // Build far in the "future" relative to sessionCreatedAt; the rendered gap
    // must still be the session-open gap (3h), proving Date.now() is not used.
    vi.useFakeTimers();
    vi.setSystemTime(sessionCreatedAt + 10 * 24 * 60 * 60 * 1000);
    const { stable } = buildTutorSystemPromptParts(returningCtx);
    expect(stable).toContain("their last session was about 3 hours ago");
    expect(stable).not.toContain("days ago");
  });
});

describe("buildTutorSystemPromptParts — stable prefix is identical on turn 1 and turn 2 (TRA-234)", () => {
  // Regression for the turn-2 cache miss seen on every prod session: the
  // first-turn-only directives (FIRST MESSAGE primacy line, the intro <start>
  // bullet, the SESSION CONTEXT fresh-start variants) used to sit inside the
  // cached prefix, so turn 1 and turn 2 differed before the breakpoint and
  // turn 2 re-wrote the whole ~18k-token prefix. Everything keyed on
  // isFirstTurn now lives in the dynamic tail.
  const sessionCreatedAt = 1_700_000_000_000;

  function turns(overrides: Partial<TutorPromptContext>) {
    const turn1 = buildTutorSystemPromptParts({
      ...baseCtx,
      ...overrides,
      sessionCreatedAt,
      isFirstTurn: true,
    });
    const turn2 = buildTutorSystemPromptParts({
      ...baseCtx,
      ...overrides,
      sessionCreatedAt,
      isFirstTurn: false,
    });
    return { turn1, turn2 };
  }

  test("first-ever session: FIRST MESSAGE + intro live only in the dynamic tail", () => {
    const { turn1, turn2 } = turns({ isFirstSession: true, lastSessionAt: null });
    expect(turn1.stable).toBe(turn2.stable);
    expect(turn1.stable).not.toContain("FIRST MESSAGE");
    expect(turn1.stable).not.toContain("Introduce yourself");
    expect(turn1.dynamic).toContain("FIRST MESSAGE:");
    expect(turn1.dynamic).toContain("## Introduce yourself");
    expect(turn2.dynamic).not.toContain("FIRST MESSAGE");
    expect(turn2.dynamic).not.toContain("## Introduce yourself");
  });

  test("returning scholar, new session after a gap: fresh-start guard only in the dynamic tail", () => {
    const { turn1, turn2 } = turns({
      isFirstSession: false,
      lastSessionAt: sessionCreatedAt - 2 * 24 * 60 * 60 * 1000,
    });
    expect(turn1.stable).toBe(turn2.stable);
    expect(turn1.stable).toContain("their last session was 2 days ago");
    expect(turn1.stable).not.toContain("welcome back");
    expect(turn1.dynamic).toContain("SESSION CONTEXT (opening turn)");
    expect(turn1.dynamic).toContain('do NOT say "welcome back"');
    expect(turn2.dynamic).not.toContain("SESSION CONTEXT (opening turn)");
  });

  test("returning scholar, same sitting: the same-sitting guard only in the dynamic tail", () => {
    const { turn1, turn2 } = turns({
      isFirstSession: false,
      lastSessionAt: sessionCreatedAt - 5 * 60 * 1000,
    });
    expect(turn1.stable).toBe(turn2.stable);
    expect(turn1.stable).toContain("no time gap to acknowledge");
    expect(turn1.dynamic).toContain("same sitting");
    expect(turn2.dynamic).not.toContain("same sitting");
  });

  test("the opening-turn directive leads the dynamic tail (max primacy after the breakpoint)", () => {
    const { turn1 } = turns({ isFirstSession: true, lastSessionAt: null });
    expect(turn1.dynamic.trimStart().startsWith("FIRST MESSAGE:")).toBe(true);
  });
});

describe("buildTutorSystemPromptParts — session-stable sections join the cached prefix (TRA-185)", () => {
  // Item 1 of TRA-185: curriculum context (unit / lesson / activity /
  // deliverable), the static tools description, and the reading-level register
  // do not change turn to turn, so they sit AHEAD of the breakpoint. The
  // observer-written scholar record (mastery, signals), verdicts, whispers and
  // seeds change per turn and stay behind it. Clock and timing ride in turn
  // context after the conversation breakpoint.
  const rich: TutorPromptContext = {
    ...baseCtx,
    readingLevel: "Grade 5",
    unitContext: {
      title: "Equal areas",
      description: "Explore equivalence through geometry.",
      systemPrompt: "Keep area as the invariant.",
      rubric: null,
      youtubeUrl: null,
      videoTranscript: null,
      bigIdea: "Shapes can look different while covering equal area.",
      essentialQuestions: [{ key: "eq-area", text: "What makes two areas equal?" }],
      enduringUnderstandings: null,
    },
    lessonActivityContext: {
      title: "Tangram swap",
      description: "Rearrange the pieces without changing the area.",
      kind: "online",
      systemPrompt: "Let the scholar cut and reassemble.",
      durationMinutes: 20,
      processTitle: null,
      processEmoji: null,
    },
    standaloneDeliverableContext: {
      activityTitle: "Tangram swap",
      prompt: "Show two different shapes with the same area.",
      rubric: "[c1] Uses a counting argument",
      kind: "artifact",
      isComplete: false,
    },
    currentVerdictsContext: [
      {
        kind: "artifact",
        artifactId: "a1",
        title: "My tangram",
        verdicts: [{ criterionId: "c1", level: "half" }],
      },
    ],
    masteryContext: [
      {
        concept: "area conservation",
        domain: "math",
        level: 2,
        confidence: 0.6,
        evidence: "Predicted equal area before counting.",
        studentInitiated: false,
      },
    ],
    signalContext: { curiosity: { count: 3, highCount: 1 } },
    teacherWhisper: "nudge toward a counting argument",
    seeds: [
      {
        topic: "arches",
        domain: null,
        approachHint: null,
        suggestionType: "frontier",
        approved: true,
      },
    ],
  };

  test("all parts are still byte-identical to the full prompt", () => {
    const { stable, dynamic, turnContext } =
      buildTutorSystemPromptParts(rich);
    expect(stable + dynamic + "\n\n" + turnContext).toBe(
      buildTutorSystemPrompt(rich),
    );
  });

  test("curriculum, deliverable, tools description and reading level are in the cached prefix", () => {
    const { stable, dynamic } = buildTutorSystemPromptParts(rich);
    for (const marker of [
      "Equal areas",
      "Tangram swap",
      "Show two different shapes with the same area.",
      "READING LEVEL:",
      "Uses a counting argument",
    ]) {
      expect(stable).toContain(marker);
      expect(dynamic).not.toContain(marker);
    }
    // The tools description is the largest constant section.
    expect(stable).toContain(buildToolsSection());
    expect(dynamic).not.toContain(buildToolsSection());
  });

  test("per-turn scholar record, verdicts, whisper and seeds stay in the dynamic system tail", () => {
    const { stable, dynamic, turnContext } =
      buildTutorSystemPromptParts(rich);
    for (const marker of [
      "area conservation", // mastery
      "LEARNER PROFILE (observed tendencies", // signals
      "nudge toward a counting argument", // whisper
      "arches", // seeds
      "[c1] → half", // current verdicts
    ]) {
      expect(dynamic).toContain(marker);
      expect(stable).not.toContain(marker);
    }
    expect(turnContext.startsWith("Current date and time:")).toBe(true);
    expect(stable).not.toContain("Current date and time:");
    expect(dynamic).not.toContain("Current date and time:");
  });

  test("the stable prefix is byte-identical when only the per-turn record moves", () => {
    const turnA = buildTutorSystemPromptParts(rich);
    const turnB = buildTutorSystemPromptParts({
      ...rich,
      masteryContext: [
        { ...rich.masteryContext![0], level: 3, evidence: "Now justifies it." },
      ],
      signalContext: { curiosity: { count: 4, highCount: 2 } },
      currentVerdictsContext: [
        {
          kind: "artifact",
          artifactId: "a1",
          title: "My tangram",
          verdicts: [{ criterionId: "c1", level: "full" }],
        },
      ],
      teacherWhisper: null,
      dossierContent: "Updated by the observer.",
    });
    expect(turnB.stable).toBe(turnA.stable);
    expect(turnB.dynamic).not.toBe(turnA.dynamic);
  });

  test("the section order constant is exhaustive and the breakpoint key is in it", () => {
    const idx = TUTOR_PROMPT_SECTION_ORDER.indexOf(FIRST_DYNAMIC_TUTOR_SECTION);
    expect(idx).toBeGreaterThan(0);
    const allSections = [
      ...TUTOR_PROMPT_SECTION_ORDER,
      ...TUTOR_TURN_CONTEXT_SECTIONS,
    ];
    expect(new Set(allSections).size).toBe(
      allSections.length,
    );
  });
});

describe("appendTurnContext", () => {
  test("converts string content and appends after the cache breakpoint", () => {
    const input = [{ role: "user" as const, content: "Explain tides." }];
    const withBreakpoint = withConversationCacheBreakpoint(input);
    const result = appendTurnContext(withBreakpoint, "Current date and time: now");
    const blocks = result[0].content;

    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) throw new Error("expected content blocks");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "text",
      text: "Explain tides.",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toEqual({
      type: "text",
      text: TURN_CONTEXT_PREFIX + "Current date and time: now",
    });
    expect(blocks[1]).not.toHaveProperty("cache_control");
    expect(input).toEqual([{ role: "user", content: "Explain tides." }]);
  });

  test("appends to array content without moving or copying cache_control", () => {
    const input = [
      {
        role: "user" as const,
        content: [
          { type: "text", text: "Look at this." },
          { type: "image", source: { type: "base64", data: "abc" } },
        ],
      },
    ];
    const withBreakpoint = withConversationCacheBreakpoint(input);
    const result = appendTurnContext(withBreakpoint, "TIMING: 10 minutes remain.");
    const blocks = result[0].content;

    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({
      type: "image",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[2]).toEqual({
      type: "text",
      text: TURN_CONTEXT_PREFIX + "TIMING: 10 minutes remain.",
    });
    expect(blocks[2]).not.toHaveProperty("cache_control");
    expect(input[0].content).toHaveLength(2);
    expect(input[0].content[1]).not.toHaveProperty("cache_control");
  });

  test("returns unchanged content when there is no user message", () => {
    const input = [{ role: "assistant" as const, content: "Only assistant." }];
    const result = appendTurnContext(input, "Current date and time: now");
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

describe("injectPendingWhisper", () => {
  test("no whisper → array unchanged", () => {
    const msgs = [{ role: "user", content: "hi" }];
    injectPendingWhisper(msgs, null);
    expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  });

  test("inserts a private whisper message before the last user turn", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    injectPendingWhisper(msgs, "nudge toward estimation");
    expect(msgs).toHaveLength(4);
    // Inserted at index 2 (before the last user message "second").
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toContain("TEACHER WHISPER");
    expect(msgs[2].content).toContain("nudge toward estimation");
    expect(msgs[3].content).toBe("second");
  });

  test("no user message → no insertion", () => {
    const msgs = [{ role: "assistant", content: "only assistant" }];
    injectPendingWhisper(msgs, "whisper");
    expect(msgs).toHaveLength(1);
  });
});
