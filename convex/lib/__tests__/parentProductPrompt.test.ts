import { describe, expect, test, vi } from "vitest";

const profile = vi.hoisted(() => ({ technologyPageUrl: null as string | null }));
vi.mock("../primaryInstitutionPromptProfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../primaryInstitutionPromptProfile")>();
  return {
    PRIMARY_INSTITUTION_PROMPT_PROFILE: {
      ...actual.PRIMARY_INSTITUTION_PROMPT_PROFILE,
      get technologyPageUrl() {
        return profile.technologyPageUrl;
      },
    },
  };
});

import { parentProductPrompt } from "../parentAidePrompt";

describe("parentProductPrompt technology page", () => {
  test("a configured page closes the first-party facts", () => {
    profile.technologyPageUrl = "https://school.example/technology";
    const text = parentProductPrompt({ schoolName: "Example School", firstParty: true });
    expect(text).toContain(
      "\n- For more, including the tutor's published instructions: https://school.example/technology\nIf you use",
    );
  });

  test("no configured page leaves the line out, so no parent gets a borrowed link", () => {
    profile.technologyPageUrl = null;
    const text = parentProductPrompt({ schoolName: "Example School", firstParty: true });
    expect(text).toContain("At Example School it runs on a BunnyPad");
    expect(text).not.toContain("For more");
  });

  test("another school's parents never get it", () => {
    profile.technologyPageUrl = "https://school.example/technology";
    expect(parentProductPrompt({ schoolName: "Other School", firstParty: false })).not.toContain("For more");
  });
});
