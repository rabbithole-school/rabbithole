import { describe, expect, it } from "vitest";

import {
  QUICK_FACTS_REHEARSE_MESSAGE,
  QUICK_FACTS_UNAVAILABLE_MESSAGE,
  quickFactsEntryVerdict,
} from "./quickFactsEntry";

describe("quickFactsEntryVerdict", () => {
  it("waits for the direct contract before showing anything", () => {
    expect(quickFactsEntryVerdict({ rehearsing: false, run: undefined })).toEqual({
      kind: "loading",
    });
  });

  it("runs only when the dedicated backend round is really available", () => {
    expect(
      quickFactsEntryVerdict({ rehearsing: false, run: { available: true } }),
    ).toEqual({ kind: "run" });
  });

  it("refuses honestly instead of falling through to an ordinary session", () => {
    expect(
      quickFactsEntryVerdict({ rehearsing: false, run: { available: false } }),
    ).toEqual({ kind: "error", message: QUICK_FACTS_UNAVAILABLE_MESSAGE });
    expect(quickFactsEntryVerdict({ rehearsing: false, run: null })).toEqual({
      kind: "error",
      message: QUICK_FACTS_UNAVAILABLE_MESSAGE,
    });
  });

  it("never serves a staff self-rehearsal a scholar's fact round", () => {
    expect(
      quickFactsEntryVerdict({ rehearsing: true, run: { available: true } }),
    ).toEqual({ kind: "error", message: QUICK_FACTS_REHEARSE_MESSAGE });
  });

  it("keeps the refusal free of scores, thresholds, and test language", () => {
    const copy = `${QUICK_FACTS_REHEARSE_MESSAGE} ${QUICK_FACTS_UNAVAILABLE_MESSAGE}`.toLowerCase();
    for (const banned of ["score", "%", "threshold", "license test", "failed"]) {
      expect(copy).not.toContain(banned);
    }
  });
});
