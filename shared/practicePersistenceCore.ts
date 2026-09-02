/**
 * The ONE framework-agnostic persistence contract behind the practice drill's
 * durability guarantees on web AND native (layer 4 of the collapsed successor
 * stack — full web/native practice persistence parity). This file imports
 * nothing (no DOM, no React, no React Native), so it vendors into the native
 * bundle standalone (see native/scripts/sync-vendor.js) and is exercised by
 * one shared test suite against a synchronous web-like adapter and an
 * asynchronous native-like adapter.
 *
 * The contract is deliberately narrow: a key/value byte-string store with
 * explicit async read/write/remove, plus one wrapper (`serializeByKey`) that
 * makes concurrent operations against the SAME key safe. Everything domain-
 * specific (what a resume snapshot looks like, what an outbox entry looks
 * like, when a snapshot is still valid) lives in the sibling contract files
 * (`practiceResumeContract.ts`, `practiceOutboxContract.ts`) that are built on
 * top of this one.
 *
 * Failure is never hidden. `write`/`remove` reject on failure (a full disk, a
 * denied Safari-private-mode quota, an unwritable native document directory);
 * `writeJson`/`removeJson` below catch that rejection and return an explicit
 * `{ ok: false }` outcome rather than silently reporting success. A caller
 * that ignores the outcome is a bug, not a degraded-but-safe path — the whole
 * point of this layer is that "the answer was queued" is never claimed when
 * it wasn't durably written.
 *
 * Reads are held to the same standard: `readJsonResult` (and its throw-based
 * twin `readJsonOrThrow`) never collapses "the adapter threw", "the bytes
 * weren't valid JSON", and "the parsed value failed shape validation" into
 * the SAME outcome as "there was never anything saved here". A confirmed-
 * missing key is the only case where nothing was lost; everything else is an
 * explicit `invalid` outcome the caller must see, because a corrupt outbox or
 * resume snapshot silently read back as "empty"/"none" is precisely how a
 * queued answer disappears.
 */

/** A byte-string key/value store. Both the web (localStorage) and native
 *  (expo-file-system) adapters implement this; nothing here assumes either. */
export interface KeyValueStorageAdapter {
  /** A label for diagnostics only — never branches persistence behavior. */
  readonly kind: string;
  /** Null means "no value for this key", not an error. */
  read(key: string): Promise<string | null>;
  /** Rejects on failure — never resolves having silently dropped the write. */
  write(key: string, value: string): Promise<void>;
  /** Rejects on failure. Removing an already-absent key is NOT an error. */
  remove(key: string): Promise<void>;
}

/**
 * A per-key mutex: `run(key, task)` waits for any earlier task on the SAME
 * key to settle (success or failure) before starting, so two callers can
 * never interleave a "load → modify → save" against the same key. This is
 * the primitive `serializeByKey` uses internally for individual adapter
 * operations, and the primitive the outbox contract uses to make a whole
 * enqueue/drain (load-then-save) atomic against a concurrent caller — a
 * single-operation lock is NOT enough for that, because the load and the
 * save are two separate suspend points with an await between them.
 */
export function createKeyedMutex(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = queues.get(key) ?? Promise.resolve();
    // Chain the real task off the prior settlement (success OR failure) so one
    // rejected task never wedges the queue for later callers, then stash a
    // failure-swallowed copy purely for the queue's own bookkeeping — the
    // ORIGINAL rejection still propagates to whoever awaited `result` below.
    const result = prior.then(task, task);
    queues.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  };
}

/**
 * Wrap an adapter so every INDIVIDUAL read/write/remove call against the SAME
 * key runs to completion before the next one against that key starts —
 * guards against a torn/interleaved native file write from two overlapping
 * calls. This does NOT make a caller's own load-then-save sequence atomic
 * (see `createKeyedMutex` for that); it only guarantees each single adapter
 * call is never interleaved with another for the same key.
 */
export function serializeByKey(adapter: KeyValueStorageAdapter): KeyValueStorageAdapter {
  const run = createKeyedMutex();
  return {
    kind: adapter.kind,
    read: (key) => run(key, () => adapter.read(key)),
    write: (key, value) => run(key, () => adapter.write(key, value)),
    remove: (key) => run(key, () => adapter.remove(key)),
  };
}

/** The explicit result of a durable write/remove. Never collapsed to a
 *  boolean silently — callers must decide what an `ok: false` means for their
 *  own claim (e.g. "don't tell the scholar this was queued"). */
export type PersistOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * The explicit outcome of a read. This is the one place the "confirmed
 * missing key" case (`status: "missing"` — nothing was ever saved, or it was
 * durably cleared; there is nothing to lose) is distinguished from "storage
 * exists but couldn't be trusted" (`status: "invalid"` — the adapter itself
 * threw, the bytes weren't valid JSON, or the parsed value failed shape
 * validation). Collapsing those two into one `null` — the old behavior — is
 * exactly the bug this layer exists to close: a corrupt/unreadable outbox or
 * resume snapshot must never be silently treated as "there was never
 * anything here", because that invites a caller to start a fresh empty queue
 * (or a fresh run) OVER bytes that still hold a scholar's unacknowledged
 * answer.
 */
export type ReadResult<T> =
  | { status: "missing" }
  | { status: "ok"; value: T }
  | { status: "invalid"; error: unknown };

/** Read a key and JSON.parse it, validating shape, with NO broad catch that
 *  collapses a real failure into a success-shaped empty result. A missing key
 *  resolves to `{ status: "missing" }` — the only case nothing was lost. Both
 *  an adapter-level read failure and a value that fails to parse or fails
 *  `isValid` resolve to `{ status: "invalid", error }`, never silently to
 *  `missing`. */
export async function readJsonResult<T>(
  adapter: KeyValueStorageAdapter,
  key: string,
  isValid: (value: unknown) => value is T,
): Promise<ReadResult<T>> {
  let raw: string | null;
  try {
    raw = await adapter.read(key);
  } catch (error) {
    return { status: "invalid", error };
  }
  if (raw === null) return { status: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", error };
  }
  if (!isValid(parsed)) {
    return {
      status: "invalid",
      error: new Error(`Value stored for "${key}" failed shape validation`),
    };
  }
  return { status: "ok", value: parsed };
}

/**
 * The ergonomic twin of `readJsonResult` for callers that want the old
 * "await and branch on the value" shape rather than a discriminated union:
 * a confirmed-missing key resolves to `null` (nothing was lost — safe to
 * treat as an empty/fresh state), but unreadable/invalid storage REJECTS
 * rather than resolving to `null`, so a caller can never mistake "storage is
 * broken" for "there was never anything here". This is what
 * `loadOutbox`/`loadResumeSnapshot` are built on.
 */
export async function readJsonOrThrow<T>(
  adapter: KeyValueStorageAdapter,
  key: string,
  isValid: (value: unknown) => value is T,
): Promise<T | null> {
  const result = await readJsonResult(adapter, key, isValid);
  if (result.status === "missing") return null;
  if (result.status === "invalid") throw result.error;
  return result.value;
}

/** Serialize and durably write. Explicit failure — never throws, never
 *  pretends success; the caller must branch on `.ok`. */
export async function writeJson(
  adapter: KeyValueStorageAdapter,
  key: string,
  value: unknown,
): Promise<PersistOutcome> {
  try {
    await adapter.write(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Durably remove a key. Explicit failure, same convention as `writeJson`. */
export async function removeKey(
  adapter: KeyValueStorageAdapter,
  key: string,
): Promise<PersistOutcome> {
  try {
    await adapter.remove(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
