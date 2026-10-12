import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { serverErrorMessage } from "./serverErrorMessage";

describe("serverErrorMessage", () => {
  test("a ConvexError's sentence is the message, framing and all ignored", () => {
    const error = new ConvexError('Username "kai" is already taken');
    error.message =
      '[CONVEX M(users:adminUpdateScholarProfile)] [Request ID: 1a2b] Server Error\nUncaught ConvexError: Username "kai" is already taken\n    at handler (../convex/users.ts:1:1)';
    expect(serverErrorMessage(error, "fallback")).toBe(
      'Username "kai" is already taken',
    );
  });

  test("a development Error keeps its sentence", () => {
    const error = new Error(
      "[CONVEX M(users:adminUpdateScholarProfile)] [Request ID: 1a2b] Server Error\nUncaught Error: Name cannot be empty\n    at handler (../convex/users.ts:1:1)",
    );
    expect(serverErrorMessage(error, "fallback")).toBe("Name cannot be empty");
  });

  // Production redacts a plain Error to this shape; showing it to staff says
  // nothing a generic "try again" doesn't, in worse words.
  test("a production-redacted Error shows the caller's fallback instead of the framing", () => {
    const redacted =
      "[CONVEX M(users:adminUpdateScholarProfile)] [Request ID: 1a2b] Server Error";
    expect(
      serverErrorMessage(new Error(redacted), "Couldn't save. Try again."),
    ).toBe("Couldn't save. Try again.");
    // No fallback: keep the framing, so an `{error && …}` caller still shows
    // that something failed rather than going silent.
    expect(serverErrorMessage(new Error(redacted))).toBe(redacted);
  });

  test("anything else passes through", () => {
    expect(serverErrorMessage(new Error("Failed to fetch"), "fallback")).toBe(
      "Failed to fetch",
    );
  });
});
