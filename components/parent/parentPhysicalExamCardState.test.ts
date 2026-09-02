import { describe, expect, test } from "vitest";

import {
  describePhysicalExam,
  type PhysicalExamDocument,
} from "./parentPhysicalExamCardState";

const formatDate = () => "Aug 18, 2026";

const onFile: PhysicalExamDocument = {
  fileName: "physical.pdf",
  uploadedAt: 1_755_500_000_000,
  url: "https://files.test/physical.pdf",
  reviewStatus: null,
  reviewNote: null,
  uploadedByStaff: false,
};

describe("describePhysicalExam", () => {
  test("nothing on file asks for the first upload", () => {
    expect(describePhysicalExam(null, formatDate)).toEqual({
      complete: false,
      subtitle: "Not uploaded.",
      note: null,
      actionLabel: "Upload document",
      actionVariant: "solid",
    });
  });

  test("awaiting review says the school is looking at it", () => {
    expect(describePhysicalExam(onFile, formatDate)).toEqual({
      complete: false,
      subtitle: "Uploaded Aug 18, 2026. The school is reviewing it.",
      note: null,
      actionLabel: "Replace document",
      actionVariant: "ghost",
    });
  });

  test("accepted reads as a completed form", () => {
    expect(
      describePhysicalExam({ ...onFile, reviewStatus: "accepted" }, formatDate),
    ).toEqual({
      complete: true,
      subtitle: "Uploaded Aug 18, 2026.",
      note: null,
      actionLabel: "Replace document",
      actionVariant: "ghost",
    });
  });

  test("a staff upload says who put it on file", () => {
    expect(
      describePhysicalExam(
        { ...onFile, reviewStatus: "accepted", uploadedByStaff: true },
        formatDate,
      ).subtitle,
    ).toBe("Uploaded by the school Aug 18, 2026.");
  });

  test("needs_replacement surfaces the school's note and a solid action", () => {
    expect(
      describePhysicalExam(
        {
          ...onFile,
          reviewStatus: "needs_replacement",
          reviewNote: "The physician's signature is missing.",
        },
        formatDate,
      ),
    ).toEqual({
      complete: false,
      subtitle: "The school asked for a new document.",
      note: "School note: The physician's signature is missing.",
      actionLabel: "Upload a new document",
      actionVariant: "solid",
    });
  });

  test("needs_replacement without a note omits the note line", () => {
    expect(
      describePhysicalExam(
        { ...onFile, reviewStatus: "needs_replacement" },
        formatDate,
      ).note,
    ).toBeNull();
  });
});
