import { describe, expect, test } from "vitest";

import {
  commitResolvedRoomSelection,
  type RequestedRoom,
} from "./roomAppState";

describe("commitResolvedRoomSelection", () => {
  const current: RequestedRoom<string, string> = {
    artifactId: "artifact-current",
    roomId: "room-current",
  };

  test("keeps the committed room when the resolver rejects a raw ID", () => {
    expect(
      commitResolvedRoomSelection(current, "artifact-current", null),
    ).toBe(current);
    expect(
      commitResolvedRoomSelection(null, "artifact-current", null),
    ).toBeNull();
  });

  test("commits only the resolver-returned room ID", () => {
    expect(
      commitResolvedRoomSelection(current, "artifact-next", "room-authorized"),
    ).toEqual({
      artifactId: "artifact-next",
      roomId: "room-authorized",
    });
  });
});
