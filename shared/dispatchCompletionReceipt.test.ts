import { describe, expect, test } from "vitest";
import {
  dedupeDispatchCompletionReceipts,
  dispatchCompletionReceiptCopy,
} from "./dispatchCompletionReceipt";

describe("dispatch completion receipt", () => {
  test("builds the locked math and work copy", () => {
    expect(dispatchCompletionReceiptCopy("Lehua Torres", "math")).toBe(
      "That was the math from Lehua Torres — done.",
    );
    expect(dispatchCompletionReceiptCopy("Lehua Torres", "work")).toBe(
      "That was the work from Lehua Torres — done.",
    );
  });

  test("keeps one ordered receipt per distinct assignment", () => {
    expect(
      dedupeDispatchCompletionReceipts([
        { assignmentId: "assignment-a", teacherName: "Lehua Torres" },
        { assignmentId: "assignment-a", teacherName: "Different name" },
        { assignmentId: "assignment-b", teacherName: "Avery Stone" },
      ]),
    ).toEqual([
      { assignmentId: "assignment-a", teacherName: "Lehua Torres" },
      { assignmentId: "assignment-b", teacherName: "Avery Stone" },
    ]);
  });
});
