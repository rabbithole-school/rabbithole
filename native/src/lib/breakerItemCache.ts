import {
  createKeyedMutex,
  readJsonResult,
  removeKey,
  writeJson,
  type KeyValueStorageAdapter,
  type PersistOutcome,
  type ReadResult,
} from "../../vendor/shared/practicePersistenceCore";

function breakerItemCacheKey(scholarId: string): string {
  return `rh-practice-breaker-item:${scholarId}`;
}

type BreakerItemCacheEntry<T> = {
  clientEventId: string;
  itemId: string;
  item: T;
  triggerAttemptId?: string;
};

interface BreakerItemCacheEnvelope<T> {
  v: 2;
  entries: BreakerItemCacheEntry<T>[];
}

interface LegacyBreakerItemCacheEnvelope<T> {
  v: 1;
  triggerAttemptId: string;
  itemId: string;
  item: T;
}

type StoredBreakerItemCache<T> =
  | BreakerItemCacheEnvelope<T>
  | LegacyBreakerItemCacheEnvelope<T>;

function isEntry<T>(value: unknown): value is BreakerItemCacheEntry<T> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BreakerItemCacheEntry<T>>;
  return (
    typeof candidate.clientEventId === "string" &&
    typeof candidate.itemId === "string" &&
    (candidate.triggerAttemptId === undefined ||
      typeof candidate.triggerAttemptId === "string") &&
    "item" in candidate
  );
}

function isStoredCache<T>(value: unknown): value is StoredBreakerItemCache<T> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredBreakerItemCache<T>>;
  if (candidate.v === 2) {
    return (
      "entries" in candidate &&
      Array.isArray(candidate.entries) &&
      candidate.entries.every(isEntry<T>)
    );
  }
  if (candidate.v === 1) {
    const legacy = candidate as Partial<LegacyBreakerItemCacheEnvelope<T>>;
    return (
      typeof legacy.triggerAttemptId === "string" &&
      typeof legacy.itemId === "string" &&
      "item" in legacy
    );
  }
  return false;
}

function currentEnvelope<T>(
  stored: StoredBreakerItemCache<T>,
): BreakerItemCacheEnvelope<T> {
  if (stored.v === 2) return stored;
  return {
    v: 2,
    entries: [
      {
        clientEventId: `legacy:${stored.triggerAttemptId}`,
        triggerAttemptId: stored.triggerAttemptId,
        itemId: stored.itemId,
        item: stored.item,
      },
    ],
  };
}

async function readEnvelope<T>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
): Promise<ReadResult<BreakerItemCacheEnvelope<T>>> {
  const result = await readJsonResult(
    adapter,
    breakerItemCacheKey(scholarId),
    (candidate): candidate is StoredBreakerItemCache<T> =>
      isStoredCache<T>(candidate),
  );
  return result.status === "ok"
    ? { status: "ok", value: currentEnvelope(result.value) }
    : result;
}

const cacheLock = createKeyedMutex();

function persistenceError(message: string): PersistOutcome {
  return { ok: false, error: new Error(message) };
}

/**
 * The trigger payload is native host state, not canonical practice state. The
 * server can commit a breaker in the same transaction that grades an ordinary
 * answer, so waiting for the reducer's `server:submitSucceeded` transition is
 * too late: the process can die after the commit but before a passive cache
 * effect runs.
 *
 * Every trigger-eligible submission is therefore staged here BEFORE the host
 * invokes or queues `submitAnswer`. Entries are keyed by the same
 * `clientEventId` as the outbox/server receipt so ambiguous failures and
 * replay remain one logical submission. Multiple entries matter: an older
 * queued answer can still be ahead of the item currently on screen.
 */
export async function stageBreakerTriggerItemPayload<T>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  args: { clientEventId: string; itemId: string; item: T },
): Promise<PersistOutcome> {
  const key = breakerItemCacheKey(scholarId);
  return cacheLock(key, async () => {
    const loaded = await readEnvelope<T>(adapter, scholarId);
    if (loaded.status === "invalid") {
      return { ok: false, error: loaded.error };
    }
    const envelope: BreakerItemCacheEnvelope<T> =
      loaded.status === "ok" ? loaded.value : { v: 2, entries: [] };
    const existing = envelope.entries.find(
      (entry) => entry.clientEventId === args.clientEventId,
    );
    if (existing && existing.itemId !== args.itemId) {
      return persistenceError(
        "Practice submission id was reused for a different trigger item",
      );
    }
    const next: BreakerItemCacheEnvelope<T> = {
      v: 2,
      entries: [
        ...envelope.entries.filter(
          (entry) => entry.clientEventId !== args.clientEventId,
        ),
        {
          clientEventId: args.clientEventId,
          itemId: args.itemId,
          item: args.item,
          ...(existing?.triggerAttemptId
            ? { triggerAttemptId: existing.triggerAttemptId }
            : {}),
        },
      ],
    };
    return writeJson(adapter, key, next);
  });
}

