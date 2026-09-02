import { describe, expect, it, vi } from "vitest";

import type { Id } from "@/convex/_generated/dataModel";
import {
  createWebPracticePersistenceAdapter,
  createWebPracticeSubmitter,
  deriveLegacyWebPracticeClientEventId,
  parseLegacyWebPracticeOutboxV0,
  type LegacyOutboxIdInput,
  type LegacyWebPracticeOutboxAnswerV0,
  type WebPracticeSubmitArgs,
  type WebPracticeStorage,
} from "@/lib/practicePersistenceAdapter";
import {
  drainOutbox,
  enqueueOutboxAnswer,
  loadOutbox,
  submitWithOutboxBarrier,
  type OutboxAnswer,
} from "@/shared/practiceOutboxContract";

const SCHOLAR_ID = "legacy-web-scholar";
const STORAGE_KEY = `rh-practice-offline-queue:${SCHOLAR_ID}`;
const CONVEX_SCHOLAR_ID = SCHOLAR_ID as Id<"users">;

// Copied from the exact pre-clientEventId QueuedPracticeAnswer contract. The
// fixture exercises every optional predecessor field plus both record modes and
// array ordering.
const LEGACY_ROWS = [
  {
    itemId: "fraction_addition#legacy-1",
    answer: "5/6",
    record: true,
    skillLabel: "Add fractions",
    queuedAt: 1_725_000_000_001,
    predictedConfidence: "think_so",
    breakerTriggerAttemptId: "legacy-trigger-attempt",
    suppressBreaker: false,
    prepareBreakerRepair: true,
  },
  {
    itemId: "multiplication_facts#legacy-2",
    answer: "42",
    record: true,
    skillLabel: "Multiplication facts",
    queuedAt: 1_725_000_000_002,
    breakerEasyTriggerAttemptId: "legacy-easy-attempt",
    suppressBreaker: true,
    prepareBreakerRepair: false,
  },
  {
    itemId: "fraction_addition#legacy-retry",
    answer: "7/8",
    record: false,
    skillLabel: "Add fractions",
    queuedAt: 1_725_000_000_003,
    suppressBreaker: false,
    prepareBreakerRepair: true,
  },
] satisfies LegacyWebPracticeOutboxAnswerV0[];

function currentAnswer(
  overrides: Partial<OutboxAnswer> = {},
): OutboxAnswer {
  return {
    clientEventId: "practice-answer:current",
    itemId: "decimal_place_value#current",
    answer: "0.42",
    record: true,
    skillLabel: "Decimal place value",
    queuedAt: 1_725_000_000_004,
    ...overrides,
  };
}

function idByPosition({
  position,
}: LegacyOutboxIdInput): Promise<string> {
  return Promise.resolve(`practice-answer:adopted:${position}`);
}

function memoryStorage(initialRaw?: string) {
  const values = new Map<string, string>();
  if (initialRaw !== undefined) values.set(STORAGE_KEY, initialRaw);
  let failWrites = false;
  const storage: WebPracticeStorage = {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      if (failWrites) throw new Error("localStorage quota exceeded");
      values.set(key, value);
    }),
    removeItem: vi.fn((key) => {
      values.delete(key);
    }),
  };
  return {
    storage,
    raw: (key = STORAGE_KEY) => values.get(key) ?? null,
    failWrites: (value: boolean) => {
      failWrites = value;
    },
  };
}

function adapterFor(
  memory: ReturnType<typeof memoryStorage>,
  legacyClientEventId: (
    input: LegacyOutboxIdInput,
  ) => Promise<string> = idByPosition,
) {
  return createWebPracticePersistenceAdapter({
    storage: memory.storage,
    legacyClientEventId,
  });
}

