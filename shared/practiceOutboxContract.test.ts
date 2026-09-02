import { describe, expect, it, vi } from "vitest";
import {
  drainOutbox,
  enqueueOutboxAnswer,
  loadOutbox,
  saveOutbox,
  submitWithOutboxBarrier,
  type OutboxAnswer,
} from "./practiceOutboxContract";
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

/** A native-file-system-like adapter: every op yields a real turn of the
 *  event loop, so concurrent enqueue/drain calls actually interleave unless
 *  correctly serialized. */
function delayedAdapter(): KeyValueStorageAdapter {
  const store = new Map<string, string>();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    kind: "async-native-like",
    async read(key) {
      await tick();
      return store.has(key) ? store.get(key)! : null;
    },
    async write(key, value) {
      await tick();
      store.set(key, value);
    },
    async remove(key) {
      await tick();
      store.delete(key);
    },
  };
}

function answer(overrides: Partial<OutboxAnswer> = {}): OutboxAnswer {
  return {
    clientEventId: "evt-1",
    itemId: "item-1",
    answer: "42",
    record: true,
    skillLabel: "Add fractions",
    queuedAt: Date.now(),
    ...overrides,
  };
}

describe("enqueueOutboxAnswer", () => {
  it("appends and durably persists", async () => {
    const adapter = memoryAdapter();
    const entry = answer();
    const next = await enqueueOutboxAnswer(adapter, "scholar1", entry);
    expect(next).toEqual([entry]);
    expect(await loadOutbox(adapter, "scholar1")).toEqual([entry]);
  });

  it("returns null on a failed write — the caller must not advance", async () => {
    const adapter = memoryAdapter({ failWrites: true });
    const next = await enqueueOutboxAnswer(adapter, "scholar1", answer());
    expect(next).toBeNull();
    // Nothing landed — the outbox is still empty, never a phantom entry.
    expect(await loadOutbox(adapter, "scholar1")).toEqual([]);
  });

  it("keeps per-scholar outboxes independent", async () => {
    const adapter = memoryAdapter();
    const s1Entry = answer({ itemId: "s1-item" });
    const s2Entry = answer({ itemId: "s2-item" });
    await enqueueOutboxAnswer(adapter, "scholar1", s1Entry);
    await enqueueOutboxAnswer(adapter, "scholar2", s2Entry);
    expect(await loadOutbox(adapter, "scholar1")).toEqual([s1Entry]);
    expect(await loadOutbox(adapter, "scholar2")).toEqual([s2Entry]);
  });

  it("fails closed on unreadable/corrupt storage — never overwrites the existing bytes with a fresh one-entry queue", async () => {
    const adapter = memoryAdapter();
    const key = "rh-practice-offline-queue:scholar1";
    // Bytes that exist but are NOT a valid outbox array — simulates a
    // corrupt/torn read. `write` is spied so we can assert it is NEVER
    // called: a read/parse/validation failure must not silently start (or
    // overwrite with) a lossy new queue.
    await adapter.write(key, "not valid outbox json");
    const writeSpy = vi.spyOn(adapter, "write");
    const next = await enqueueOutboxAnswer(adapter, "scholar1", answer());
    expect(next).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
    // The exact prior bytes must be untouched.
    expect(await adapter.read(key)).toBe("not valid outbox json");
  });

  it("an adapter read failure at enqueue time also fails closed without writing", async () => {
    const adapter = memoryAdapter();
    const key = "rh-practice-offline-queue:scholar1";
    const realRead = adapter.read.bind(adapter);
    adapter.read = async (k) => {
      if (k === key) throw new Error("device storage unavailable");
      return realRead(k);
    };
    const writeSpy = vi.spyOn(adapter, "write");
    const next = await enqueueOutboxAnswer(adapter, "scholar1", answer());
    expect(next).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("drainOutbox", () => {
  it("replays queued answers in order with the SAME clientEventId, then empties the outbox", async () => {
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-1", itemId: "a" }));
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-2", itemId: "b" }));
    const submitted: string[] = [];
    const clientEventIds: string[] = [];
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        submitted.push(args.itemId);
        clientEventIds.push(args.clientEventId);
        expect(args.replay).toBe(true);
        return { correct: true };
      },
      isCancelled: () => false,
    });

    expect(submitted).toEqual(["a", "b"]);
    expect(clientEventIds).toEqual(["evt-1", "evt-2"]);
    expect(await loadOutbox(adapter, "scholar1")).toEqual([]);
    expect(outcome).toEqual({ status: "drained" });
  });

  it("defaults pre-field current rows to replay:true to preserve old offline semantics", async () => {
    const adapter = memoryAdapter();
    const { submissionReplay: _submissionReplay, ...legacyCurrent } = answer({
      clientEventId: "evt-pre-submission-replay",
    });
    await enqueueOutboxAnswer(adapter, "scholar1", legacyCurrent);
    const replayModes: boolean[] = [];
    await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        replayModes.push(args.replay);
        return { correct: true };
      },
      isCancelled: () => false,
    });
    expect(replayModes).toEqual([true]);
  });

  it("stops at the first failure, leaving the remainder queued — never drops an answer", async () => {
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-1", itemId: "a" }));
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-2", itemId: "b" }));
    let calls = 0;
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async () => {
        calls += 1;
        throw new Error("server hiccup");
      },
      isCancelled: () => false,
    });
    expect(calls).toBe(1);
    const remaining = await loadOutbox(adapter, "scholar1");
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.clientEventId).toBe("evt-1");
    expect(outcome).toMatchObject({ status: "blocked", remaining: 2, reason: "submit-failed" });
  });

  it("a lost-ack then remount/replay is safe: the same clientEventId is resent, never invented fresh", async () => {
    // Simulates: submit succeeded server-side but the ack never reached the
    // client (dropped mid-flight) — so the entry is still in the outbox when
    // the app remounts and drains again. The replay must reuse the ORIGINAL
    // clientEventId (never mint a new one), which is what makes the server's
    // dedup-by-clientEventId guard (#3190) collapse it to one attempt.
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-lost-ack" }));
    const seenIds: string[] = [];
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        seenIds.push(args.clientEventId);
        return { correct: true };
      },
      isCancelled: () => false,
    });
    expect(seenIds).toEqual(["evt-lost-ack"]);
    expect(outcome).toEqual({ status: "drained" });
  });

  it("does not remove an entry when the post-submit save fails", async () => {
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-1", itemId: "a" }));
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-2", itemId: "b" }));
    let writesShouldFail = false;
    const realWrite = adapter.write.bind(adapter);
    adapter.write = async (key, value) => {
      if (writesShouldFail) throw new Error("disk full mid-drain");
      return realWrite(key, value);
    };
    let submitCalls = 0;
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async () => {
        submitCalls += 1;
        writesShouldFail = true; // fail exactly the post-submit persist
        return { correct: true };
      },
      isCancelled: () => false,
    });
    expect(submitCalls).toBe(1);
    // The submit landed server-side (idempotency guard makes a resend safe),
    // but the local outbox failed to shrink — so it MUST still show BOTH
    // entries, ready to safely replay again next drain rather than being
    // lost from local state with no record either was ever queued.
    expect(await loadOutbox(adapter, "scholar1")).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "blocked", remaining: 2, reason: "save-failed" });
  });

  it("never submits anything in an empty outbox", async () => {
    const adapter = memoryAdapter();
    const submit = vi.fn();
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit,
      isCancelled: () => false,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "drained" });
  });

  it("stops immediately once cancelled", async () => {
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer());
    const submit = vi.fn();
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit,
      isCancelled: () => true,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "cancelled", remaining: 1 });
  });

  it("returns an explicit 'unreadable' outcome instead of throwing when storage can't be trusted", async () => {
    const adapter = memoryAdapter();
    await adapter.write("rh-practice-offline-queue:scholar1", "not valid outbox json");
    const submit = vi.fn();
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit,
      isCancelled: () => false,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(outcome.status).toBe("unreadable");
  });
});

