import { describe, expect, test } from "vitest";
import { extractDriveFolderId } from "./driveFolderId";

const ID = "1tgK5CjC6AtUOe3N-WIzUMPNY4w1kKW0u";

describe("extractDriveFolderId", () => {
  test("accepts a bare id", () => {
    expect(extractDriveFolderId(ID)).toBe(ID);
    expect(extractDriveFolderId(`  ${ID}  `)).toBe(ID);
  });

  test("extracts from a folder-view URL", () => {
    expect(
      extractDriveFolderId(`https://drive.google.com/drive/folders/${ID}`)
    ).toBe(ID);
  });

  test("extracts from an account-scoped URL with query string", () => {
    expect(
      extractDriveFolderId(
        `https://drive.google.com/drive/u/0/folders/${ID}?usp=drive_link`
      )
    ).toBe(ID);
  });

  test("extracts from an open?id= link", () => {
    expect(
      extractDriveFolderId(`https://drive.google.com/open?id=${ID}`)
    ).toBe(ID);
  });

  test("returns null for empty / junk / too-short input", () => {
    expect(extractDriveFolderId("")).toBeNull();
    expect(extractDriveFolderId("   ")).toBeNull();
    expect(extractDriveFolderId("not a real id")).toBeNull();
    expect(extractDriveFolderId("short")).toBeNull();
    expect(
      extractDriveFolderId("https://drive.google.com/drive/my-drive")
    ).toBeNull();
  });
});
