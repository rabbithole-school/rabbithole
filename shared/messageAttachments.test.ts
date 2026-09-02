import { describe, expect, test } from "vitest";

import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_COUNT,
  MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  safeMessageAttachmentFileName,
  validateMessageAttachmentFile,
  validateMessageAttachmentSelection,
} from "./messageAttachments";

describe("message attachment policy", () => {
  test.each([
    ["image/jpeg", "family-photo.jpg"],
    ["image/heic", "family-photo.heic"],
    ["application/pdf", "field-notes.pdf"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "field-notes.docx",
    ],
    ["", "field-notes.md"],
  ])("accepts %s %s", (type, name) => {
    expect(
      validateMessageAttachmentFile({ name, type, size: 1_024 }),
    ).toBeNull();
  });

  test("rejects empty, unsupported, and oversized files", () => {
    expect(
      validateMessageAttachmentFile({
        name: "empty.pdf",
        type: "application/pdf",
        size: 0,
      }),
    ).toMatch(/non-empty/i);
    expect(
      validateMessageAttachmentFile({
        name: "archive.zip",
        type: "application/zip",
        size: 1_024,
      }),
    ).toMatch(/photo, PDF, text file, or Word document/i);
    expect(
      validateMessageAttachmentFile({
        name: "large.pdf",
        type: "application/pdf",
        size: MESSAGE_ATTACHMENT_MAX_BYTES + 1,
      }),
    ).toMatch(/25 MB/i);
  });

  test("caps both file count and aggregate email size", () => {
    const file = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 1_024,
    };
    expect(
      validateMessageAttachmentSelection(
        MESSAGE_ATTACHMENT_MAX_COUNT,
        [file],
      ),
    ).toMatch(/no more than/i);
    expect(
      validateMessageAttachmentSelection(
        1,
        [file],
        MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES,
      ),
    ).toMatch(/30 MB/i);
  });

  test("stores a bounded basename", () => {
    expect(safeMessageAttachmentFileName("../../field-notes.pdf")).toBe(
      "field-notes.pdf",
    );
    expect(
      safeMessageAttachmentFileName(`\u0000${"x".repeat(250)}.pdf`),
    ).toHaveLength(200);
  });
});