describe("enqueue/drain concurrency", () => {
  it("an enqueue issued while a drain is in flight is never silently lost", async () => {
    const adapter = delayedAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-1", itemId: "a" }));

    const drainPromise = drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async () => {
        // Give the concurrent enqueue below a chance to interleave.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { correct: true };
      },
      isCancelled: () => false,
    });
    const enqueuePromise = enqueueOutboxAnswer(
      adapter,
      "scholar1",
      answer({ clientEventId: "evt-2", itemId: "b" }),
    );

    await Promise.all([drainPromise, enqueuePromise]);
    const remaining = await loadOutbox(adapter, "scholar1");
    // "a" was drained (acknowledged); "b" — enqueued concurrently — must
    // survive regardless of ordering.
    expect(remaining.map((entry) => entry.itemId)).toEqual(["b"]);
  });
});

describe("submitWithOutboxBarrier", () => {
  it("submits live and returns 'submitted' when the outbox is empty", async () => {
    const adapter = memoryAdapter();
    const submit = vi.fn().mockResolvedValue({ correct: true });
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: answer({ clientEventId: "evt-live" }),
      submit,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({ clientEventId: "evt-live", replay: false });
    expect(outcome).toEqual({ status: "submitted", result: { correct: true } });
    // Nothing was queued — the submit resolved live.
    expect(await loadOutbox(adapter, "scholar1")).toEqual([]);
  });

  it("queues a new live answer BEHIND an older blocked entry, without submitting it", async () => {
    const adapter = memoryAdapter();
    const blocked = answer({ clientEventId: "evt-blocked", itemId: "a" });
    await enqueueOutboxAnswer(adapter, "scholar1", blocked);
    const submit = vi.fn().mockResolvedValue({ correct: true });
    const liveEntry = answer({ clientEventId: "evt-live", itemId: "b" });
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: liveEntry,
      submit,
    });
    // The live answer must NEVER jump ahead of the older, not-yet-acknowledged
    // entry — submit is not even called.
    expect(submit).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "queued",
      queue: [blocked, { ...liveEntry, submissionReplay: true }],
      count: 2,
    });
    expect(await loadOutbox(adapter, "scholar1")).toEqual([
      blocked,
      { ...liveEntry, submissionReplay: true },
    ]);
  });

  it("an ambiguous transient submit failure durably queues the live answer under the SAME clientEventId", async () => {
    const adapter = memoryAdapter();
    const liveEntry = answer({ clientEventId: "evt-transient" });
    const submit = vi.fn().mockRejectedValue(new Error("socket dropped mid-flight"));
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: liveEntry,
      submit,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      status: "queued",
      queue: [{ ...liveEntry, submissionReplay: false }],
      count: 1,
    });
    const queued = await loadOutbox(adapter, "scholar1");
    expect(queued).toEqual([{ ...liveEntry, submissionReplay: false }]);
    expect(queued[0]!.clientEventId).toBe("evt-transient");
  });

  it("retries an ambiguous live submit with its original replay:false fingerprint", async () => {
    const adapter = memoryAdapter();
    const entry = answer({ clientEventId: "evt-lost-ack" });
    const firstReplayModes: boolean[] = [];
    const queued = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry,
      submit: async (args) => {
        firstReplayModes.push(args.replay);
        throw new Error("ack lost");
      },
    });
    expect(queued.status).toBe("queued");

    const retriedReplayModes: boolean[] = [];
    expect(
      await drainOutbox({
        adapter,
        scholarId: "scholar1",
        submit: async (args) => {
          retriedReplayModes.push(args.replay);
          return { correct: true };
        },
        isCancelled: () => false,
      }),
    ).toEqual({ status: "drained" });
    expect(firstReplayModes).toEqual([false]);
    expect(retriedReplayModes).toEqual([false]);
  });

  it("keeps replay:false when live submission and its fallback write both fail", async () => {
    const adapter = memoryAdapter();
    const realWrite = adapter.write.bind(adapter);
    let failWrites = false;
    adapter.write = async (key, value) => {
      if (failWrites) throw new Error("disk full");
      return realWrite(key, value);
    };
    const entry = answer({ clientEventId: "evt-live-write-failed" });
    const failed = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry,
      submit: async () => {
        failWrites = true;
        throw new Error("ack lost");
      },
    });
    expect(failed.status).toBe("failed");

    failWrites = false;
    await enqueueOutboxAnswer(adapter, "scholar1", {
      ...entry,
      submissionReplay: false,
    });
    const replayModes: boolean[] = [];
    await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        replayModes.push(args.replay);
        return { correct: true };
      },
      isCancelled: () => false,
    });
    expect(replayModes).toEqual([false]);
  });

  it("a second drain after a transient-failure queue succeeds and replays in original order", async () => {
    const adapter = memoryAdapter();
    // First: an older entry is already queued (e.g. from a prior outage).
    const older = answer({ clientEventId: "evt-older", itemId: "a" });
    await enqueueOutboxAnswer(adapter, "scholar1", older);
    // Then a live submit fails ambiguously — the barrier queues it BEHIND
    // the older entry (queue was non-empty), never submitting it live.
    const liveEntry = answer({ clientEventId: "evt-live", itemId: "b" });
    const failingSubmit = vi.fn().mockRejectedValue(new Error("should never be called"));
    const barrierOutcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: liveEntry,
      submit: failingSubmit,
    });
    expect(failingSubmit).not.toHaveBeenCalled();
    expect(barrierOutcome).toEqual({
      status: "queued",
      queue: [older, { ...liveEntry, submissionReplay: true }],
      count: 2,
    });

    // A drain that fails on the first attempt (simulating the transient
    // outage still in progress) leaves both queued, in order.
    let attempt = 0;
    const flakySubmit = vi.fn(async (args: { clientEventId: string }) => {
      attempt += 1;
      if (attempt === 1) throw new Error("still down");
      return { correct: true, clientEventId: args.clientEventId };
    });
    const firstDrain = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: flakySubmit,
      isCancelled: () => false,
    });
    expect(firstDrain).toMatchObject({ status: "blocked", remaining: 2 });
    expect(await loadOutbox(adapter, "scholar1")).toEqual([
      older,
      { ...liveEntry, submissionReplay: true },
    ]);

    // Second drain succeeds and replays BOTH in the original order.
    const seenIds: string[] = [];
    const secondDrain = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        seenIds.push(args.clientEventId);
        return { correct: true };
      },
      isCancelled: () => false,
    });
    expect(secondDrain).toEqual({ status: "drained" });
    expect(seenIds).toEqual(["evt-older", "evt-live"]);
    expect(await loadOutbox(adapter, "scholar1")).toEqual([]);
  });

  it("returns 'failed' without submitting or writing when storage is unreadable", async () => {
    const adapter = memoryAdapter();
    await adapter.write("rh-practice-offline-queue:scholar1", "not valid outbox json");
    const writeSpy = vi.spyOn(adapter, "write");
    const submit = vi.fn();
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: answer(),
      submit,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    // The exact prior (unreadable) bytes are untouched.
    expect(await adapter.read("rh-practice-offline-queue:scholar1")).toBe(
      "not valid outbox json",
    );
  });

  it("runs under the SAME lock as drain/enqueue — a concurrent drain and a barrier submit never interleave", async () => {
    const adapter = delayedAdapter();
    const older = answer({ clientEventId: "evt-older", itemId: "a" });
    await enqueueOutboxAnswer(adapter, "scholar1", older);

    const drainSubmit = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { correct: true };
    });
    const drainPromise = drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: drainSubmit,
      isCancelled: () => false,
    });

    const barrierEntry = answer({ clientEventId: "evt-live", itemId: "b" });
    const barrierSubmit = vi.fn().mockResolvedValue({ correct: true });
    const barrierPromise = submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: barrierEntry,
      submit: barrierSubmit,
    });

    const [, barrierOutcome] = await Promise.all([drainPromise, barrierPromise]);
    // Whichever actually acquired the lock first, the barrier must never
    // submit the live answer live while an older entry was (or still is)
    // ahead of it in the queue — it always observes either an empty queue
    // (drain fully finished first) or a non-empty one (queues behind it).
    if (barrierSubmit.mock.calls.length > 0) {
      expect(barrierOutcome).toEqual({ status: "submitted", result: { correct: true } });
    } else {
      expect(barrierOutcome).toMatchObject({ status: "queued" });
    }
  });
});

