import { describe, expect, test } from "vitest";
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  institutionPromptProfile,
} from "../lib/institutionPromptProfile";
import { buildBasePrompt, buildClockLine } from "../prompts";

describe("Foundation institution prompt profile", () => {
  test("uses the neutral configured default for unknown and guest institutions", () => {
    expect(institutionPromptProfile(null)).toEqual(
      DEFAULT_INSTITUTION_PROMPT_PROFILE,
    );
    expect(
      institutionPromptProfile({
        name: "Guests",
        kind: "guest",
        isPrimary: false,
      }),
    ).toEqual(DEFAULT_INSTITUTION_PROMPT_PROFILE);
    expect(DEFAULT_INSTITUTION_PROMPT_PROFILE.schoolName).toBe("Rabbithole");
  });

  test("derives a named institution instead of borrowing the default identity", () => {
    const profile = institutionPromptProfile({
      name: "Kestrel Academy",
      kind: "school",
      isPrimary: false,
      timeZone: "America/New_York",
    });

    expect(profile.schoolName).toBe("Kestrel Academy");
    expect(profile.baseLocation).toBe("New York");
    expect(buildBasePrompt("Ana", false, profile)).toContain("Kestrel Academy");
    expect(buildBasePrompt("Ana", false)).toContain("Rabbithole");
    expect(buildClockLine()).toMatch(/ UTC$/);
  });
});
