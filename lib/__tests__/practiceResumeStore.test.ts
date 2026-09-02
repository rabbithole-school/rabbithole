import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearResume,
  isResumable,
  loadResume,
  resumePosition,
  saveResume,
  type ResumeSnapshot,
} from "../practiceResumeStore";
import { MAPPING_SIT_CAP } from "../../shared/practiceLoop";

// The resume store persists an in-progress practice run to localStorage so a
// leave-to-Home or a reload restores the SAME served items at the SAME position
// instead of regenerating "item 1 of N" (pilot #1 finding). Stub localStorage
// the same way lib/__tests__/voicePerf.test.ts does.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

type Item = { itemId: string; stem: string };
type Seg = { kind: string; count: number };

function snap(over: Partial<ResumeSnapshot<Item, Seg>> = {}): ResumeSnapshot<Item, Seg> {
  return {
    inputKey: "whole-number-arithmetic|||||||",
    items: [
      { itemId: "a#1", stem: "1+1" },
      { itemId: "b#2", stem: "2+2" },
      { itemId: "c#3", stem: "3+3" },
    ],
    segments: [{ kind: "core_drill", count: 3 }],
    resumeIdx: 1,
    savedAt: 123,
    ...over,
  };
}

describe("resumePosition — the invariant-safe next-unanswered index", () => {
  test("a fresh item (not yet recorded) resumes at that item", () => {
    expect(resumePosition(2, false)).toBe(2);
  });
  test("once the current item is recorded, resume skips it (never re-records)", () => {
    // idx 2 answered/recorded → the next un-recorded item is 3, so a resume can
    // never re-serve (and re-mint fluency for) the already-graded item 2.
    expect(resumePosition(2, true)).toBe(3);
  });
  test("item 1 untouched resumes at 0 (treated as nothing to resume)", () => {
    expect(resumePosition(0, false)).toBe(0);
  });
});

describe("isResumable — only a genuine mid-run position for these inputs", () => {
  const key = "whole-number-arithmetic|||||||";
  test("mid-run snapshot for the matching inputKey is resumable", () => {
    expect(isResumable(snap({ resumeIdx: 1 }), key)).toBe(true);
    expect(isResumable(snap({ resumeIdx: 2 }), key)).toBe(true);
  });
  test("null / missing snapshot is not resumable", () => {
    expect(isResumable(null, key)).toBe(false);
  });
  test("a different inputKey (another mode/domain) never restores", () => {
    expect(isResumable(snap({ resumeIdx: 1 }), "fraction-arithmetic|||||||")).toBe(false);
  });
  test("position 0 (item 1 untouched) has nothing to restore", () => {
    expect(isResumable(snap({ resumeIdx: 0 }), key)).toBe(false);
  });
  test("a finished run (at/after the end) is not resumable", () => {
    expect(isResumable(snap({ resumeIdx: 3 }), key)).toBe(false);
    expect(isResumable(snap({ resumeIdx: 4 }), key)).toBe(false);
  });
  test("an empty item set is not resumable", () => {
    expect(isResumable(snap({ items: [], resumeIdx: 1 }), key)).toBe(false);
  });
});

describe("save / load / clear round-trip", () => {
  test("saves and reloads the exact snapshot", () => {
    saveResume("scholar-1", snap({ resumeIdx: 2, mappingProgressOffset: 3 }));
    const loaded = loadResume<Item, Seg>("scholar-1");
    expect(loaded).not.toBeNull();
    expect(loaded?.resumeIdx).toBe(2);
    expect(loaded?.items).toHaveLength(3);
    expect(loaded?.items[0].itemId).toBe("a#1");
    expect(loaded?.segments[0].count).toBe(3);
    expect(loaded?.mappingProgressOffset).toBe(3);
  });
  test("a pre-#2413 snapshot has no offset — the cap guard's `?? 0` fallback is real", () => {
    // PracticeSession's restore guard compares
    // `(snap.mappingProgressOffset ?? 0) + snap.resumeIdx` against
    // MAPPING_SIT_CAP, so a snapshot written before the field existed must load
    // with the field ABSENT (not 0-by-schema) and still restore, exactly as it
    // did before. Locks the shape that fallback depends on.
    const legacy = snap({ resumeIdx: 2 });
    delete legacy.mappingProgressOffset;
    saveResume("scholar-legacy", legacy);
    const loaded = loadResume<Item, Seg>("scholar-legacy");
    expect(loaded).not.toBeNull();
    expect(loaded?.mappingProgressOffset).toBeUndefined();
    expect((loaded?.mappingProgressOffset ?? 0) + (loaded?.resumeIdx ?? 0)).toBe(2);
  });
  test("cap guard unit: a cap-sized but partly-answered mapping snapshot is KEPT", () => {
    // The sit cap counts RECORDED probes (the server gates on `probeLog.length`),
    // so PracticeSession's guard adds `resumeIdx` — the count of already-recorded
    // items — never `items.length`, which also counts items the client is still
    // holding unanswered. This snapshot is exactly the case that separates the
    // two units: recorded total is under the cap (restore it), held total is at
    // the cap (the old expression would have thrown a valid run away).
    const offset = MAPPING_SIT_CAP - 4;
    const partly = snap({
      resumeIdx: 3,
      mappingProgressOffset: offset,
      allMapping: true,
      items: [1, 2, 3, 4, 5].map((n) => ({ itemId: `m#${n}`, stem: `${n}+${n}` })),
    });
    saveResume("scholar-cap", partly);
    const loaded = loadResume<Item, Seg>("scholar-cap");
    expect(loaded).not.toBeNull();
    // The guard only runs on a snapshot that already passed `isResumable`.
    expect(isResumable(loaded, partly.inputKey)).toBe(true);
    // Recorded-count → under the cap → KEEP.
    expect((loaded!.mappingProgressOffset ?? 0) + loaded!.resumeIdx).toBeLessThan(
      MAPPING_SIT_CAP,
    );
    // Held-items count → at the cap → the unit the reviewer flagged.
    expect(
      (loaded!.mappingProgressOffset ?? 0) + loaded!.items.length,
    ).toBeGreaterThanOrEqual(MAPPING_SIT_CAP);
  });
  test("is per-scholar keyed — one scholar never reads another's run", () => {
    saveResume("scholar-1", snap({ resumeIdx: 1 }));
    expect(loadResume("scholar-2")).toBeNull();
  });
  test("clearResume drops the snapshot", () => {
    saveResume("scholar-1", snap());
    clearResume("scholar-1");
    expect(loadResume("scholar-1")).toBeNull();
  });
  test("loadResume tolerates malformed JSON without throwing", () => {
    store.set("rh-practice-resume:scholar-1", "{not json");
    expect(loadResume("scholar-1")).toBeNull();
  });
  test("loadResume rejects a shape missing required fields", () => {
    store.set("rh-practice-resume:scholar-1", JSON.stringify({ foo: "bar" }));
    expect(loadResume("scholar-1")).toBeNull();
  });
});