describe("legacy web practice outbox v0 recognition", () => {
  it("accepts the exact predecessor shape, including every optional field", () => {
    expect(
      parseLegacyWebPracticeOutboxV0(JSON.stringify(LEGACY_ROWS)),
    ).toEqual(LEGACY_ROWS);
    expect(parseLegacyWebPracticeOutboxV0("[]")).toEqual([]);
  });

  it.each([
    ["bad JSON", "not-json"],
    ["non-array JSON", JSON.stringify({ queue: LEGACY_ROWS })],
    [
      "missing required field",
      JSON.stringify([{ ...LEGACY_ROWS[0], queuedAt: undefined }]),
    ],
    [
      "unknown current timing field",
      JSON.stringify([{ ...LEGACY_ROWS[0], latencyMs: 120 }]),
    ],
    [
      "unknown server timing field",
      JSON.stringify([{ ...LEGACY_ROWS[0], firstKeyMs: 120 }]),
    ],
    [
      "invalid optional confidence",
      JSON.stringify([
        { ...LEGACY_ROWS[0], predictedConfidence: "certain" },
      ]),
    ],
    [
      "mixed legacy/current rows",
      JSON.stringify([LEGACY_ROWS[0], currentAnswer()]),
    ],
  ])("rejects %s rather than partially adopting it", (_label, raw) => {
    expect(parseLegacyWebPracticeOutboxV0(raw)).toBeNull();
  });

  it("derives deterministic, domain-separated SHA-256 ids", async () => {
    const base = {
      storageKey: STORAGE_KEY,
      position: 0,
      row: LEGACY_ROWS[0],
    } satisfies LegacyOutboxIdInput;
    const same = await Promise.all([
      deriveLegacyWebPracticeClientEventId(base),
      deriveLegacyWebPracticeClientEventId(base),
    ]);
    const distinct = await Promise.all([
      deriveLegacyWebPracticeClientEventId({
        ...base,
        position: 1,
      }),
      deriveLegacyWebPracticeClientEventId({
        ...base,
        storageKey: `${STORAGE_KEY}-other`,
      }),
      deriveLegacyWebPracticeClientEventId({
        ...base,
        row: { ...base.row, answer: "different" },
      }),
    ]);

    expect(same[0]).toBe(same[1]);
    expect(same[0]).toMatch(
      /^practice-answer:legacy-web-v0:[0-9a-f]{64}$/,
    );
    expect(new Set([same[0], ...distinct]).size).toBe(4);
  });
});

