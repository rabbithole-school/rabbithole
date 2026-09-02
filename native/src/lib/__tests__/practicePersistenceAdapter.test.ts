import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The native `KeyValueStorageAdapter` (layer 4 — full web/native practice
 * persistence parity), backed by expo-file-system/legacy. The mock below
 * models the SAME primary/temp/backup file layout and same-directory
 * rename semantics the real adapter relies on (including `moveAsync`
 * throwing when its destination already exists, matching
 * `FileManager.moveItem` — never a POSIX-style silent overwrite), so these
 * tests exercise the real crash-safety protocol rather than a stand-in.
 */
const fileSystem = vi.hoisted(() => {
  const files = new Map<string, string>();
  return {
    files,
    crashAt: null as
      | null
      | "temp-written"
      | "backup-written"
      | "primary-deleted"
      | "primary-promoted",
  };
});

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  makeDirectoryAsync: vi.fn(async () => {}),
  getInfoAsync: vi.fn(async (path: string) => ({
    exists: fileSystem.files.has(path),
  })),
  readAsStringAsync: vi.fn(async (path: string) => {
    const value = fileSystem.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }),
  writeAsStringAsync: vi.fn(async (path: string, value: string) => {
    fileSystem.files.set(path, value);
    if (fileSystem.crashAt === "temp-written" && path.endsWith(".tmp")) {
      fileSystem.crashAt = null;
      throw new Error("process killed after temp write");
    }
  }),
  copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = fileSystem.files.get(from);
    if (value === undefined) throw new Error(`Missing file: ${from}`);
    fileSystem.files.set(to, value);
    if (fileSystem.crashAt === "backup-written" && to.endsWith(".bak")) {
      fileSystem.crashAt = null;
      throw new Error("process killed after backup write");
    }
  }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    const value = fileSystem.files.get(from);
    if (value === undefined) throw new Error(`Missing file: ${from}`);
    // Mirrors FileManager.moveItem(at:to:)/expo-file-system semantics: throws
    // rather than silently overwriting an existing destination.
    if (fileSystem.files.has(to)) throw new Error(`Destination already exists: ${to}`);
    fileSystem.files.set(to, value);
    fileSystem.files.delete(from);
    if (fileSystem.crashAt === "primary-promoted" && to.endsWith(".json")) {
      fileSystem.crashAt = null;
      throw new Error("process killed after primary promotion");
    }
  }),
  deleteAsync: vi.fn(async (path: string) => {
    fileSystem.files.delete(path);
    if (fileSystem.crashAt === "primary-deleted" && path.endsWith(".json")) {
      fileSystem.crashAt = null;
      throw new Error("process killed after primary deletion");
    }
  }),
}));

import * as FileSystem from "expo-file-system/legacy";

import { nativePracticePersistenceAdapter } from "../practicePersistenceAdapter";
import {
  restoreBreakerTriggerItemPayload,
  stageBreakerTriggerItemPayload,
} from "../breakerItemCache";
import { enqueueOutboxAnswer, loadOutbox } from "../../../vendor/shared/practiceOutboxContract";

beforeEach(() => {
  fileSystem.files.clear();
  fileSystem.crashAt = null;
  vi.clearAllMocks();
});

/** Find the on-disk primary path (`<key>.json`, never `.tmp`/`.bak`) for
 *  whatever key was just written — the adapter's path-building helpers are
 *  internal, so tests locate it structurally instead of hardcoding it. */
function findPrimaryPath(): string {
  const path = [...fileSystem.files.keys()].find(
    (p) => p.endsWith(".json") && !p.endsWith(".tmp") && !p.endsWith(".bak"),
  );
  if (!path) throw new Error("No primary file found in mock file system");
  return path;
}

/** Find the on-disk staged temp path (`<key>.tmp`) for whatever key was just
 *  written to — used to assert an orphaned temp survives a kill before
 *  promotion, or to plant one directly to model a corrupt orphan. */
function findTempPath(): string {
  const path = [...fileSystem.files.keys()].find((p) => p.endsWith(".tmp"));
  if (!path) throw new Error("No temp file found in mock file system");
  return path;
}