describe("dontKnow (an honest 'I don't know' submission)", () => {
  it("survives enqueue and a subsequent read — never dropped or coerced to false", async () => {
    const adapter = memoryAdapter();
    const entry = answer({ clientEventId: "evt-dk", dontKnow: true });
    const next = await enqueueOutboxAnswer(adapter, "scholar1", entry);
    expect(next?.[0]?.dontKnow).toBe(true);
    const loaded = await loadOutbox(adapter, "scholar1");
    expect(loaded).toEqual([entry]);
    expect(loaded[0]!.dontKnow).toBe(true);
  });

  describe("latency metadata", () => {
    it("survives an ambiguous queue and retry unchanged", async () => {
      const adapter = memoryAdapter();
      const entry = answer({ latencyMs: 2_400, thinkTimeMs: 1_100 });
      const queued = await submitWithOutboxBarrier({
        adapter,
        scholarId: "scholar1",
        entry,
        submit: vi.fn().mockRejectedValue(new Error("connection dropped")),
      });
      expect(queued).toMatchObject({ status: "queued" });

      const submit = vi.fn(async () => ({ correct: true }));
      await drainOutbox({
        adapter,
        scholarId: "scholar1",
        submit,
        isCancelled: () => false,
      });
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          latencyMs: 2_400,
          thinkTimeMs: 1_100,
          replay: false,
        }),
      );
    });
  });

  it("an entry with no dontKnow (a normal guess) round-trips without ever gaining the field", async () => {
    const adapter = memoryAdapter();
    const entry = answer({ clientEventId: "evt-guess" });
    await enqueueOutboxAnswer(adapter, "scholar1", entry);
    const loaded = await loadOutbox(adapter, "scholar1");
    expect(loaded[0]!.dontKnow).toBeUndefined();
  });

  it("drainOutbox replays it through to submit — a don't-know is never silently replayed as a guess", async () => {
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer({ clientEventId: "evt-dk", dontKnow: true }));
    let seenDontKnow: boolean | undefined;
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        seenDontKnow = args.dontKnow;
        return { correct: false };
      },
      isCancelled: () => false,
    });
    expect(outcome).toEqual({ status: "drained" });
    expect(seenDontKnow).toBe(true);
  });

  it("submitWithOutboxBarrier carries dontKnow through a live submit", async () => {
    const adapter = memoryAdapter();
    let seenDontKnow: boolean | undefined;
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: answer({ clientEventId: "evt-dk-live", dontKnow: true }),
      submit: async (args) => {
        seenDontKnow = args.dontKnow;
        return { correct: false };
      },
    });
    expect(outcome).toEqual({ status: "submitted", result: { correct: false } });
    expect(seenDontKnow).toBe(true);
  });

  it("submitWithOutboxBarrier preserves dontKnow when queuing behind an older entry", async () => {
    const adapter = memoryAdapter();
    const older = answer({ clientEventId: "evt-older", itemId: "a" });
    await enqueueOutboxAnswer(adapter, "scholar1", older);
    const dontKnowEntry = answer({ clientEventId: "evt-dk", itemId: "b", dontKnow: true });
    const submit = vi.fn();
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: dontKnowEntry,
      submit,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "queued",
      queue: [older, { ...dontKnowEntry, submissionReplay: true }],
      count: 2,
    });
    const loaded = await loadOutbox(adapter, "scholar1");
    expect(loaded[1]!.dontKnow).toBe(true);
  });

  it("submitWithOutboxBarrier preserves dontKnow when an ambiguous submit failure forces a durable requeue", async () => {
    const adapter = memoryAdapter();
    const dontKnowEntry = answer({ clientEventId: "evt-dk-retry", dontKnow: true });
    const outcome = await submitWithOutboxBarrier({
      adapter,
      scholarId: "scholar1",
      entry: dontKnowEntry,
      submit: async () => {
        throw new Error("socket dropped mid-flight");
      },
    });
    expect(outcome).toEqual({
      status: "queued",
      queue: [{ ...dontKnowEntry, submissionReplay: false }],
      count: 1,
    });
    const loaded = await loadOutbox(adapter, "scholar1");
    expect(loaded[0]!.dontKnow).toBe(true);

    // And a subsequent drain still replays it with dontKnow intact.
    let seenDontKnow: boolean | undefined;
    const drainOutcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        seenDontKnow = args.dontKnow;
        return { correct: false };
      },
      isCancelled: () => false,
    });
    expect(drainOutcome).toEqual({ status: "drained" });
    expect(seenDontKnow).toBe(true);
  });
});