describe("legacy web practice outbox adoption", () => {
  it("promotes predeploy rows once, losslessly, and reuses their ids after reload", async () => {
    const original = JSON.stringify(LEGACY_ROWS);
    const memory = memoryStorage(original);
    const deriveId = vi.fn(idByPosition);
    const firstAdapter = adapterFor(memory, deriveId);

    const adopted = await loadOutbox(firstAdapter, SCHOLAR_ID);
    expect(adopted).toEqual(
      LEGACY_ROWS.map((row, position) => ({
        clientEventId: `practice-answer:adopted:${position}`,
        submissionReplay: true,
        ...row,
      })),
    );
    expect(adopted[0]).not.toHaveProperty("latencyMs");
    expect(adopted[0]).not.toHaveProperty("thinkTimeMs");
    expect(deriveId).toHaveBeenCalledTimes(LEGACY_ROWS.length);
    expect(memory.storage.setItem).toHaveBeenCalledTimes(1);
    expect(memory.raw()).toBe(JSON.stringify(adopted));

    const shouldNotReassign = vi.fn(async () => {
      throw new Error("a current outbox must not mint replacement ids");
    });
    const reloaded = await loadOutbox(
      adapterFor(memory, shouldNotReassign),
      SCHOLAR_ID,
    );
    expect(reloaded).toEqual(adopted);
    expect(shouldNotReassign).not.toHaveBeenCalled();
    expect(memory.storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("leaves current bytes and identities exactly unchanged", async () => {
    const current = currentAnswer({
      clientEventId: "practice-answer:existing-stable-id",
      latencyMs: 2_400,
      thinkTimeMs: 1_100,
    });
    const raw = `[\n  ${JSON.stringify(current)}\n]`;
    const memory = memoryStorage(raw);
    const deriveId = vi.fn(idByPosition);
    const adapter = adapterFor(memory, deriveId);

    await expect(adapter.read(STORAGE_KEY)).resolves.toBe(raw);
    await expect(loadOutbox(adapter, SCHOLAR_ID)).resolves.toEqual([
      current,
    ]);
    expect(memory.raw()).toBe(raw);
    expect(memory.storage.setItem).not.toHaveBeenCalled();
    expect(deriveId).not.toHaveBeenCalled();
  });

  it("preserves the existing empty-array semantics without a rewrite", async () => {
    const memory = memoryStorage("[]");
    const adapter = adapterFor(memory);

    await expect(loadOutbox(adapter, SCHOLAR_ID)).resolves.toEqual([]);
    expect(memory.raw()).toBe("[]");
    expect(memory.storage.setItem).not.toHaveBeenCalled();
  });

  it("lets a live barrier append behind adopted rows, then drains every answer in order through the Convex seam", async () => {
    const memory = memoryStorage(JSON.stringify(LEGACY_ROWS));
    const adapter = adapterFor(memory);
    const live = currentAnswer({
      clientEventId: "practice-answer:live-after-upgrade",
      latencyMs: 2_400,
      thinkTimeMs: 1_100,
    });
    const liveSubmit = vi.fn();

    const barrier = await submitWithOutboxBarrier({
      adapter,
      scholarId: SCHOLAR_ID,
      entry: live,
      submit: liveSubmit,
    });

    expect(liveSubmit).not.toHaveBeenCalled();
    expect(barrier).toMatchObject({ status: "queued", count: 4 });
    const persisted = JSON.parse(memory.raw()!) as OutboxAnswer[];
    expect(persisted.map((row) => row.itemId)).toEqual([
      ...LEGACY_ROWS.map((row) => row.itemId),
      live.itemId,
    ]);
    expect(persisted.slice(0, 3).map((row) => row.clientEventId)).toEqual([
      "practice-answer:adopted:0",
      "practice-answer:adopted:1",
      "practice-answer:adopted:2",
    ]);

    const mutation = vi.fn(
      async (_payload: WebPracticeSubmitArgs) => ({ correct: true }),
    );
    const drained = await drainOutbox({
      adapter,
      scholarId: SCHOLAR_ID,
      submit: createWebPracticeSubmitter(CONVEX_SCHOLAR_ID, mutation),
      isCancelled: () => false,
    });

    expect(drained).toEqual({ status: "drained" });
    expect(mutation).toHaveBeenCalledTimes(4);
    expect(
      mutation.mock.calls.map(([payload]) => payload.itemId),
    ).toEqual([
      ...LEGACY_ROWS.map((row) => row.itemId),
      live.itemId,
    ]);
    expect(mutation.mock.calls[0]![0]).toMatchObject({
      clientEventId: "practice-answer:adopted:0",
      record: true,
      replay: true,
      predictedConfidence: "think_so",
      breakerTriggerAttemptId: "legacy-trigger-attempt",
      suppressBreaker: false,
      prepareBreakerRepair: true,
    });
    expect(mutation.mock.calls[0]![0]).not.toHaveProperty("firstKeyMs");
    expect(mutation.mock.calls[0]![0]).not.toHaveProperty("elapsedMs");
    expect(mutation.mock.calls[1]![0]).toMatchObject({
      clientEventId: "practice-answer:adopted:1",
      record: true,
      replay: true,
      breakerEasyTriggerAttemptId: "legacy-easy-attempt",
      suppressBreaker: true,
      prepareBreakerRepair: false,
    });
    expect(mutation.mock.calls[2]![0]).toMatchObject({
      clientEventId: "practice-answer:adopted:2",
      record: false,
      replay: true,
      suppressBreaker: false,
      prepareBreakerRepair: true,
    });
    expect(mutation.mock.calls[3]![0]).toMatchObject({
      clientEventId: "practice-answer:live-after-upgrade",
      replay: true,
      firstKeyMs: 2_400,
      elapsedMs: 1_100,
    });
    expect(memory.raw()).toBeNull();
  });

  it("lets explicit enqueue append without clearing or replacing a legacy answer", async () => {
    const memory = memoryStorage(JSON.stringify([LEGACY_ROWS[0]]));
    const adapter = adapterFor(memory);
    const live = currentAnswer();

    const queued = await enqueueOutboxAnswer(
      adapter,
      SCHOLAR_ID,
      live,
    );

    expect(queued?.map((row) => row.itemId)).toEqual([
      LEGACY_ROWS[0].itemId,
      live.itemId,
    ]);
    expect(queued?.[0]).toEqual({
      clientEventId: "practice-answer:adopted:0",
      submissionReplay: true,
      ...LEGACY_ROWS[0],
    });
    expect(await loadOutbox(adapter, SCHOLAR_ID)).toEqual(queued);
  });

  it("persists ids before a failed replay and reuses them on retry/reload", async () => {
    const memory = memoryStorage(JSON.stringify([LEGACY_ROWS[0]]));
    const firstAdapter = adapterFor(memory);
    const firstSeen: string[] = [];
    const firstDrain = await drainOutbox({
      adapter: firstAdapter,
      scholarId: SCHOLAR_ID,
      submit: async (args) => {
        firstSeen.push(args.clientEventId);
        throw new Error("ack lost");
      },
      isCancelled: () => false,
    });
    const adoptedRaw = memory.raw();

    expect(firstDrain).toMatchObject({
      status: "blocked",
      reason: "submit-failed",
      remaining: 1,
    });
    expect(firstSeen).toEqual(["practice-answer:adopted:0"]);
    expect(adoptedRaw).not.toBe(JSON.stringify([LEGACY_ROWS[0]]));

    const shouldNotReassign = vi.fn(async () => {
      throw new Error("retry must reuse the persisted id");
    });
    const secondSeen: string[] = [];
    const secondDrain = await drainOutbox({
      adapter: adapterFor(memory, shouldNotReassign),
      scholarId: SCHOLAR_ID,
      submit: async (args) => {
        secondSeen.push(args.clientEventId);
        return { correct: true };
      },
      isCancelled: () => false,
    });

    expect(secondDrain).toEqual({ status: "drained" });
    expect(secondSeen).toEqual(firstSeen);
    expect(shouldNotReassign).not.toHaveBeenCalled();
    expect(memory.raw()).toBeNull();
  });

  it("serializes competing Strict Mode-style reads so one promotion wins", async () => {
    const memory = memoryStorage(JSON.stringify(LEGACY_ROWS));
    let releaseDerivation!: () => void;
    const derivationReleased = new Promise<void>((resolve) => {
      releaseDerivation = resolve;
    });
    let reportEntered!: () => void;
    const derivationEntered = new Promise<void>((resolve) => {
      reportEntered = resolve;
    });
    const deriveId = vi.fn(
      async ({ position }: LegacyOutboxIdInput) => {
        reportEntered();
        await derivationReleased;
        return `practice-answer:concurrent:${position}`;
      },
    );
    const firstAdapter = adapterFor(memory, deriveId);
    const secondAdapter = adapterFor(memory, deriveId);

    const first = loadOutbox(firstAdapter, SCHOLAR_ID);
    await derivationEntered;
    const second = loadOutbox(secondAdapter, SCHOLAR_ID);
    releaseDerivation();
    const [firstResult, secondResult] = await Promise.all([
      first,
      second,
    ]);

    expect(firstResult).toEqual(secondResult);
    expect(deriveId).toHaveBeenCalledTimes(LEGACY_ROWS.length);
    expect(memory.storage.setItem).toHaveBeenCalledTimes(1);
    expect(memory.storage.getItem).toHaveBeenCalledTimes(2);
  });

  it("fails before submission when promotion cannot be written, preserves the original bytes, and recovers without a clear", async () => {
    const original = JSON.stringify(LEGACY_ROWS);
    const memory = memoryStorage(original);
    memory.failWrites(true);
    const adapter = adapterFor(memory);
    const submit = vi.fn();

    const barrier = await submitWithOutboxBarrier({
      adapter,
      scholarId: SCHOLAR_ID,
      entry: currentAnswer(),
      submit,
    });

    expect(barrier.status).toBe("failed");
    expect(submit).not.toHaveBeenCalled();
    expect(memory.raw()).toBe(original);

    memory.failWrites(false);
    const replay = vi.fn(async () => ({ correct: true }));
    const drain = await drainOutbox({
      adapter,
      scholarId: SCHOLAR_ID,
      submit: replay,
      isCancelled: () => false,
    });
    expect(drain).toEqual({ status: "drained" });
    expect(replay).toHaveBeenCalledTimes(LEGACY_ROWS.length);
    expect(memory.raw()).toBeNull();
  });

  it.each([
    ["corrupt JSON", "not-json"],
    ["partial legacy row", JSON.stringify([{ ...LEGACY_ROWS[0], answer: undefined }])],
    [
      "legacy row with an unknown field",
      JSON.stringify([{ ...LEGACY_ROWS[0], dontKnow: true }]),
    ],
    [
      "mixed legacy/current rows",
      JSON.stringify([LEGACY_ROWS[0], currentAnswer()]),
    ],
  ])(
    "keeps %s fail-closed and byte-identical through every public path",
    async (_label, raw) => {
      const memory = memoryStorage(raw);
      const adapter = adapterFor(memory);
      const submit = vi.fn();

      await expect(loadOutbox(adapter, SCHOLAR_ID)).rejects.toBeDefined();
      await expect(
        enqueueOutboxAnswer(
          adapter,
          SCHOLAR_ID,
          currentAnswer(),
        ),
      ).resolves.toBeNull();
      await expect(
        submitWithOutboxBarrier({
          adapter,
          scholarId: SCHOLAR_ID,
          entry: currentAnswer(),
          submit,
        }),
      ).resolves.toMatchObject({ status: "failed" });
      await expect(
        drainOutbox({
          adapter,
          scholarId: SCHOLAR_ID,
          submit,
          isCancelled: () => false,
        }),
      ).resolves.toMatchObject({ status: "unreadable" });

      expect(submit).not.toHaveBeenCalled();
      expect(memory.storage.setItem).not.toHaveBeenCalled();
      expect(memory.storage.removeItem).not.toHaveBeenCalled();
      expect(memory.raw()).toBe(raw);
    },
  );
});
