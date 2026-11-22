import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("native scholar birthday banner wiring", () => {
  const source = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");

  it("derives the greeting from the resolved institution day", () => {
    expect(source).toContain("scholarBirthdayAcknowledgement(");
    expect(source).toContain("me?.dateOfBirth");
    expect(source).toContain("institutionDay.dayKey");
  });

  it("renders the banner, keeps the existing confetti, and has no header marker", () => {
    expect(source).toContain("birthdayAcknowledgement.bannerText");
    expect(source).toContain("<BirthdayConfetti active={isOwnBirthday}");
    expect(source).not.toContain("headerName");
  });
});
