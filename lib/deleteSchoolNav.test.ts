import { describe, expect, test } from "vitest";
import { postDeleteRedirect, SCHOOL_DELETED_ROUTE } from "./deleteSchoolNav";

describe("postDeleteRedirect", () => {
  test("self-deletion lands on the unauthenticated confirmation page", () => {
    expect(
      postDeleteRedirect({ deletingSelf: true, isPlatformAdmin: false }),
    ).toBe(SCHOOL_DELETED_ROUTE);
  });

  test("self-deletion wins even for a platform admin (their own account went too)", () => {
    expect(
      postDeleteRedirect({ deletingSelf: true, isPlatformAdmin: true }),
    ).toBe(SCHOOL_DELETED_ROUTE);
  });

  test("platform admin deleting another school returns to the Institutions console", () => {
    expect(
      postDeleteRedirect({ deletingSelf: false, isPlatformAdmin: true }),
    ).toBe("/admin/institutions");
  });

  test("non-platform admin deleting a non-self school returns home", () => {
    expect(
      postDeleteRedirect({ deletingSelf: false, isPlatformAdmin: false }),
    ).toBe("/");
  });

  test("the confirmation route is same-origin and unauthenticated-safe", () => {
    expect(SCHOOL_DELETED_ROUTE.startsWith("/")).toBe(true);
    expect(SCHOOL_DELETED_ROUTE.startsWith("//")).toBe(false);
  });
});