/**
 * Reconcile a definitive mutation receipt with its pre-submit payload. A
 * non-triggering answer can be removed. A threshold-crossing answer is bound
 * to the server attempt before later relaunches. On any read/write failure the
 * old bytes remain authoritative and are never overwritten with an empty
 * cache.
 */
export async function settleBreakerTriggerItemSubmission<T>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  args: { clientEventId: string; triggerAttemptId: string | null },
): Promise<PersistOutcome> {
  const key = breakerItemCacheKey(scholarId);
  return cacheLock(key, async () => {
    const loaded = await readEnvelope<T>(adapter, scholarId);
    if (loaded.status === "invalid") {
      return { ok: false, error: loaded.error };
    }
    if (loaded.status === "missing") {
      return args.triggerAttemptId
        ? persistenceError("Breaker trigger payload disappeared before its receipt settled")
        : { ok: true };
    }
    const index = loaded.value.entries.findIndex(
      (entry) => entry.clientEventId === args.clientEventId,
    );
    if (index < 0) {
      return args.triggerAttemptId
        ? persistenceError("Breaker trigger payload receipt has no staged item")
        : { ok: true };
    }
    const entries = [...loaded.value.entries];
    if (args.triggerAttemptId) {
      entries[index] = {
        ...entries[index],
        triggerAttemptId: args.triggerAttemptId,
      };
    } else {
      entries.splice(index, 1);
    }
    return entries.length === 0
      ? removeKey(adapter, key)
      : writeJson(adapter, key, { v: 2, entries } satisfies BreakerItemCacheEnvelope<T>);
  });
}

export type BreakerTriggerItemRestore<T> =
  | {
      status: "ready";
      item: T;
      source: "bound" | "candidate";
      bindingOutcome: PersistOutcome;
    }
  | { status: "missing" }
  | {
      status: "mismatch";
      cachedItemIds: string[];
      cachedTriggerAttemptIds: string[];
    }
  | { status: "unreadable"; error: unknown };

/**
 * Restore only the exact server-projected trigger item. An already-bound
 * attempt must match. An unbound candidate is safe to adopt because the item
 * id is the server's deterministic payload reference and a submission cannot
 * reach the server until that candidate write has completed.
 */
export async function restoreBreakerTriggerItemPayload<T>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  triggerAttemptId: string,
  triggerItemId: string,
): Promise<BreakerTriggerItemRestore<T>> {
  const key = breakerItemCacheKey(scholarId);
  return cacheLock(key, async () => {
    const loaded = await readEnvelope<T>(adapter, scholarId);
    if (loaded.status === "invalid") {
      return { status: "unreadable", error: loaded.error };
    }
    if (loaded.status === "missing") return { status: "missing" };

    const exact = loaded.value.entries.find(
      (entry) =>
        entry.triggerAttemptId === triggerAttemptId &&
        entry.itemId === triggerItemId,
    );
    if (exact) {
      return {
        status: "ready",
        item: exact.item,
        source: "bound",
        bindingOutcome: { ok: true },
      };
    }

    const candidates = loaded.value.entries.filter(
      (entry) =>
        entry.triggerAttemptId === undefined && entry.itemId === triggerItemId,
    );
    if (candidates.length === 0) {
      return {
        status: "mismatch",
        cachedItemIds: [...new Set(loaded.value.entries.map((entry) => entry.itemId))],
        cachedTriggerAttemptIds: [
          ...new Set(
            loaded.value.entries.flatMap((entry) =>
              entry.triggerAttemptId ? [entry.triggerAttemptId] : [],
            ),
          ),
        ],
      };
    }

    const candidateIds = new Set(
      candidates.map((candidate) => candidate.clientEventId),
    );
    const bound: BreakerItemCacheEnvelope<T> = {
      v: 2,
      entries: loaded.value.entries.map((entry) =>
        candidateIds.has(entry.clientEventId)
          ? { ...entry, triggerAttemptId }
          : entry,
      ),
    };
    const bindingOutcome = await writeJson(adapter, key, bound);
    return {
      status: "ready",
      item: candidates[0].item,
      source: "candidate",
      bindingOutcome,
    };
  });
}

/**
 * Remove only the episode the server has authoritatively stopped projecting.
 * Other queued candidates and other bound attempts survive untouched.
 */
export async function retireBreakerTriggerItemPayload<T>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  triggerAttemptId: string,
): Promise<PersistOutcome> {
  const key = breakerItemCacheKey(scholarId);
  return cacheLock(key, async () => {
    const loaded = await readEnvelope<T>(adapter, scholarId);
    if (loaded.status === "invalid") {
      return { ok: false, error: loaded.error };
    }
    if (loaded.status === "missing") return { ok: true };
    const entries = loaded.value.entries.filter(
      (entry) => entry.triggerAttemptId !== triggerAttemptId,
    );
    if (entries.length === loaded.value.entries.length) return { ok: true };
    return entries.length === 0
      ? removeKey(adapter, key)
      : writeJson(adapter, key, { v: 2, entries } satisfies BreakerItemCacheEnvelope<T>);
  });
}
