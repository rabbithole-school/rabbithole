import { describe, expect, test } from "vitest";
import {
  HISTORICAL_THINKING_ASN_DOCUMENT_ID,
  HISTORICAL_THINKING_DATASET,
  HISTORICAL_THINKING_GRADES,
  HISTORICAL_THINKING_STANDARDS,
} from "../../historicalThinkingData";

describe("Historical Thinking import data", () => {
  test("preserves the legacy UCLA/NCHS document identity and complete standard set", () => {
    expect(HISTORICAL_THINKING_ASN_DOCUMENT_ID).toBe("UCLA-HT");
    expect(HISTORICAL_THINKING_DATASET.asnDocumentId).toBe("UCLA-HT");
    expect(HISTORICAL_THINKING_DATASET.subject).toBe("Historical Thinking");
    expect(HISTORICAL_THINKING_STANDARDS).toHaveLength(43);
    expect(HISTORICAL_THINKING_STANDARDS.filter((s) => s.isLeaf)).toHaveLength(38);
  });

  test("tags every standard K-8 and parents every leaf under a domain", () => {
    const ids = new Set(HISTORICAL_THINKING_STANDARDS.map((s) => s.id));
    for (const standard of HISTORICAL_THINKING_STANDARDS) {
      expect(standard.gradeLevels).toEqual(HISTORICAL_THINKING_GRADES);
      if (standard.isLeaf) {
        expect(standard.parent, standard.id).toBeTruthy();
        expect(ids.has(standard.parent!), standard.id).toBe(true);
      } else {
        expect(standard.parent).toBeUndefined();
      }
    }
  });
});
