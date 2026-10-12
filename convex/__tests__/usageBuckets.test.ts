import { describe, expect, test } from "vitest";
import { bucketFor } from "../lib/usageReport";

describe("bucketFor", () => {
  test("scholar tutor spend stays in the Tutor row", () => {
    expect(bucketFor("tutor", "scholar")).toBe("tutor");
  });

  test("a teacher's test drive is staff spend, bucketed by who ran it", () => {
    expect(bucketFor("tutor-test-drive", "teacher")).toBe("teachers");
    expect(bucketFor("tutor-test-drive", "curriculum_designer")).toBe("teachers");
    expect(bucketFor("tutor-test-drive", "platform_admin")).toBe("platform-admin");
  });
});
