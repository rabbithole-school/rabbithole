import { describe, expect, test, vi } from "vitest";
import SchoolSpaceRedirect from "./page";

vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

describe("/school-space", () => {
  test("redirects on the server to instructional materials", () => {
    expect(() => SchoolSpaceRedirect()).toThrow(
      "redirect:/school/instructional-materials",
    );
  });
});
