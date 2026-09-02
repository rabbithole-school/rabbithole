import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { Id } from "@/convex/_generated/dataModel";
import {
  createWebPracticeSubmitter,
  type WebPracticeSubmitArgs,
} from "@/lib/practicePersistenceAdapter";
import { computeTiming, type TimingReading } from "@/shared/practiceLoop";
import {
  drainOutbox,
  enqueueOutboxAnswer,
  loadOutbox,
  submitWithOutboxBarrier,
  type OutboxAnswer,
} from "@/shared/practiceOutboxContract";
import type { KeyValueStorageAdapter } from "@/shared/practicePersistenceCore";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scholarId = "web-practice-timing-scholar" as Id<"users">;
const practiceSessionSource = readFileSync(
  resolve(repoRoot, "components/practice/PracticeSession.tsx"),
  "utf8",
);
const executorSource = readFileSync(
  resolve(repoRoot, "hooks/usePracticeMachine.ts"),
  "utf8",
);

const submitAnswerKeys = new Set([
  "scholarId",
  "itemId",
  "answer",
  "record",
  "clientEventId",
  "replay",
  "submissionFingerprintVersion",
  "prepareBreakerRepair",
  "suppressBreaker",
  "firstKeyMs",
  "elapsedMs",
  "dontKnow",
  "breakerTriggerAttemptId",
  "breakerEasyTriggerAttemptId",
  "predictedConfidence",
]);

