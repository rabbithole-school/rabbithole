"use client";

/**
 * The web persistence seams for the shared practice machine: honest local
 * storage, plus the typed boundary from its framework-neutral outbox payload
 * to Convex's submitAnswer mutation payload.
 */

import type { FunctionArgs } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  OutboxAnswer,
  OutboxSubmitArgs,
} from "@/shared/practiceOutboxContract";
import {
  createKeyedMutex,
  type KeyValueStorageAdapter,
} from "@/shared/practicePersistenceCore";
import { withPracticeSubmitTimeout } from "@/shared/practiceOutboxRetry";

export type WebPracticeSubmitArgs = FunctionArgs<
  typeof api.practiceSkills.submitAnswer
>;

/**
 * The exact queue row written by the production web client before
 * `clientEventId` was introduced. This format existed only in localStorage;
 * native's durable outbox launched with the current contract.
 */
export type LegacyWebPracticeOutboxAnswerV0 = {
  itemId: string;
  answer: string;
  record: boolean;
  skillLabel: string;
  queuedAt: number;
  predictedConfidence?: "sure" | "think_so" | "not_sure";
  breakerTriggerAttemptId?: string;
  breakerEasyTriggerAttemptId?: string;
  suppressBreaker?: boolean;
  prepareBreakerRepair?: boolean;
};

const OUTBOX_STORAGE_PREFIX = "rh-practice-offline-queue:";
const LEGACY_OUTBOX_ID_DOMAIN = "rabbithole:practice-outbox:legacy-web:v0";
const legacyOutboxKeys = new Set([
  "itemId",
  "answer",
  "record",
  "skillLabel",
  "queuedAt",
  "predictedConfidence",
  "breakerTriggerAttemptId",
  "breakerEasyTriggerAttemptId",
  "suppressBreaker",
  "prepareBreakerRepair",
]);
const requiredLegacyOutboxKeys = [
  "itemId",
  "answer",
  "record",
  "skillLabel",
  "queuedAt",
] as const;

function isLegacyConfidence(
  value: unknown,
): value is NonNullable<
  LegacyWebPracticeOutboxAnswerV0["predictedConfidence"]
> {
  return (
    value === "sure" ||
    value === "think_so" ||
    value === "not_sure"
  );
}

/** Strictly recognizes only the predecessor's persisted row shape. Unknown
 * fields are rejected so a mixed/current/corrupt array can never be
 * misclassified and rewritten as legacy data. */
export function isLegacyWebPracticeOutboxAnswerV0(
  value: unknown,
): value is LegacyWebPracticeOutboxAnswerV0 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    !requiredLegacyOutboxKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(row, key),
    ) ||
    keys.some((key) => !legacyOutboxKeys.has(key))
  ) {
    return false;
  }
  return (
    typeof row.itemId === "string" &&
    typeof row.answer === "string" &&
    typeof row.record === "boolean" &&
    typeof row.skillLabel === "string" &&
    typeof row.queuedAt === "number" &&
    Number.isFinite(row.queuedAt) &&
    (row.predictedConfidence === undefined ||
      isLegacyConfidence(row.predictedConfidence)) &&
    (row.breakerTriggerAttemptId === undefined ||
      typeof row.breakerTriggerAttemptId === "string") &&
    (row.breakerEasyTriggerAttemptId === undefined ||
      typeof row.breakerEasyTriggerAttemptId === "string") &&
    (row.suppressBreaker === undefined ||
      typeof row.suppressBreaker === "boolean") &&
    (row.prepareBreakerRepair === undefined ||
      typeof row.prepareBreakerRepair === "boolean")
  );
}

/** Returns `null` for every non-legacy byte string. An empty array is valid but
 * needs no rewrite because it is byte-compatible with the current format. */
export function parseLegacyWebPracticeOutboxV0(
  raw: string,
): LegacyWebPracticeOutboxAnswerV0[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(parsed) &&
    parsed.every(isLegacyWebPracticeOutboxAnswerV0)
    ? parsed
    : null;
}

