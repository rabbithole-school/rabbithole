import { afterEach, describe, expect, test, vi } from "vitest";
import {
  sseEvent,
  parseSessionStreamBody,
  buildTutorSystemPrompt,
  buildTutorSystemPromptParts,
  injectPendingWhisper,
  magicAnnotationSystemPrompt,
  rubricCheckInstruction,
  kickoffInstruction,
  bloomFromFloat,
  mapObserverResultToDetailed,
  type TutorPromptContext,
} from "../sessionStreamHelpers";
import type { ObserverResult } from "../lib/observerShared";
import { buildSystemPrompt } from "../sessionHelpers";

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

describe("parseSessionStreamBody", () => {
  test("extracts sessionId + assistantMsgId, ignoring streamId", () => {
    expect(
      parseSessionStreamBody({ sessionId: "p1", streamId: "s1", assistantMsgId: "a1" }),
    ).toEqual({ sessionId: "p1", assistantMsgId: "a1", platform: "web" });
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

  test("a normal message body has no rubricCheck", () => {
    expect(
      parseSessionStreamBody({ sessionId: "p1", assistantMsgId: "a1" }).rubricCheck,
    ).toBeUndefined();
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

describe("rubricCheckInstruction", () => {
  test("is explicitly flagged as NOT a scholar-typed message (honesty)", () => {
    const out = rubricCheckInstruction("My Report");
    expect(out).toContain("NOT a message the scholar typed");
    expect(out).toContain("Check my work");
  });

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
  test("stable + dynamic is byte-identical to the full prompt", () => {
    const { stable, dynamic } = buildTutorSystemPromptParts(baseCtx);
    expect(stable + dynamic).toBe(buildTutorSystemPrompt(baseCtx));
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
    const { stable, dynamic } = buildTutorSystemPromptParts(rich);
    expect(stable + dynamic).toBe(buildTutorSystemPrompt(rich));
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

  // Regression for BOTH cache-busters that used to live inside the cached
  // prefix (sections 0..STABLE_LEADING_SECTIONS-1):
  //   1. the SESSION CONTEXT gap string (sections[3]) — fixed by anchoring the
  //      gap to sessionCreatedAt instead of Date.now();
  //   2. the "Current date and time" clock line (formerly embedded in
  //      buildBasePrompt) — fixed by moving it to buildClockLine, emitted as the
  //      FIRST dynamic section.
  // With both fixed, `stable` is byte-identical across wall-clock time for
  // FIXED session state, so no normalization is needed here — assert RAW
  // equality. Deliberately NOT covered (known, accepted one-time re-caches, not
  // per-turn churn — each re-bills the prefix once and then re-caches):
  //   - the turn-1→turn-2 flip of isFirstTurn/introduceNonHuman (sections 0/1/3
  //     and the angle-kickoff tool),
  //   - set_activity_angle disappearing from the tool set once an angle is
  //     chosen (tools precede system in the cache prefix),
  //   - the school-day boundary flipping physicalEnvironmentContext +
  //     suggest_physical_task (a deliberate fail-closed product gate on
  //     Date.now() in getSessionContext; at most one flip per boundary).
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

  test("stable prefix is byte-identical (raw) across turns despite a moving wall clock", () => {
    vi.useFakeTimers();
    // Turn 1: the wall clock is at the session's start.
    vi.setSystemTime(sessionCreatedAt);
    const first = buildTutorSystemPromptParts(returningCtx);

    // Turn N: 90 minutes later — enough to (a) cross formatSessionGap buckets
    // (3h → 5h) had the gap been anchored to Date.now(), and (b) advance the
    // minute-granularity clock line had it still been in the cached prefix.
    vi.setSystemTime(sessionCreatedAt + 90 * 60 * 1000);
    const later = buildTutorSystemPromptParts(returningCtx);

    // RAW byte equality — no clock normalization.
    expect(later.stable).toBe(first.stable);
    // Guard: the gap string really is in the cached prefix (so this exercises
    // the at-risk bytes), while the clock line is NOT (it moved to the tail).
    expect(first.stable).toContain("SESSION CONTEXT:");
    expect(first.stable).toContain("their last session was about 3 hours ago");
    expect(first.stable).not.toContain("Current date and time:");
    // …and the clock line is present, just in the per-turn dynamic tail.
    expect(later.dynamic).toContain("Current date and time:");
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

describe("magicAnnotationSystemPrompt", () => {
  test("augments the base prompt with the magic-annotation reaction guidance", () => {
    const out = magicAnnotationSystemPrompt("BASE PROMPT", "a soaring dragon");
    expect(out.startsWith("BASE PROMPT")).toBe(true);
    expect(out).toContain("[MAGIC ANNOTATION]");
    expect(out).toContain("a soaring dragon");
    expect(out).toContain("Do NOT call generate_image");
  });
});

describe("bloomFromFloat", () => {
  test("maps each band at its boundary", () => {
    expect(bloomFromFloat(5)).toBe("create");
    expect(bloomFromFloat(4.5)).toBe("create");
    expect(bloomFromFloat(4.49)).toBe("evaluate");
    expect(bloomFromFloat(3.5)).toBe("evaluate");
    expect(bloomFromFloat(2.5)).toBe("analyze");
    expect(bloomFromFloat(1.5)).toBe("apply");
    expect(bloomFromFloat(0.5)).toBe("understand");
    expect(bloomFromFloat(0.49)).toBe("remember");
    expect(bloomFromFloat(0)).toBe("remember");
  });
});

describe("mapObserverResultToDetailed", () => {
  const pulse = {
    engagementScore: 0.8,
    complexityLevel: 0.7,
    onTaskScore: 0.9,
    topics: ["bridges", "forces"],
    learningIndicators: [],
    concernFlags: [],
    summary: "Solid build session",
    pulseScore: 4,
  };
  const obs = (conceptLabel: string, masteryLevel: number) => ({
    conceptLabel,
    domain: "physics",
    masteryLevel,
    confidenceScore: 0.8,
    evidenceSummary: "e",
    evidenceType: "direct_demonstration",
    attemptContext: "conversation",
    studentInitiated: false,
    transcriptExcerpt: "x",
  });

  test("null → null", () => {
    expect(mapObserverResultToDetailed(null)).toBeNull();
  });

  test("no observations → remember + placeholder description", () => {
    const result: ObserverResult = {
      pulse,
      observations: [],
      sessionSignals: [],
      crossDomainConnections: [],
      seeds: [],
    };
    const detailed = mapObserverResultToDetailed(result);
    expect(detailed?.summary).toBe("Solid build session");
    expect(detailed?.topics).toEqual(["bridges", "forces"]);
    expect(detailed?.bloomLevel).toBe("remember");
    expect(detailed?.bloomDescription).toBe("No observations yet");
  });

  test("bloomLevel from the max mastery; description is top-3 desc; input unmutated", () => {
    const observations = [obs("tension", 2.0), obs("compression", 3.6), obs("load", 1.0), obs("span", 0.5)];
    const result: ObserverResult = {
      pulse,
      observations,
      sessionSignals: [],
      crossDomainConnections: [],
      seeds: [
        { suggestionType: "depth_probe", topic: "trusses", rationale: "push deeper" },
        { suggestionType: "frontier", topic: "suspension", rationale: "new frontier" },
      ],
    };
    const detailed = mapObserverResultToDetailed(result);
    expect(detailed?.bloomLevel).toBe("evaluate"); // 3.6 → evaluate
    expect(detailed?.bloomDescription).toBe(
      "compression: 3.6, tension: 2.0, load: 1.0",
    );
    expect(detailed?.nudges).toEqual([
      { type: "challenge", message: "push deeper" },
    ]);
    expect(detailed?.suggestedFollowUps).toEqual([
      { topic: "suspension", rationale: "new frontier" },
    ]);
    // The mapper must not reorder the caller's observations array.
    expect(observations.map((o) => o.conceptLabel)).toEqual([
      "tension",
      "compression",
      "load",
      "span",
    ]);
  });
});
