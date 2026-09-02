import { describe, expect, test } from "vitest";
import { NGSS_ASN_DOCUMENT_ID, NGSS_DATASET, NGSS_STANDARDS } from "../../ngssData";

const leaves = NGSS_STANDARDS.filter((s) => s.isLeaf);
const byNotation = new Map(leaves.map((s) => [s.notation, s]));

describe("NGSS import data", () => {
  test("uses the ASN NGSS document and includes the full PE set", () => {
    expect(NGSS_ASN_DOCUMENT_ID).toBe("D2454348");
    expect(NGSS_DATASET.asnDocumentId).toBe("D2454348");
    expect(NGSS_DATASET.subject).toBe("Science");
    expect(leaves).toHaveLength(202);
    expect(new Set(leaves.map((s) => s.notation)).size).toBe(leaves.length);
  });

  test("maps NGSS grade prefixes to Knowledge Tree grade levels", () => {
    expect(byNotation.get("K-LS1-1")?.gradeLevels).toEqual(["K"]);
    expect(byNotation.get("3-LS4-1")?.gradeLevels).toEqual(["3"]);
    expect(byNotation.get("5-PS1-3")?.gradeLevels).toEqual(["5"]);
    expect(byNotation.get("MS-LS2-3")?.gradeLevels).toEqual(["6", "7", "8"]);
    expect(byNotation.get("HS-LS2-6")?.gradeLevels).toEqual(["9", "10", "11", "12"]);
  });

  test("parents every performance expectation under a topic folder", () => {
    const topicIds = new Set(
      NGSS_STANDARDS
        .filter((s) => !s.isLeaf && /^(?:K|[1-5]|MS|HS)-[A-Z]+\d+$/.test(s.notation))
        .map((s) => s.id),
    );
    for (const leaf of leaves) {
      expect(leaf.parent, leaf.notation).toBeTruthy();
      expect(topicIds.has(leaf.parent!), leaf.notation).toBe(true);
    }
  });
});
