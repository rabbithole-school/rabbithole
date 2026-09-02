import { describe, expect, test, vi } from "vitest";
import AdminInvitesRedirect from "./page";

vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

describe("/admin/invites", () => {
  test("redirects to the canonical institutions route", () => {
    expect(() => AdminInvitesRedirect()).toThrow(
      "redirect:/admin/institutions",
    );
  });
});
