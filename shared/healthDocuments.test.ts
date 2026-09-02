import { describe, expect, test } from "vitest";

import {
  HEALTH_DOCUMENT_MAX_BYTES,
  removeHealthDocumentFile,
  safeHealthDocumentFileName,
  selectHealthDocumentFiles,
  validateHealthDocumentFile,
} from "./healthDocuments";

describe("health document selection", () => {
  test.each([
    ["application/pdf", "record.pdf"],
    ["image/jpeg", "record.jpg"],
    ["image/jpeg", "record.jpeg"],
    ["image/png", "record.png"],
  ])("accepts %s with a matching extension", (type, name) => {
    expect(validateHealthDocumentFile({ name, type, size: 1_024 })).toBeNull();
  });

  test("rejects unsupported, oversized, empty, and mismatched files", () => {
    expect(
      validateHealthDocumentFile({
        name: "record.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 1_024,
      }),
    ).toMatch(/PDF, JPEG, or PNG/i);
    expect(
      validateHealthDocumentFile({
        name: "record.pdf",
        type: "application/pdf",
        size: HEALTH_DOCUMENT_MAX_BYTES + 1,
      }),
    ).toMatch(/10 MB/i);
    expect(
      validateHealthDocumentFile({
        name: "record.pdf",
        type: "application/pdf",
        size: 0,
      }),
    ).toMatch(/non-empty/i);
    expect(
      validateHealthDocumentFile({
        name: "record.png",
        type: "application/pdf",
        size: 1_024,
      }),
    ).toMatch(/extension/i);
  });

  test("stores only a bounded basename", () => {
    expect(safeHealthDocumentFileName("../../fictional-record.pdf")).toBe(
      "fictional-record.pdf",
    );
    expect(safeHealthDocumentFileName(`\u0000${"x".repeat(250)}.pdf`)).toHaveLength(
      200,
    );
  });

  test("keeps the current selection when camera capture is cancelled", () => {
    const current = [
      { name: "page-1.jpg", type: "image/jpeg", size: 1_024 },
    ];
    expect(selectHealthDocumentFiles(current, [], "camera")).toEqual({
      files: current,
      error: null,
      changed: false,
    });
  });

  test("applies the same format and size validation to camera and file choices", () => {
    const unsupported = {
      name: "record.heic",
      type: "image/heic",
      size: 1_024,
    };
    const oversized = {
      name: "record.jpg",
      type: "image/jpeg",
      size: HEALTH_DOCUMENT_MAX_BYTES + 1,
    };

    expect(selectHealthDocumentFiles([], [unsupported], "camera").error).toMatch(
      /PDF, JPEG, or PNG/i,
    );
    expect(selectHealthDocumentFiles([], [unsupported], "file").error).toMatch(
      /PDF, JPEG, or PNG/i,
    );
    expect(selectHealthDocumentFiles([], [oversized], "camera").error).toMatch(
      /10 MB/i,
    );
    expect(selectHealthDocumentFiles([], [oversized], "file").error).toMatch(
      /10 MB/i,
    );
  });

  test("appends photographed pages and replaces them with a file selection", () => {
    const first = { name: "page-1.jpg", type: "image/jpeg", size: 1_024 };
    const second = { name: "page-2.png", type: "image/png", size: 2_048 };
    const pdf = { name: "record.pdf", type: "application/pdf", size: 4_096 };

    const photographed = selectHealthDocumentFiles([first], [second], "camera");
    expect(photographed).toEqual({
      files: [first, second],
      error: null,
      changed: true,
    });
    expect(selectHealthDocumentFiles(photographed.files, [pdf], "file")).toEqual(
      {
        files: [pdf],
        error: null,
        changed: true,
      },
    );
    expect(removeHealthDocumentFile(photographed.files, 0)).toEqual([second]);
  });

  test("accepts multiple image pages but never mixes a PDF with other pages", () => {
    const pages = [
      { name: "page-1.jpg", type: "image/jpeg", size: 1_024 },
      { name: "page-2.png", type: "image/png", size: 2_048 },
    ];
    expect(selectHealthDocumentFiles([], pages, "file")).toMatchObject({
      files: pages,
      error: null,
      changed: true,
    });
    expect(
      selectHealthDocumentFiles(
        [],
        [
          pages[0],
          { name: "record.pdf", type: "application/pdf", size: 1_024 },
        ],
        "file",
      ).error,
    ).toMatch(/one PDF or one or more/i);
    expect(
      selectHealthDocumentFiles(
        [],
        [
          { ...pages[0], size: 6 * 1024 * 1024 },
          { ...pages[1], size: 5 * 1024 * 1024 },
        ],
        "file",
      ).error,
    ).toMatch(/combined image pages.*10 MB/i);
  });
});