function canonicalLegacyOutboxRow(
  row: LegacyWebPracticeOutboxAnswerV0,
): LegacyWebPracticeOutboxAnswerV0 {
  return {
    itemId: row.itemId,
    answer: row.answer,
    record: row.record,
    skillLabel: row.skillLabel,
    queuedAt: row.queuedAt,
    ...(row.predictedConfidence !== undefined
      ? { predictedConfidence: row.predictedConfidence }
      : {}),
    ...(row.breakerTriggerAttemptId !== undefined
      ? { breakerTriggerAttemptId: row.breakerTriggerAttemptId }
      : {}),
    ...(row.breakerEasyTriggerAttemptId !== undefined
      ? { breakerEasyTriggerAttemptId: row.breakerEasyTriggerAttemptId }
      : {}),
    ...(row.suppressBreaker !== undefined
      ? { suppressBreaker: row.suppressBreaker }
      : {}),
    ...(row.prepareBreakerRepair !== undefined
      ? { prepareBreakerRepair: row.prepareBreakerRepair }
      : {}),
  };
}

export type LegacyOutboxIdInput = {
  storageKey: string;
  position: number;
  row: LegacyWebPracticeOutboxAnswerV0;
};

/**
 * A deterministic, collision-resistant receipt for one predecessor row.
 * Including the versioned domain, scholar-specific storage key, row position,
 * and canonical row value keeps duplicate rows distinct while making retries,
 * reloads, and competing browser contexts derive the same identity.
 */
export async function deriveLegacyWebPracticeClientEventId({
  storageKey,
  position,
  row,
}: LegacyOutboxIdInput): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto is required to adopt a legacy practice outbox",
    );
  }
  const identity = JSON.stringify([
    LEGACY_OUTBOX_ID_DOMAIN,
    storageKey,
    position,
    canonicalLegacyOutboxRow(row),
  ]);
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `practice-answer:legacy-web-v0:${hex}`;
}

export type WebPracticeStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type WebPracticePersistenceOptions = {
  storage?: WebPracticeStorage;
  legacyClientEventId?: (
    input: LegacyOutboxIdInput,
  ) => Promise<string>;
};

// Module-scoped so Strict Mode mounts and separately-created adapters share the
// same adoption critical section. Writes/removes use it too: no current write
// can interleave between the legacy read and its same-key promotion.
const webStorageLock = createKeyedMutex();

function predictedConfidenceForSubmit(
  value: OutboxSubmitArgs["predictedConfidence"],
): WebPracticeSubmitArgs["predictedConfidence"] {
  switch (value) {
    case undefined:
    case "sure":
    case "think_so":
    case "not_sure":
      return value;
    default:
      throw new Error(`Invalid queued practice confidence: ${value}`);
  }
}

function practiceAttemptIdForSubmit(value: string): Id<"practiceAttempts"> {
  // The shared persistence contract keeps framework-specific IDs as strings;
  // Convex's mutation validator performs the runtime table check on replay.
  return value as Id<"practiceAttempts">;
}

/**
 * Build the one callback used by both live barrier submits and historical
 * outbox drains. The explicit object and `satisfies` keep Convex signature
 * changes compiler-visible while translating only the contract timing names.
 */
