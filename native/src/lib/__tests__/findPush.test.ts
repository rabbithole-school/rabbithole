import { describe, expect, it } from "vitest";

import { findPushEnvironment } from "../findPush";

describe("findPushEnvironment", () => {
  it("sends the metro dev client to the APNs sandbox", () => {
    expect(findPushEnvironment("school.rabbithole.metro")).toBe("development");
  });

  it("sends the Ad Hoc channel builds to production", () => {
    expect(findPushEnvironment("school.rabbithole")).toBe("production");
    expect(findPushEnvironment("school.rabbithole.canary")).toBe("production");
  });
});