describe("saveOutbox", () => {
  it("clears the storage key entirely once the outbox empties, rather than persisting []", async () => {
    const adapter = memoryAdapter();
    await enqueueOutboxAnswer(adapter, "scholar1", answer());
    await saveOutbox(adapter, "scholar1", []);
    expect(await adapter.read("rh-practice-offline-queue:scholar1")).toBeNull();
  });
});

describe("a queued answer never expires", () => {
  // Unlike a resume snapshot — which is deliberately invalidated the moment
  // scopeKey/dayKey stop matching — the outbox has no TTL, no timestamp
  // invalidation, and no expiry field. That was true by construction in the
  // original implementation but never asserted, which makes it exactly the
  // kind of property a later "cleanup" could silently remove. A queued answer
  // is a scholar's unacknowledged work: dropping it because it is old loses
  // real thinking, so age must never be a reason not to replay.
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it("loads an ancient entry unchanged", async () => {
    const adapter = memoryAdapter();
    const ancient = answer({ queuedAt: Date.now() - ONE_YEAR_MS });
    await enqueueOutboxAnswer(adapter, "scholar1", ancient);
    expect(await loadOutbox(adapter, "scholar1")).toEqual([ancient]);
  });

  it("drains an ancient entry with its ORIGINAL clientEventId", async () => {
    const adapter = memoryAdapter();
    const ancient = answer({
      clientEventId: "evt-ancient",
      queuedAt: Date.now() - ONE_YEAR_MS,
    });
    await enqueueOutboxAnswer(adapter, "scholar1", ancient);

    const submitted: string[] = [];
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        submitted.push(args.clientEventId);
        return { correct: true };
      },
      isCancelled: () => false,
    });

    // The original id is what makes the replay idempotent server-side; a
    // re-minted id would create a duplicate attempt instead.
    expect(outcome).toEqual({ status: "drained" });
    expect(submitted).toEqual(["evt-ancient"]);
    expect(await loadOutbox(adapter, "scholar1")).toEqual([]);
  });

  it("keeps replay order by position, not by age", async () => {
    const adapter = memoryAdapter();
    // The older entry is enqueued SECOND. Insertion order is what replay
    // follows — sorting by queuedAt would reorder a scholar's answers.
    const newer = answer({ clientEventId: "evt-newer", queuedAt: Date.now() });
    const older = answer({
      clientEventId: "evt-older",
      queuedAt: Date.now() - ONE_YEAR_MS,
    });
    await enqueueOutboxAnswer(adapter, "scholar1", newer);
    await enqueueOutboxAnswer(adapter, "scholar1", older);

    const submitted: string[] = [];
    await drainOutbox({
      adapter,
      scholarId: "scholar1",
      submit: async (args) => {
        submitted.push(args.clientEventId);
        return { correct: true };
      },
      isCancelled: () => false,
    });
    expect(submitted).toEqual(["evt-newer", "evt-older"]);
  });
});
