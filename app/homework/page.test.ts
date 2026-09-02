import { describe, expect, test, vi } from "vitest";
import HomeworkRedirect from "./page";

vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

describe("/homework", () => {
  test("redirects to the canonical scholar Home surface", () => {
    expect(() => HomeworkRedirect()).toThrow("redirect:/scholar");
  });
});
