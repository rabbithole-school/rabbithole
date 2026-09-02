import { describe, expect, test } from "vitest";

import { formReminderUrl } from "../formReminderEmail";

describe("form reminder email", () => {
  test("links a single form using the scholarId parameter its page reads", () => {
    expect(
      formReminderUrl({
        siteUrl: "https://rabbithole.test",
        scholarId: "scholar-1",
        forms: [{ formPath: "/parent/forms/annual-program-participation" }],
      }),
    ).toBe(
      "https://rabbithole.test/parent/forms/annual-program-participation?scholarId=scholar-1",
    );
  });

  test("links multiple forms to the child-scoped records tab", () => {
    expect(
      formReminderUrl({
        siteUrl: "https://rabbithole.test",
        scholarId: "scholar-1",
        forms: [
          { formPath: "/parent/health-form" },
          { formPath: "/parent/forms/annual-program-participation" },
        ],
      }),
    ).toBe("https://rabbithole.test/parent/records?child=scholar-1");
  });
});
