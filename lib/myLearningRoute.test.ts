import { describe, expect, test, vi } from "vitest";
import ScholarMyLearningRedirect from "../app/scholar/my-learning/page";

vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

describe("/scholar/my-learning", () => {
  test("redirects to the canonical My Learning route instead of the session route", () => {
    expect(() => ScholarMyLearningRedirect()).toThrow("redirect:/me");
  });
});
