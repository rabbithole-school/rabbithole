// Pure unit tests for canAccessSession — the gate behind the hardened
// /project-stream and /analyze HTTP endpoints. No convex-test needed:
// it's a pure (role, callerId, ownerId) → boolean decision. This is the
// single rule that decides who may stream a tutor session or trigger
// observer analysis, so pin every role explicitly.

import { describe, expect, test } from "vitest";
import { canAccessSession } from "../lib/auth";
import type { Doc, Id } from "../_generated/dataModel";

const OWNER = "owner_scholar" as Id<"users">;
const OTHER = "other_user" as Id<"users">;

function user(id: Id<"users">, role: Doc<"users">["role"]) {
  return { _id: id, role } as Pick<Doc<"users">, "_id" | "role">;
}

describe("canAccessSession", () => {
  test("the owner scholar can access their own project", () => {
    expect(canAccessSession(user(OWNER, "scholar"), OWNER)).toBe(true);
  });

  test("a different scholar CANNOT access someone else's project", () => {
    expect(canAccessSession(user(OTHER, "scholar"), OWNER)).toBe(false);
  });

  test("a teacher can access any project (remote view-as / observer)", () => {
    expect(canAccessSession(user(OTHER, "teacher"), OWNER)).toBe(true);
  });

  test("an admin can access any project", () => {
    expect(canAccessSession(user(OTHER, "platform_admin"), OWNER)).toBe(true);
  });

  test("operations staff (base staff role) CANNOT access a project (no transcripts / observer)", () => {
    expect(canAccessSession(user(OTHER, "staff"), OWNER)).toBe(false);
  });

  test("a curriculum designer CANNOT access a project", () => {
    expect(canAccessSession(user(OTHER, "curriculum_designer"), OWNER)).toBe(false);
  });

  test("a teacher who happens to be the owner (test-drive) can access", () => {
    expect(canAccessSession(user(OWNER, "teacher"), OWNER)).toBe(true);
  });
});
