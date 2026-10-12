import { describe, expect, test } from "vitest";
import { collectOpaqueIds, repairOpaqueLinks } from "../opaqueLinkRepair";

const REAL_ID = "1pmWxLw3gMjopx98lPeS-PTTOX5yTlVv7nFrOhceJtn4";
const TRANSPOSED_ID = "1pmXwLw3gMjopx98lPeS-PTTOX5yTlVv7nFrOhceJtn4";

describe("collectOpaqueIds", () => {
  test("extracts supported Google document and Drive ids", () => {
    expect(
      collectOpaqueIds(
        [
          `https://docs.google.com/document/d/${REAL_ID}/edit`,
          `https://docs.google.com/presentation/d/${REAL_ID}/edit`,
          `https://docs.google.com/spreadsheets/d/${REAL_ID}/edit`,
          `https://docs.google.com/forms/d/${REAL_ID}/edit`,
          `https://drive.google.com/file/d/${REAL_ID}/view`,
          `https://drive.google.com/drive/folders/${REAL_ID}`,
        ].join("\n"),
      ),
    ).toEqual(Array(6).fill(REAL_ID));
  });
});

describe("repairOpaqueLinks", () => {
  test("repairs the real adjacent-transposition case", () => {
    expect(
      repairOpaqueLinks(
        `Open https://docs.google.com/document/d/${TRANSPOSED_ID}/edit`,
        [REAL_ID],
      ),
    ).toBe(`Open https://docs.google.com/document/d/${REAL_ID}/edit`);
  });

  test("repairs a URL inside Slack link markup without changing its label", () => {
    expect(
      repairOpaqueLinks(
        `<https://docs.google.com/document/d/${TRANSPOSED_ID}/edit|Unit plan>`,
        [REAL_ID],
      ),
    ).toBe(`<https://docs.google.com/document/d/${REAL_ID}/edit|Unit plan>`);
  });

  test("leaves an exact known id untouched", () => {
    const text = `https://docs.google.com/document/d/${REAL_ID}/edit`;
    expect(repairOpaqueLinks(text, [REAL_ID])).toBe(text);
  });

  test("leaves an id at distance three untouched", () => {
    const distantId = `ZZZ${REAL_ID.slice(3)}`;
    const text = `https://docs.google.com/document/d/${distantId}/edit`;
    expect(repairOpaqueLinks(text, [REAL_ID])).toBe(text);
  });

  test("leaves an ambiguous near-match untouched", () => {
    const otherCandidate = `2${TRANSPOSED_ID.slice(1)}`;
    const text = `https://docs.google.com/document/d/${TRANSPOSED_ID}/edit`;
    expect(repairOpaqueLinks(text, [REAL_ID, otherCandidate])).toBe(text);
  });

  test("returns the original text when no ids are known", () => {
    const text = `https://docs.google.com/document/d/${TRANSPOSED_ID}/edit`;
    expect(repairOpaqueLinks(text, [])).toBe(text);
  });

  test("does not touch non-Google URLs", () => {
    const text = `https://example.com/document/d/${TRANSPOSED_ID}/edit`;
    expect(repairOpaqueLinks(text, [REAL_ID])).toBe(text);
  });

  test("repairs presentation and Drive file URL shapes", () => {
    const text = [
      `https://docs.google.com/presentation/d/${TRANSPOSED_ID}/edit`,
      `https://drive.google.com/file/d/${TRANSPOSED_ID}/view`,
    ].join("\n");
    expect(repairOpaqueLinks(text, [REAL_ID])).toBe(
      [
        `https://docs.google.com/presentation/d/${REAL_ID}/edit`,
        `https://drive.google.com/file/d/${REAL_ID}/view`,
      ].join("\n"),
    );
  });
});
