import { describe, expect, it } from "vitest";

import type { Id } from "@/lib/convex";
import { selectCodeArtifactStateScope } from "../codeArtifactStateScope";

describe("code artifact state scope", () => {
  it("selects session state with rooms and tutor action results", () => {
    const artifactId = "artifact-1" as Id<"artifacts">;

    expect(
      selectCodeArtifactStateScope({ kind: "session", artifactId }),
    ).toEqual({
      kind: "session",
      identity: "artifact-1",
      artifactId,
      customAppArgs: null,
      supportsRooms: true,
      supportsActionResults: true,
    });
  });

  it("selects token-partitioned custom-app state without session features", () => {
    expect(
      selectCodeArtifactStateScope({
        kind: "customApp",
        token: "token-1",
        stateUserId: "anon:device-1",
        stateKey: "default",
      }),
    ).toEqual({
      kind: "customApp",
      identity: "customApp:token-1",
      artifactId: null,
      customAppArgs: {
        token: "token-1",
        userId: "anon:device-1",
        key: "default",
      },
      supportsRooms: false,
      supportsActionResults: false,
    });
  });
});