function assertSubmitAnswerValidatorShape(payload: object): void {
  const unknownKeys = Object.keys(payload).filter(
    (key) => !submitAnswerKeys.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown submitAnswer field: ${unknownKeys.join(", ")}`);
  }
  for (const key of ["scholarId", "itemId", "answer"]) {
    if (typeof Reflect.get(payload, key) !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  for (const key of [
    "record",
    "replay",
    "prepareBreakerRepair",
    "suppressBreaker",
    "dontKnow",
  ]) {
    const value = Reflect.get(payload, key);
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
  for (const key of ["firstKeyMs", "elapsedMs"]) {
    const value = Reflect.get(payload, key);
    if (value !== undefined && typeof value !== "number") {
      throw new Error(`${key} must be a number`);
    }
    const fingerprintVersion = Reflect.get(
      payload,
      "submissionFingerprintVersion",
    );
    if (
      fingerprintVersion !== undefined &&
      fingerprintVersion !== 2
    ) {
      throw new Error("submissionFingerprintVersion must be 2");
    }
  }
  const confidence = Reflect.get(payload, "predictedConfidence");
  if (
    confidence !== undefined &&
    confidence !== "sure" &&
    confidence !== "think_so" &&
    confidence !== "not_sure"
  ) {
    throw new Error("predictedConfidence is invalid");
  }
}

function serverValidatorMutation() {
  return vi.fn(async (payload: WebPracticeSubmitArgs) => {
    assertSubmitAnswerValidatorShape(payload);
    return { correct: true };
  });
}

function memoryAdapter(): KeyValueStorageAdapter {
  const store = new Map<string, string>();
  return {
    kind: "memory",
    async read(key) {
      return store.get(key) ?? null;
    },
    async write(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

function webEntry(
  timing: TimingReading,
  overrides: Partial<OutboxAnswer> = {},
): OutboxAnswer {
  return {
    clientEventId: "practice-answer:web-timing",
    itemId: "item-1",
    answer: "42",
    record: true,
    skillLabel: "Add fractions",
    queuedAt: 1,
    ...(timing.firstKeyMs !== undefined ? { latencyMs: timing.firstKeyMs } : {}),
    ...(timing.elapsedMs !== undefined ? { thinkTimeMs: timing.elapsedMs } : {}),
    ...overrides,
  };
}

describe("PracticeSession timing outbox seam", () => {
  it("maps both web envelope constructors to the outbox contract names", () => {
    const latencyMappings =
      practiceSessionSource.match(
        /\.\.\.\(timing\.firstKeyMs !== undefined\s*\?\s*\{ latencyMs: timing\.firstKeyMs \}\s*:\s*\{\}\),/g,
      ) ?? [];
    const thinkTimeMappings =
      practiceSessionSource.match(
        /\.\.\.\(timing\.elapsedMs !== undefined\s*\?\s*\{ thinkTimeMs: timing\.elapsedMs \}\s*:\s*\{\}\),/g,
      ) ?? [];

    expect(latencyMappings).toHaveLength(2);
    expect(thinkTimeMappings).toHaveLength(2);
    expect(practiceSessionSource).not.toMatch(/\.\.\.timing,/);
    expect(executorSource.match(/submit:\s*submitOutboxEntry,/g)).toHaveLength(
      2,
    );
    expect(executorSource).not.toContain(
      "as Parameters<typeof submit>[0]",
    );
  });

  it("maps a live canonical outbox submit to the exact Convex validator shape", async () => {
    const timing = computeTiming({
      firstAttempt: true,
      nowMs: 1_000,
      renderAtMs: 200,
      firstKeyAtMs: 500,
    });
    const entry = webEntry(timing, {
      predictedConfidence: "think_so",
      prepareBreakerRepair: true,
      suppressBreaker: false,
    });
    expect(() =>
      assertSubmitAnswerValidatorShape({
        scholarId,
        itemId: entry.itemId,
        answer: entry.answer,
        clientEventId: entry.clientEventId,
        record: entry.record,
        replay: false,
        submissionFingerprintVersion: 2,
        latencyMs: entry.latencyMs,
        thinkTimeMs: entry.thinkTimeMs,
      }),
    ).toThrow(/latencyMs/);
    const mutation = serverValidatorMutation();

    const outcome = await submitWithOutboxBarrier({
      adapter: memoryAdapter(),
      scholarId: String(scholarId),
      entry,
      submit: createWebPracticeSubmitter(scholarId, mutation),
    });

    expect(outcome.status).toBe("submitted");
    expect(mutation).toHaveBeenCalledWith({
      scholarId,
      itemId: "item-1",
      answer: "42",
      clientEventId: "practice-answer:web-timing",
      record: true,
      replay: false,
      submissionFingerprintVersion: 2,
      predictedConfidence: "think_so",
      prepareBreakerRepair: true,
      suppressBreaker: false,
      firstKeyMs: 300,
      elapsedMs: 800,
    });
    expect(mutation.mock.calls[0]![0]).not.toHaveProperty("latencyMs");
    expect(mutation.mock.calls[0]![0]).not.toHaveProperty("thinkTimeMs");
  });

  it("drains undefined and think-time-only readings through the same typed seam", async () => {
    const thinkTimeOnly = computeTiming({
      firstAttempt: true,
      nowMs: 1_000,
      renderAtMs: 200,
      firstKeyAtMs: null,
    });
    const adapter = memoryAdapter();
    const entries = [
      webEntry({}, {
        clientEventId: "practice-answer:no-timing",
      }),
      webEntry(thinkTimeOnly, {
        clientEventId: "practice-answer:tap",
        answer: "choice-b",
      }),
    ];

    for (const entry of entries) {
      await enqueueOutboxAnswer(adapter, "scholar-1", entry);
    }
    const persisted = await loadOutbox(adapter, "scholar-1");
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).not.toHaveProperty("latencyMs");
    expect(persisted[0]).not.toHaveProperty("thinkTimeMs");
    expect(persisted[1]).toMatchObject({ thinkTimeMs: 800 });
    expect(persisted[1]).not.toHaveProperty("latencyMs");

    const mutation = serverValidatorMutation();
    const outcome = await drainOutbox({
      adapter,
      scholarId: "scholar-1",
      submit: createWebPracticeSubmitter(scholarId, mutation),
      isCancelled: () => false,
    });

    expect(outcome).toEqual({ status: "drained" });
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(mutation.mock.calls[0]![0]).toEqual({
      scholarId,
      itemId: "item-1",
      answer: "42",
      clientEventId: "practice-answer:no-timing",
      record: true,
      replay: true,
      submissionFingerprintVersion: 2,
    });
    expect(mutation.mock.calls[1]![0]).toEqual({
      scholarId,
      itemId: "item-1",
      answer: "choice-b",
      clientEventId: "practice-answer:tap",
      record: true,
      replay: true,
      submissionFingerprintVersion: 2,
      elapsedMs: 800,
    });
    for (const [payload] of mutation.mock.calls) {
      expect(payload).not.toHaveProperty("latencyMs");
      expect(payload).not.toHaveProperty("thinkTimeMs");
    }
    await expect(loadOutbox(adapter, "scholar-1")).resolves.toEqual([]);
  });
});