describe("nativePracticePersistenceAdapter", () => {
  it("round-trips a value through a file under practice-persistence/", async () => {
    await nativePracticePersistenceAdapter.write("rh-practice-resume:scholar1", "hello");
    expect(await nativePracticePersistenceAdapter.read("rh-practice-resume:scholar1")).toBe(
      "hello",
    );
    expect(
      fileSystem.files.has(
        "file:///documents/practice-persistence/rh-practice-resume_scholar1.json",
      ),
    ).toBe(true);
  });

  it("read returns null for a confirmed-missing key rather than throwing", async () => {
    expect(await nativePracticePersistenceAdapter.read("nobody")).toBeNull();
  });

  it("remove durably removes the primary, backup, AND any leftover temp file", async () => {
    await nativePracticePersistenceAdapter.write("k", "v1");
    await nativePracticePersistenceAdapter.write("k", "v2"); // now a backup (v1) exists too
    await nativePracticePersistenceAdapter.remove("k");
    expect(await nativePracticePersistenceAdapter.read("k")).toBeNull();
    // Nothing at all should be left on disk for this key — a leftover backup
    // could otherwise "resurrect" a value the caller explicitly cleared.
    const leftover = [...fileSystem.files.keys()].filter((p) => p.includes("/k."));
    expect(leftover).toHaveLength(0);
  });

  it("sanitizes ':' and other unsafe characters out of the filename", async () => {
    await nativePracticePersistenceAdapter.write("rh-practice-offline-queue:abc123", "[]");
    const path = [...fileSystem.files.keys()].find((p) => p.includes("abc123"));
    expect(path).toBeDefined();
    expect(path).not.toContain(":abc123");
  });

  it("serializes concurrent writes to the SAME key — the last write observed is a complete one, never a torn interleave", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      nativePracticePersistenceAdapter.write("k", JSON.stringify({ n: i })),
    );
    await Promise.all(writes);
    const raw = await nativePracticePersistenceAdapter.read("k");
    // Whichever write landed last, it must be a COMPLETE, parseable JSON value
    // — never a half-written mix of two concurrent writes.
    expect(() => JSON.parse(raw!)).not.toThrow();
    const parsed = JSON.parse(raw!) as { n: number };
    expect(parsed.n).toBeGreaterThanOrEqual(0);
    expect(parsed.n).toBeLessThan(10);
  });

  it("verifies staged bytes before promotion: a torn/wrong staged write is caught, and the OLD primary survives untouched", async () => {
    await nativePracticePersistenceAdapter.write("k", "old-value");
    // Simulate a write call that "succeeds" per the API but lands the wrong
    // bytes on disk (a torn/truncated write) — the staged content is garbage,
    // not a valid envelope of the new value.
    vi.mocked(FileSystem.writeAsStringAsync).mockImplementationOnce(async (path: string) => {
      fileSystem.files.set(path, "garbage-not-an-envelope");
    });
    await expect(nativePracticePersistenceAdapter.write("k", "new-value")).rejects.toThrow();
    // The primary must never have been promoted from bad staged bytes — the
    // old, complete value is still exactly what a read recovers.
    expect(await nativePracticePersistenceAdapter.read("k")).toBe("old-value");
  });

  it("a kill during promotion (after the backup is written, before the rename lands) recovers the OLD primary from backup", async () => {
    await nativePracticePersistenceAdapter.write("k", "old-value");
    // The rename that promotes the verified `.tmp` onto the primary path is
    // the last step of a write — simulate a process kill exactly there: the
    // backup (old-value) has already been written, but the new value never
    // became the primary.
    vi.mocked(FileSystem.moveAsync).mockImplementationOnce(async () => {
      throw new Error("process killed mid-promote");
    });
    await expect(nativePracticePersistenceAdapter.write("k", "new-value")).rejects.toThrow();
    // A fresh read (as if the app relaunched after the kill) must recover a
    // complete value — here, the OLD one, from the last-known-good backup —
    // never null (nothing was ever "confirmed missing" here) and never a
    // torn/partial value.
    expect(await nativePracticePersistenceAdapter.read("k")).toBe("old-value");
  });

  it("a corrupt primary recovers transparently from the last-known-good backup", async () => {
    await nativePracticePersistenceAdapter.write("k", "v1");
    await nativePracticePersistenceAdapter.write("k", "v2"); // primary=v2, backup=v1
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Corrupt the primary directly, in place — models a torn write that DID
    // update the file's mtime/existence but left wrong bytes (the failure
    // mode a real OS read call typically does NOT surface as a read error).
    fileSystem.files.set(findPrimaryPath(), "not a valid envelope");
    expect(await nativePracticePersistenceAdapter.read("k")).toBe("v1");
    // Recovery is never SILENT — a developer must be able to see it happened.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a corrupt primary with no backup available produces an explicit error, never a silent null", async () => {
    // Only ONE write has ever happened for this key — there is no backup yet.
    await nativePracticePersistenceAdapter.write("k", "v1");
    fileSystem.files.set(findPrimaryPath(), "not a valid envelope");
    await expect(nativePracticePersistenceAdapter.read("k")).rejects.toThrow();
  });

  it("a kill on the FIRST-EVER write, after the staged temp verifies but before the promoting move, recovers the NEW value from the orphaned temp on relaunch", async () => {
    // No prior write for this key at all: no primary, no backup exist yet,
    // so step 3 (backing up the current primary) never runs — the ONLY
    // surviving artifact after a kill here is the orphaned `.tmp`.
    vi.mocked(FileSystem.moveAsync).mockImplementationOnce(async () => {
      throw new Error("process killed before the first-ever promote");
    });
    await expect(nativePracticePersistenceAdapter.write("k", "first-answer")).rejects.toThrow();

    // Exactly a staged temp remains — no primary, no backup — modeling the
    // on-disk state an app relaunch would find after the kill.
    expect(fileSystem.files.has(findTempPath())).toBe(true);
    expect([...fileSystem.files.keys()].some((p) => p.endsWith(".json"))).toBe(false);
    expect([...fileSystem.files.keys()].some((p) => p.endsWith(".bak"))).toBe(false);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A fresh read (as if the app relaunched after the kill) must recover the
    // NEW value from the orphaned temp — never `null` ("confirmed missing"),
    // which would silently lose the very first queued answer.
    expect(await nativePracticePersistenceAdapter.read("k")).toBe("first-answer");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("an orphaned temp with no primary and no backup that is itself corrupt produces an explicit error, never a silent null", async () => {
    // Model the on-disk state directly: a `.tmp` was staged for a key that
    // has NEVER had a primary or backup, and that temp is itself corrupt
    // (e.g. a torn write that never even verified, or bit rot) — there is no
    // artifact anywhere that can recover a value for this key.
    await nativePracticePersistenceAdapter.write("orphan-key", "placeholder");
    // Undo the completed write's promotion so only a (corrupt) temp remains.
    const primaryPath = findPrimaryPath();
    fileSystem.files.delete(primaryPath);
    fileSystem.files.set(`${primaryPath.slice(0, -".json".length)}.tmp`, "not a valid envelope");

    await expect(nativePracticePersistenceAdapter.read("orphan-key")).rejects.toThrow();
  });

  it("a write that begins with an already-corrupt primary rotates that SAME corrupt content into the backup — a kill before promotion then leaves the staged temp as the only good copy, and read() must not stop at the corrupt backup", async () => {
    // No prior write via the adapter for this key at all: place a corrupt
    // primary directly, as if from some earlier, unrelated incident, with no
    // backup yet.
    fileSystem.files.set("file:///documents/practice-persistence/k.json", "not a valid envelope");

    // The write's own step 3 (preserve the CURRENT primary before touching
    // it) copies that corrupt primary into `.bak` UNCONDITIONALLY — it never
    // validates what it's rotating. Kill right after that, before the
    // promoting move lands.
    vi.mocked(FileSystem.moveAsync).mockImplementationOnce(async () => {
      throw new Error("process killed after rotating a corrupt primary into backup");
    });
    await expect(nativePracticePersistenceAdapter.write("k", "new-value")).rejects.toThrow();

    // On-disk state after the kill: no primary (deleted ahead of the failed
    // move), a corrupt backup (the rotated corrupt bytes), and a fully
    // verified staged temp holding the write's new value.
    expect([...fileSystem.files.keys()].some((p) => p.endsWith(".json"))).toBe(false);
    expect(fileSystem.files.get("file:///documents/practice-persistence/k.bak")).toBe(
      "not a valid envelope",
    );
    expect(fileSystem.files.has(findTempPath())).toBe(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A read must not give up at "backup exists but is corrupt" — it must
    // keep going to the staged temp, which is the only good copy anywhere.
    expect(await nativePracticePersistenceAdapter.read("k")).toBe("new-value");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("legacy pre-envelope compatibility", () => {
  const PERSISTENCE_DIR = "file:///documents/practice-persistence/";

  it("a legacy raw outbox array (written by the pre-rewrite adapter, no envelope) reads back unchanged", async () => {
    // The PRE-crash-safety-rewrite adapter wrote `value` directly to the
    // primary with no envelope wrapping — model that on-disk state exactly,
    // with no write ever going through the current adapter for this key.
    const legacyOutbox = JSON.stringify([
      {
        clientEventId: "evt-legacy",
        itemId: "item-1",
        answer: "7",
        record: true,
        skillLabel: "Add fractions",
        queuedAt: 1,
      },
    ]);
    fileSystem.files.set(`${PERSISTENCE_DIR}legacy-outbox.json`, legacyOutbox);
    expect(await nativePracticePersistenceAdapter.read("legacy-outbox")).toBe(legacyOutbox);
  });

  it("a legacy raw resume snapshot object (no `v` field, so it doesn't even claim to be an envelope) reads back unchanged", async () => {
    const legacySnapshot = JSON.stringify({ idx: 3, hasRecorded: true, scopeKey: "quick-facts" });
    fileSystem.files.set(`${PERSISTENCE_DIR}legacy-resume.json`, legacySnapshot);
    expect(await nativePracticePersistenceAdapter.read("legacy-resume")).toBe(legacySnapshot);
  });

  it("loadOutbox (the shared contract) reads a legacy on-disk array through the real native adapter end to end", async () => {
    const scholarId = "scholar-legacy";
    const legacyEntry = {
      clientEventId: "evt-legacy",
      itemId: "item-1",
      answer: "7",
      record: true,
      skillLabel: "Add fractions",
      queuedAt: 1,
    };
    fileSystem.files.set(
      `${PERSISTENCE_DIR}rh-practice-offline-queue_${scholarId}.json`,
      JSON.stringify([legacyEntry]),
    );
    const loaded = await loadOutbox(nativePracticePersistenceAdapter, scholarId);
    expect(loaded).toEqual([legacyEntry]);
  });

  it("passes a legacy v1 breaker cache through to its domain validator", async () => {
    const scholarId = "scholar-legacy";
    const item = { itemId: "item-legacy", stem: "What is 2 + 2?" };
    const legacyCache = {
      v: 1,
      triggerAttemptId: "attempt-legacy",
      itemId: item.itemId,
      item,
    };
    fileSystem.files.set(
      `${PERSISTENCE_DIR}rh-practice-breaker-item_${scholarId}.json`,
      JSON.stringify(legacyCache),
    );

    expect(
      await nativePracticePersistenceAdapter.read(
        `rh-practice-breaker-item:${scholarId}`,
      ),
    ).toBe(JSON.stringify(legacyCache));
    await expect(
      restoreBreakerTriggerItemPayload(
        nativePracticePersistenceAdapter,
        scholarId,
        legacyCache.triggerAttemptId,
        item.itemId,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      source: "bound",
      item,
    });
  });

  it("a primary that CLAIMS v1 but fails envelope validation recovers from a valid LEGACY backup", async () => {
    // A torn/truncated write of a NEW envelope landed on a JSON boundary —
    // `{"v":1}` parses fine but is missing body/length/checksum, so it
    // explicitly claims to be an envelope and must be treated as corrupt,
    // never silently passed through as if it were a legacy body. The
    // backup, however, is genuinely legacy (this key was never touched by
    // the current adapter before), and recovery must accept it too.
    const legacyBackup = JSON.stringify([
      {
        clientEventId: "evt-1",
        itemId: "a",
        answer: "1",
        record: true,
        skillLabel: "Add fractions",
        queuedAt: 1,
      },
    ]);
    fileSystem.files.set(`${PERSISTENCE_DIR}k.json`, JSON.stringify({ v: 1 }));
    fileSystem.files.set(`${PERSISTENCE_DIR}k.bak`, legacyBackup);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await nativePracticePersistenceAdapter.read("k")).toBe(legacyBackup);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a primary that CLAIMS v1 but fails validation, with no backup, still throws — never silently treated as a legacy value", async () => {
    for (const partial of [
      { v: 1, body: "x" },
      { v: 1, length: 1 },
      { v: 1, checksum: "1" },
    ]) {
      fileSystem.files.set(`${PERSISTENCE_DIR}k.json`, JSON.stringify(partial));
      await expect(nativePracticePersistenceAdapter.read("k")).rejects.toThrow(
        "envelope failed validation",
      );
    }
  });
});

describe("enqueueOutboxAnswer against the native adapter", () => {
  it("fails closed on corrupt/unreadable native storage and leaves the exact prior bytes untouched", async () => {
    const scholarId = "scholar1";
    const key = `rh-practice-offline-queue:${scholarId}`;
    // Write bytes that are a valid envelope (so a read doesn't throw at the
    // native-adapter layer) but not a valid outbox array underneath — this
    // exercises the SHARED contract's own missing-vs-invalid distinction on
    // top of the real native crash-safe adapter, end to end.
    await nativePracticePersistenceAdapter.write(key, "not a valid outbox array");
    const primaryPathBefore = findPrimaryPath();
    const bytesBefore = fileSystem.files.get(primaryPathBefore);

    const next = await enqueueOutboxAnswer(nativePracticePersistenceAdapter, scholarId, {
      clientEventId: "evt-1",
      itemId: "item-1",
      answer: "42",
      record: true,
      skillLabel: "Add fractions",
      queuedAt: Date.now(),
    });

    expect(next).toBeNull();
    // The exact prior on-disk bytes for the primary file must be untouched —
    // no fresh one-entry queue was silently written over unreadable storage.
    expect(fileSystem.files.get(primaryPathBefore)).toBe(bytesBefore);
    await expect(loadOutbox(nativePracticePersistenceAdapter, scholarId)).rejects.toThrow();
  });
});

describe("breaker trigger payload promotion crashes", () => {
  const item = {
    itemId: "item-trigger",
    stem: "What is 2 + 2?",
    answerType: "integer",
  };

  it.each([
    "temp-written",
    "backup-written",
    "primary-deleted",
    "primary-promoted",
  ] as const)(
    "recovers the exact candidate across a death after %s while binding the active episode",
    async (crashAt) => {
      const staged = await stageBreakerTriggerItemPayload(
        nativePracticePersistenceAdapter,
        "scholar-crash",
        {
          clientEventId: "event-trigger",
          itemId: item.itemId,
          item,
        },
      );
      expect(staged).toEqual({ ok: true });

      // The server commit is now allowed. Hydration adopts the already-durable
      // candidate and attempts to bind it to the returned attempt. Kill the
      // process after each filesystem promotion boundary in turn.
      fileSystem.crashAt = crashAt;
      const interrupted = await restoreBreakerTriggerItemPayload<typeof item>(
        nativePracticePersistenceAdapter,
        "scholar-crash",
        "attempt-trigger",
        item.itemId,
      );
      expect(interrupted).toMatchObject({
        status: "ready",
        source: "candidate",
        item,
        bindingOutcome: { ok: false },
      });

      // Two wholly fresh reads model two process relaunches. Depending on the
      // exact death boundary, the adapter recovers either the old candidate or
      // the newly-bound primary, but both must resolve the SAME item/episode.
      const firstRelaunch = await restoreBreakerTriggerItemPayload<typeof item>(
        nativePracticePersistenceAdapter,
        "scholar-crash",
        "attempt-trigger",
        item.itemId,
      );
      const secondRelaunch = await restoreBreakerTriggerItemPayload<typeof item>(
        nativePracticePersistenceAdapter,
        "scholar-crash",
        "attempt-trigger",
        item.itemId,
      );
      expect(firstRelaunch).toMatchObject({ status: "ready", item });
      expect(secondRelaunch).toMatchObject({
        status: "ready",
        source: "bound",
        item,
      });
    },
  );
});
