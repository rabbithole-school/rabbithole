import { describe, expect, it, vi } from "vitest";
import {
  createKeyedMutex,
  readJsonOrThrow,
  readJsonResult,
  removeKey,
  serializeByKey,
  writeJson,
  type KeyValueStorageAdapter,
} from "./practicePersistenceCore";

/** A synchronous, web-like adapter (mirrors localStorage: reads/writes settle
 *  immediately, but the contract still returns Promises). */
function memoryAdapter(opts?: { failWrites?: boolean }): KeyValueStorageAdapter {
  const store = new Map<string, string>();
  return {
    kind: "memory-sync",
    async read(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async write(key, value) {
      if (opts?.failWrites) throw new Error("disk full");
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

/** An async, native-like adapter: every operation yields a turn of the event
 *  loop (as a real file-system call would), so a test can observe interleaving
 *  if two operations against the same key race. */
function delayedAdapter(opts?: { failWrites?: boolean }): KeyValueStorageAdapter {
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
      if (opts?.failWrites) throw new Error("write failed");
      store.set(key, value);
    },
    async remove(key) {
      await tick();
      store.delete(key);
    },
  };
}

const adapters: Array<[string, (opts?: { failWrites?: boolean }) => KeyValueStorageAdapter]> = [
  ["synchronous/web-like", (opts) => memoryAdapter(opts)],
  ["asynchronous/native-like", (opts) => delayedAdapter(opts)],
];

describe.each(adapters)("practicePersistenceCore — %s adapter", (_label, makeAdapter) => {
  it("round-trips a JSON value", async () => {
    const adapter = makeAdapter();
    const outcome = await writeJson(adapter, "k", { a: 1 });
    expect(outcome).toEqual({ ok: true });
    const loaded = await readJsonOrThrow(
      adapter,
      "k",
      (v): v is { a: number } => typeof v === "object" && v !== null,
    );
    expect(loaded).toEqual({ a: 1 });
  });

  it("read returns null for a confirmed-missing key", async () => {
    const adapter = makeAdapter();
    const loaded = await readJsonOrThrow(adapter, "missing", (_v): _v is unknown => true);
    expect(loaded).toBeNull();
    const result = await readJsonResult(adapter, "missing", (_v): _v is unknown => true);
    expect(result).toEqual({ status: "missing" });
  });

  it("readJsonResult resolves 'ok' for a valid value", async () => {
    const adapter = makeAdapter();
    await writeJson(adapter, "k", { a: 1 });
    const result = await readJsonResult(
      adapter,
      "k",
      (v): v is { a: number } => typeof v === "object" && v !== null,
    );
    expect(result).toEqual({ status: "ok", value: { a: 1 } });
  });

  it("a value that fails shape validation is 'invalid', NEVER collapsed into 'missing'", async () => {
    const adapter = makeAdapter();
    await writeJson(adapter, "k", { wrong: "shape" });
    const isValid = (v: unknown): v is { a: number } =>
      typeof v === "object" && v !== null && typeof (v as { a?: unknown }).a === "number";
    const result = await readJsonResult(adapter, "k", isValid);
    expect(result.status).toBe("invalid");
    // The ergonomic throw-based twin must reject too, never resolve to null —
    // a caller must not be able to mistake "storage holds something we can't
    // trust" for "there was never anything here".
    await expect(readJsonOrThrow(adapter, "k", isValid)).rejects.toThrow();
  });

  it("bytes that aren't valid JSON are 'invalid', not 'missing'", async () => {
    const adapter = makeAdapter();
    await adapter.write("k", "{ not json");
    const isValid = (_v: unknown): _v is unknown => true;
    const result = await readJsonResult(adapter, "k", isValid);
    expect(result.status).toBe("invalid");
    await expect(readJsonOrThrow(adapter, "k", isValid)).rejects.toThrow();
  });

  it("an adapter-level read failure is 'invalid', not 'missing'", async () => {
    const adapter = makeAdapter();
    const throwingAdapter: KeyValueStorageAdapter = {
      ...adapter,
      read: () => Promise.reject(new Error("disk unreadable")),
    };
    const isValid = (_v: unknown): _v is unknown => true;
    const result = await readJsonResult(throwingAdapter, "k", isValid);
    expect(result.status).toBe("invalid");
    await expect(readJsonOrThrow(throwingAdapter, "k", isValid)).rejects.toThrow(
      "disk unreadable",
    );
  });

  it("removeKey durably removes a value", async () => {
    const adapter = makeAdapter();
    await writeJson(adapter, "k", { a: 1 });
    const outcome = await removeKey(adapter, "k");
    expect(outcome).toEqual({ ok: true });
    const loaded = await readJsonOrThrow(adapter, "k", (_v): _v is unknown => true);
    expect(loaded).toBeNull();
  });

  it("surfaces a write failure explicitly, never as a silent success", async () => {
    const adapter = makeAdapter({ failWrites: true });
    const outcome = await writeJson(adapter, "k", { a: 1 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(Error);
    // The failed write must not have landed.
    const loaded = await readJsonOrThrow(adapter, "k", (_v): _v is unknown => true);
    expect(loaded).toBeNull();
  });
});

describe("serializeByKey", () => {
  it("runs operations against the SAME key strictly in order", async () => {
    const adapter = delayedAdapter();
    const serialized = serializeByKey(adapter);
    const order: string[] = [];
    const a = serialized.write("k", "1").then(() => order.push("write-1"));
    const b = serialized.write("k", "2").then(() => order.push("write-2"));
    const c = serialized.read("k").then(() => order.push("read"));
    await Promise.all([a, b, c]);
    expect(order).toEqual(["write-1", "write-2", "read"]);
    expect(await serialized.read("k")).toBe("2");
  });

  it("a rejected operation does not wedge the queue for a later operation on the same key", async () => {
    const adapter = delayedAdapter({ failWrites: true });
    const serialized = serializeByKey(adapter);
    await expect(serialized.write("k", "1")).rejects.toThrow();
    // The next distinct call must still run (not hang forever behind the
    // failed one).
    await expect(serialized.read("k")).resolves.toBeNull();
  });

  it("different keys never block each other", async () => {
    const adapter = delayedAdapter();
    const serialized = serializeByKey(adapter);
    const spy = vi.fn();
    await Promise.all([
      serialized.write("k1", "1").then(spy),
      serialized.write("k2", "2").then(spy),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await serialized.read("k1")).toBe("1");
    expect(await serialized.read("k2")).toBe("2");
  });
});

describe("createKeyedMutex", () => {
  it("never interleaves a concurrent enqueue-style read-modify-write with a drain-style one", async () => {
    // Simulates the exact race this primitive exists to prevent: one caller
    // loads an array, appends, and saves (enqueue); another loads, removes
    // the first element, and saves (drain) — issued concurrently, each
    // WRAPPED end-to-end by the mutex for the same key (mirroring how
    // practiceOutboxContract.ts's enqueue/drain use it). A single adapter-op
    // lock is NOT enough here (the load and save are separate suspend
    // points) — the whole compound operation must be the atomic unit.
    const adapter = delayedAdapter();
    const run = createKeyedMutex();
    await adapter.write("queue", JSON.stringify(["a"]));

    async function enqueue(item: string) {
      return run("queue", async () => {
        const raw = await adapter.read("queue");
        const arr = JSON.parse(raw ?? "[]") as string[];
        arr.push(item);
        await adapter.write("queue", JSON.stringify(arr));
      });
    }
    async function drainFirst() {
      return run("queue", async () => {
        const raw = await adapter.read("queue");
        const arr = JSON.parse(raw ?? "[]") as string[];
        arr.shift();
        await adapter.write("queue", JSON.stringify(arr));
      });
    }

    await Promise.all([enqueue("b"), drainFirst()]);
    const final = JSON.parse((await adapter.read("queue")) ?? "[]") as string[];
    // Whichever order they ran in, both operations' effects must be present:
    // exactly one item removed (the original "a") AND "b" appended.
    expect(final).not.toContain("a");
    expect(final).toContain("b");
    expect(final).toHaveLength(1);
  });

  it("without the mutex, the same compound sequence CAN lose an update", async () => {
    // Negative control: proves the race above is real or the positive test
    // is vacuous. Same enqueue/drain shape, but issued directly against the
    // adapter with no mutex — the read-then-write is no longer atomic.
    const adapter = delayedAdapter();
    await adapter.write("queue", JSON.stringify(["a"]));

    async function enqueue(item: string) {
      const raw = await adapter.read("queue");
      const arr = JSON.parse(raw ?? "[]") as string[];
      arr.push(item);
      await adapter.write("queue", JSON.stringify(arr));
    }
    async function drainFirst() {
      const raw = await adapter.read("queue");
      const arr = JSON.parse(raw ?? "[]") as string[];
      arr.shift();
      await adapter.write("queue", JSON.stringify(arr));
    }

    await Promise.all([enqueue("b"), drainFirst()]);
    const final = JSON.parse((await adapter.read("queue")) ?? "[]") as string[];
    // Both reads observed ["a"]: enqueue writes ["a","b"], drain writes [] —
    // whichever lands last wins, so the surviving state is NEVER the correct
    // ["b"]. This documents why practiceOutboxContract.ts must not do this.
    expect(final).not.toEqual(["b"]);
  });
});
