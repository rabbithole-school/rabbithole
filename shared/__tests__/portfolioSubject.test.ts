import { describe, expect, test } from "vitest";
import {
  itemInPortfolioSubject,
  itemIsOtherWork,
  portfolioSubjectSegment,
  portfolioSubjectSlug,
  subjectSlugFromSegment,
} from "../portfolioSubject";

describe("portfolio subject groups", () => {
  test("one slug per subject, whatever its case or punctuation", () => {
    expect(portfolioSubjectSlug("Art")).toBe("art");
    expect(portfolioSubjectSlug(" art ")).toBe("art");
    expect(portfolioSubjectSlug("Art & Design")).toBe("art-design");
    expect(portfolioSubjectSlug("   ")).toBe("");
  });

  test("ʻokina and macrons fold away instead of breaking the word", () => {
    expect(portfolioSubjectSlug("ʻŌlelo Hawaiʻi")).toBe("olelo-hawaii");
    expect(portfolioSubjectSlug("'Olelo Hawai'i")).toBe("olelo-hawaii");
    expect(portfolioSubjectSlug("Español")).toBe("espanol");
  });

  test("a subject with nothing to slug still gets its own stable group", () => {
    const math = portfolioSubjectSlug("数学");
    expect(math).toMatch(/^s[0-9a-z]+$/);
    expect(portfolioSubjectSlug(" 数学 ")).toBe(math);
    expect(portfolioSubjectSlug("科学")).not.toBe(math);
    expect(subjectSlugFromSegment(portfolioSubjectSegment("数学"))).toBe(math);
  });

  test("a subject segment round-trips; a course id or `other` is not one", () => {
    expect(portfolioSubjectSegment("Studio Art")).toBe("subject-studio-art");
    expect(subjectSlugFromSegment("subject-studio-art")).toBe("studio-art");
    expect(subjectSlugFromSegment("subject-")).toBeNull();
    expect(subjectSlugFromSegment("other")).toBeNull();
    expect(subjectSlugFromSegment(null)).toBeNull();
  });

  test("course work never lands on a subject page or Other work", () => {
    const courseWork = { courseId: "group1", subject: null };
    const artWork = { courseId: null, subject: "Art" };
    const unknownWork = { courseId: null, subject: null };
    expect(itemInPortfolioSubject(artWork, "art")).toBe(true);
    expect(itemInPortfolioSubject(artWork, "math")).toBe(false);
    expect(itemInPortfolioSubject(courseWork, "art")).toBe(false);
    expect(itemIsOtherWork(unknownWork)).toBe(true);
    expect(itemIsOtherWork(artWork)).toBe(false);
    expect(itemIsOtherWork(courseWork)).toBe(false);
  });
});
