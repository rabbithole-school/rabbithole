import { describe, expect, it } from "vitest";
import { pictureNoteCopy } from "./PartOfPictureNote";

describe("pictureNoteCopy", () => {
  it("uses the child's first name throughout and no pronouns", () => {
    const copy = pictureNoteCopy("Hoku");
    const all = `${copy.heading} ${copy.body}${copy.linkText}`;
    expect(all.match(/Hoku/g)).toHaveLength(3);
    expect(all).not.toMatch(/\b(he|she|they|his|her|their)\b/i);
  });
});
