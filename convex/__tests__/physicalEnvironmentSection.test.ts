import { describe, expect, test } from "vitest";
import {
  buildPhysicalEnvironmentSection,
  type PhysicalEnvironmentContext,
} from "../prompts";
import { buildSystemPromptParts } from "../sessionHelpers";

// The physical-environment section turns curated rooms + equipment into the
// tutor's invitation to send scholars on embodied tasks. These tests pin the
// safety-critical filtering + phrasing (teacher_only never surfaces, adult
// gear is framed as "ask your teacher", safety notes are verbatim) and that it
// lands in the CACHED stable prefix of the assembled prompt.

const bells = {
  name: "Set of hand bells",
  spaceName: "Music Room",
  category: "musical",
  description: "one octave",
  quantity: "8 bells (C–C)",
  supervision: "none" as const,
  safetyNotes: null,
  usageIdeas: ["Ring two together and describe what you hear."],
};

function ctx(
  overrides: Partial<PhysicalEnvironmentContext> = {},
): PhysicalEnvironmentContext {
  return {
    spaces: [{ name: "Music Room", kind: "music", description: null }],
    equipment: [bells],
    ...overrides,
  };
}

describe("buildPhysicalEnvironmentSection", () => {
  test("null / empty context → no section", () => {
    expect(buildPhysicalEnvironmentSection(null)).toBeNull();
    expect(
      buildPhysicalEnvironmentSection({ spaces: [], equipment: [] }),
    ).toBeNull();
  });

  test("lists gear under its room with quantity + description + task ideas", () => {
    const section = buildPhysicalEnvironmentSection(ctx())!;
    expect(section).toContain("Music Room");
    expect(section).toContain("Set of hand bells");
    expect(section).toContain("8 bells (C–C)");
    expect(section).toContain("Ring two together");
    // The anti-offloading contract is stated.
    expect(section).toContain("what did you notice");
    expect(section).toMatch(/never.*result they're meant to discover/i);
    // Phase 2: the tutor is told to render the task as a card via the tool.
    expect(section).toContain("suggest_physical_task");
  });

  test("teacher_only gear is NEVER surfaced (belt-and-suspenders)", () => {
    const section = buildPhysicalEnvironmentSection(
      ctx({
        equipment: [
          { ...bells, name: "Table saw", supervision: "teacher_only" },
        ],
      }),
    );
    // Only teacher_only gear → nothing suggestable → whole section omitted.
    expect(section).toBeNull();

    const mixed = buildPhysicalEnvironmentSection(
      ctx({
        equipment: [
          bells,
          { ...bells, name: "Table saw", supervision: "teacher_only" },
        ],
      }),
    )!;
    expect(mixed).toContain("Set of hand bells");
    expect(mixed).not.toContain("Table saw");
  });

  test("adult_present gear is framed as asking a teacher, and safety notes are verbatim", () => {
    const section = buildPhysicalEnvironmentSection(
      ctx({
        equipment: [
          {
            ...bells,
            name: "Balance scale",
            supervision: "adult_present",
            safetyNotes: "Small masses are a choking hazard.",
          },
        ],
      }),
    )!;
    expect(section).toContain("ask your teacher to help you");
    expect(section).toContain("Small masses are a choking hazard.");
  });

  test("gear with no room falls under 'Elsewhere in the school'", () => {
    const section = buildPhysicalEnvironmentSection({
      spaces: [],
      equipment: [{ ...bells, spaceName: null }],
    })!;
    expect(section).toContain("Elsewhere in the school");
    expect(section).toContain("Set of hand bells");
  });
});

describe("physical environment lands in the cached stable prefix", () => {
  // Positional call: only scholarName + the physicalEnvironmentContext
  // (second-to-last param, before the trailing goalsContext) are set;
  // everything between is null/default.
  function parts(physical: PhysicalEnvironmentContext | null) {
    return buildSystemPromptParts(
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
      null, // lessonContext
      null, // teacherDirectives
      null, // lessonActivityContext
      null, // priorActivityContext
      null, // activityContext
      null, // standaloneDeliverableContext
      null, // currentVerdictsContext
      false, // isFirstTurn
      false, // isFirstSession
      null, // lastSessionAt
      null, // webPracticeContext
      null, // granuleStatusContext
      null, // activityRecipe
      null, // baselineEvidenceContext
      null, // seedOriginContext
      null, // documentNotes
      null, // advanceRubricContext
      null, // practiceSkillsContext
      physical, // physicalEnvironmentContext
    );
  }

  test("the section is in `stable` (cached), not `dynamic`", () => {
    const { stable, dynamic } = parts(ctx());
    expect(stable).toContain("PHYSICAL ENVIRONMENT");
    expect(stable).toContain("Set of hand bells");
    expect(dynamic).not.toContain("PHYSICAL ENVIRONMENT");
  });

  test("no inventory → byte-identical to omitting it entirely", () => {
    const withNull = parts(null);
    const withEmpty = parts({ spaces: [], equipment: [] });
    expect(withNull.stable).toBe(withEmpty.stable);
    expect(withNull.dynamic).toBe(withEmpty.dynamic);
    expect(withNull.stable).not.toContain("PHYSICAL ENVIRONMENT");
  });
});
