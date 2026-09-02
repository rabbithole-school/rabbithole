import { describe, expect, it } from "vitest";
import {
  authoritativeResumeIndex,
  clearResumeSnapshot,
  isResumableSnapshot,
  loadResumeSnapshot,
  QUICK_FACTS_SCOPE_KEY,
  resumePosition,
  saveResumeSnapshot,
  type ResumeSnapshot,
} from "./practiceResumeContract";
import type { KeyValueStorageAdapter } from "./practicePersistenceCore";

function memoryAdapter(opts?: { failWrites?: boolean }): KeyValueStorageAdapter {
  const store = new Map<string, string>();
  return {
    kind: "memory",
    async read(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async write(key, value) {
      if (opts?.failWrites) throw new Error("write failed");
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

const CONTEXT = { inputKey: "domain=whole-number-arithmetic", scopeKey: "open", dayKey: "2026-08-27" };

function snapshot(overrides: Partial<ResumeSnapshot> = {}): ResumeSnapshot {
  return {
    inputKey: CONTEXT.inputKey,
    scopeKey: CONTEXT.scopeKey,
    dayKey: CONTEXT.dayKey,
    items: [{ itemId: "a" }, { itemId: "b" }, { itemId: "c" }],
    segments: [],
    resumeIdx: 1,
    savedAt: Date.now(),
    ...overrides,
  };
}

describe("resumePosition", () => {
  it("is idx on an unrecorded item", () => {
    expect(resumePosition(3, false)).toBe(3);
  });
  it("is idx+1 once the current item is recorded", () => {
    expect(resumePosition(3, true)).toBe(4);
  });
});

describe("authoritativeResumeIndex", () => {
  it("returns recordedIndex + 1 when the run has items remaining", () => {
    expect(authoritativeResumeIndex(2, 5)).toBe(3);
  });
  it("returns null once the recorded item was the last item in the run", () => {
    expect(authoritativeResumeIndex(4, 5)).toBeNull();
  });
  it("throws on a negative recordedIndex", () => {
    expect(() => authoritativeResumeIndex(-1, 5)).toThrow();
  });
  it("throws on a non-integer recordedIndex or itemCount", () => {
    expect(() => authoritativeResumeIndex(1.5, 5)).toThrow();
    expect(() => authoritativeResumeIndex(1, 5.5)).toThrow();
  });
  it("throws when recordedIndex is at or past itemCount (stale/mismatched server state)", () => {
    expect(() => authoritativeResumeIndex(5, 5)).toThrow();
    expect(() => authoritativeResumeIndex(6, 5)).toThrow();
  });
});

describe("isResumableSnapshot", () => {
  it("accepts a matching mid-run snapshot", () => {
    expect(isResumableSnapshot(snapshot(), CONTEXT)).toBe(true);
  });
  it("rejects null", () => {
    expect(isResumableSnapshot(null, CONTEXT)).toBe(false);
  });
  it("rejects a different inputKey", () => {
    expect(isResumableSnapshot(snapshot(), { ...CONTEXT, inputKey: "other" })).toBe(false);
  });
  it("rejects a different scopeKey (a Math-plan scope change)", () => {
    expect(isResumableSnapshot(snapshot(), { ...CONTEXT, scopeKey: "limited:fraction-arithmetic" })).toBe(
      false,
    );
  });
  it("rejects a different dayKey (an institution-local day rollover)", () => {
    expect(isResumableSnapshot(snapshot(), { ...CONTEXT, dayKey: "2026-08-28" })).toBe(false);
  });
  it("rejects item 1 untouched (resumeIdx 0 — nothing to restore)", () => {
    expect(isResumableSnapshot(snapshot({ resumeIdx: 0 }), CONTEXT)).toBe(false);
  });
  it("rejects a finished run (resumeIdx at/after the end)", () => {
    expect(isResumableSnapshot(snapshot({ resumeIdx: 3 }), CONTEXT)).toBe(false);
  });
  it("rejects an empty item set", () => {
    expect(isResumableSnapshot(snapshot({ items: [], resumeIdx: 0 }), CONTEXT)).toBe(false);
  });
  it("rejects a pre-scopeKey/dayKey legacy snapshot (undefined fields never match)", () => {
    const legacy = { ...snapshot() } as Partial<ResumeSnapshot>;
    delete legacy.scopeKey;
    delete legacy.dayKey;
    expect(isResumableSnapshot(legacy as ResumeSnapshot, CONTEXT)).toBe(false);
  });

  it("resumes a Quick Facts snapshot when both sides agree on the QUICK_FACTS_SCOPE_KEY sentinel", () => {
    const quickFactsContext = { ...CONTEXT, scopeKey: QUICK_FACTS_SCOPE_KEY };
    expect(
      isResumableSnapshot(snapshot({ scopeKey: QUICK_FACTS_SCOPE_KEY }), quickFactsContext),
    ).toBe(true);
  });

  it("never resumes a Quick Facts snapshot into a Math-plan-scoped context, or vice versa", () => {
    // Snapshot saved under the sentinel, current context is a real Math-plan
    // scope — the two sides must not silently agree just because one of them
    // happens to be a string.
    expect(
      isResumableSnapshot(snapshot({ scopeKey: QUICK_FACTS_SCOPE_KEY }), CONTEXT),
    ).toBe(false);
    // And the reverse: a Math-plan-scoped snapshot must not resume into a
    // Quick Facts context.
    expect(
      isResumableSnapshot(snapshot({ scopeKey: CONTEXT.scopeKey }), {
        ...CONTEXT,
        scopeKey: QUICK_FACTS_SCOPE_KEY,
      }),
    ).toBe(false);
  });
});

describe("resume snapshot load/save/clear", () => {
  it("round-trips through the adapter", async () => {
    const adapter = memoryAdapter();
    const snap = snapshot();
    const outcome = await saveResumeSnapshot(adapter, "scholar1", snap);
    expect(outcome).toEqual({ ok: true });
    const loaded = await loadResumeSnapshot(adapter, "scholar1");
    expect(loaded).toEqual(snap);
  });

  it("loads null for a scholar with no snapshot", async () => {
    const adapter = memoryAdapter();
    expect(await loadResumeSnapshot(adapter, "nobody")).toBeNull();
  });

  it("clears the snapshot", async () => {
    const adapter = memoryAdapter();
    await saveResumeSnapshot(adapter, "scholar1", snapshot());
    const outcome = await clearResumeSnapshot(adapter, "scholar1");
    expect(outcome).toEqual({ ok: true });
    expect(await loadResumeSnapshot(adapter, "scholar1")).toBeNull();
  });

  it("scopes snapshots per scholar", async () => {
    const adapter = memoryAdapter();
    await saveResumeSnapshot(adapter, "scholar1", snapshot({ resumeIdx: 1 }));
    await saveResumeSnapshot(adapter, "scholar2", snapshot({ resumeIdx: 2 }));
    expect((await loadResumeSnapshot(adapter, "scholar1"))?.resumeIdx).toBe(1);
    expect((await loadResumeSnapshot(adapter, "scholar2"))?.resumeIdx).toBe(2);
  });

  it("a failed save surfaces explicit failure and never claims the run is resumable", async () => {
    const adapter = memoryAdapter({ failWrites: true });
    const outcome = await saveResumeSnapshot(adapter, "scholar1", snapshot());
    expect(outcome.ok).toBe(false);
    expect(await loadResumeSnapshot(adapter, "scholar1")).toBeNull();
  });

  it("garbage in storage THROWS rather than silently resolving to null", async () => {
    const adapter = memoryAdapter();
    await adapter.write("rh-practice-resume:scholar1", "{not json");
    await expect(loadResumeSnapshot(adapter, "scholar1")).rejects.toThrow();
    // The corrupt bytes must not have been touched by the failed read.
    expect(await adapter.read("rh-practice-resume:scholar1")).toBe("{not json");
  });

  it("a value that fails shape validation also THROWS, distinct from confirmed-missing", async () => {
    const adapter = memoryAdapter();
    await adapter.write("rh-practice-resume:scholar1", JSON.stringify({ wrong: "shape" }));
    await expect(loadResumeSnapshot(adapter, "scholar1")).rejects.toThrow();
  });
});