export function createWebPracticeSubmitter<T>(
  scholarId: Id<"users">,
  submit: (args: WebPracticeSubmitArgs) => Promise<T>,
): (args: OutboxSubmitArgs) => Promise<T> {
  return (args) => {
    const predictedConfidence = predictedConfidenceForSubmit(
      args.predictedConfidence,
    );
    const payload = {
      scholarId,
      itemId: args.itemId,
      answer: args.answer,
      clientEventId: args.clientEventId,
      record: args.record,
      replay: args.replay,
      submissionFingerprintVersion: 2 as const,
      ...(predictedConfidence !== undefined ? { predictedConfidence } : {}),
      ...(args.breakerTriggerAttemptId !== undefined
        ? {
            breakerTriggerAttemptId: practiceAttemptIdForSubmit(
              args.breakerTriggerAttemptId,
            ),
          }
        : {}),
      ...(args.breakerEasyTriggerAttemptId !== undefined
        ? {
            breakerEasyTriggerAttemptId: practiceAttemptIdForSubmit(
              args.breakerEasyTriggerAttemptId,
            ),
          }
        : {}),
      ...(args.suppressBreaker !== undefined
        ? { suppressBreaker: args.suppressBreaker }
        : {}),
      ...(args.prepareBreakerRepair !== undefined
        ? { prepareBreakerRepair: args.prepareBreakerRepair }
        : {}),
      ...(args.dontKnow !== undefined ? { dontKnow: args.dontKnow } : {}),
      ...(args.latencyMs !== undefined
        ? { firstKeyMs: args.latencyMs }
        : {}),
      ...(args.thinkTimeMs !== undefined
        ? { elapsedMs: args.thinkTimeMs }
        : {}),
    } satisfies WebPracticeSubmitArgs;
    // `satisfies` checks missing keys and value types, but TypeScript skips
    // excess-property checks for keys introduced by object spreads.
    const payloadHasNoExtraKeys: Exclude<
      keyof typeof payload,
      keyof WebPracticeSubmitArgs
    > extends never
      ? true
      : never = true;
    void payloadHasNoExtraKeys;
    return withPracticeSubmitTimeout(submit(payload));
  };
}

function requireLocalStorage(
  explicit?: WebPracticeStorage,
): WebPracticeStorage {
  if (explicit) return explicit;
  if (typeof window === "undefined") {
    throw new Error("localStorage is unavailable during server-side rendering");
  }
  return window.localStorage;
}

/**
 * The web adapter owns the one rolling-upgrade concern the shared contract
 * cannot: adopting the exact pre-id localStorage queue. Every outbox public path
 * reads through this adapter before it can submit or mutate, so promotion is
 * durably complete before any legacy answer reaches the network.
 */
export function createWebPracticePersistenceAdapter(
  options: WebPracticePersistenceOptions = {},
): KeyValueStorageAdapter {
  const legacyClientEventId =
    options.legacyClientEventId ??
    deriveLegacyWebPracticeClientEventId;
  return {
    kind: "web-local-storage",
    read(key) {
      if (!options.storage && typeof window === "undefined") {
        return Promise.resolve(null);
      }
      return webStorageLock(key, async () => {
        const storage = requireLocalStorage(options.storage);
        const raw = storage.getItem(key);
        if (
          raw === null ||
          !key.startsWith(OUTBOX_STORAGE_PREFIX) ||
          key.length === OUTBOX_STORAGE_PREFIX.length
        ) {
          return raw;
        }
        const legacy = parseLegacyWebPracticeOutboxV0(raw);
        if (!legacy || legacy.length === 0) return raw;

        const adopted = await Promise.all(
          legacy.map(async (row, position): Promise<OutboxAnswer> => ({
            clientEventId: await legacyClientEventId({
              storageKey: key,
              position,
              row,
            }),
            submissionReplay: true,
            ...canonicalLegacyOutboxRow(row),
          })),
        );
        const ids = adopted.map((row) => row.clientEventId);
        if (
          ids.some((id) => id.trim().length === 0) ||
          new Set(ids).size !== ids.length
        ) {
          throw new Error(
            "Legacy practice outbox adoption produced invalid submission ids",
          );
        }

        const promoted = JSON.stringify(adopted);
        // localStorage.setItem atomically replaces the old value or throws
        // without changing it. The throw deliberately propagates through the
        // read boundary: callers submit nothing and the legacy bytes remain
        // recoverable for the next access.
        storage.setItem(key, promoted);
        return promoted;
      });
    },
    write(key, value) {
      return webStorageLock(key, async () => {
        requireLocalStorage(options.storage).setItem(key, value);
      });
    },
    remove(key) {
      return webStorageLock(key, async () => {
        requireLocalStorage(options.storage).removeItem(key);
      });
    },
  };
}

export const webPracticePersistenceAdapter =
  createWebPracticePersistenceAdapter();
