import { describe, expect, it } from "vitest";

import {
  restoreBreakerTriggerItemPayload,
  retireBreakerTriggerItemPayload,
  settleBreakerTriggerItemSubmission,
  stageBreakerTriggerItemPayload,
} from "@/lib/breakerItemCache";

import type { KeyValueStorageAdapter } from "../../../vendor/shared/practicePersistenceCore";

function memoryAdapter(): KeyValueStorageAdapter & {
  values: Map<string, string>;
  writeCount: number;
} {
  const values = new Map<string, string>();
  return {
    kind: "memory",
    values,
    writeCount: 0,
    read: async (key) => values.get(key) ?? null,
    write: async function write(key, value) {
      this.writeCount += 1;
      values.set(key, value);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

const ITEM = {
  itemId: "item-trigger",
  stem: "What is 2 + 2?",
  answerType: "integer",
};

describe("breaker trigger item cache", () => {
  it("stages the exact payload by server receipt before the attempt is known", async () => {
    const adapter = memoryAdapter();

    await expect(
      stageBreakerTriggerItemPayload(adapter, "scholar-1", {
        clientEventId: "event-1",
        itemId: ITEM.itemId,
        item: ITEM,
      }),
    ).resolves.toEqual({ ok: true });

    const restored = await restoreBreakerTriggerItemPayload<typeof ITEM>(
      adapter,
      "scholar-1",
      "attempt-1",
      ITEM.itemId,
    );
    expect(restored).toMatchObject({
      status: "ready",
      source: "candidate",
      item: ITEM,
      bindingOutcome: { ok: true },
    });
  });

  it("survives two independent relaunch reads with the same exact item and episode", async () => {
    const adapter = memoryAdapter();
    await stageBreakerTriggerItemPayload(adapter, "scholar-1", {
      clientEventId: "event-1",
      itemId: ITEM.itemId,
      item: ITEM,
    });

    const first = await restoreBreakerTriggerItemPayload<typeof ITEM>(
      adapter,
      "scholar-1",
      "attempt-1",
      ITEM.itemId,
    );
    const second = await restoreBreakerTriggerItemPayload<typeof ITEM>(
      adapter,
      "scholar-1",
      "attempt-1",
      ITEM.itemId,
    );

    expect(first).toMatchObject({
      status: "ready",
      source: "candidate",
      item: ITEM,
    });
    expect(second).toMatchObject({
      status: "ready",
      source: "bound",
      item: ITEM,
    });
  });

  it("keeps multiple queued submissions until each receipt is definitive", async () => {
    const adapter = memoryAdapter();
    const other = { ...ITEM, itemId: "item-other", stem: "What is 3 + 3?" };
    await stageBreakerTriggerItemPayload(adapter, "scholar-1", {
      clientEventId: "event-1",
      itemId: ITEM.itemId,
      item: ITEM,
    });
    await stageBreakerTriggerItemPayload(adapter, "scholar-1", {
      clientEventId: "event-2",
      itemId: other.itemId,
      item: other,
    });

    await settleBreakerTriggerItemSubmission(adapter, "scholar-1", {
      clientEventId: "event-2",
      triggerAttemptId: null,
    });

    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-1",
        ITEM.itemId,
      ),
    ).resolves.toMatchObject({ status: "ready", item: ITEM });
    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-2",
        other.itemId,
      ),
    ).resolves.toMatchObject({
      status: "mismatch",
      cachedItemIds: [ITEM.itemId],
    });
  });

  it("binds a definitive trigger receipt and retires only that server episode", async () => {
    const adapter = memoryAdapter();
    await stageBreakerTriggerItemPayload(adapter, "scholar-1", {
      clientEventId: "event-1",
      itemId: ITEM.itemId,
      item: ITEM,
    });
    await settleBreakerTriggerItemSubmission(adapter, "scholar-1", {
      clientEventId: "event-1",
      triggerAttemptId: "attempt-1",
    });

    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-1",
        ITEM.itemId,
      ),
    ).resolves.toMatchObject({ status: "ready", source: "bound", item: ITEM });

    await retireBreakerTriggerItemPayload(
      adapter,
      "scholar-1",
      "attempt-1",
    );
    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-1",
        ITEM.itemId,
      ),
    ).resolves.toEqual({ status: "missing" });
  });

  it("fails closed when a bound stale episode does not match the server projection", async () => {
    const adapter = memoryAdapter();
    await stageBreakerTriggerItemPayload(adapter, "scholar-1", {
      clientEventId: "event-old",
      itemId: ITEM.itemId,
      item: ITEM,
    });
    await settleBreakerTriggerItemSubmission(adapter, "scholar-1", {
      clientEventId: "event-old",
      triggerAttemptId: "attempt-old",
    });

    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-new",
        ITEM.itemId,
      ),
    ).resolves.toEqual({
      status: "mismatch",
      cachedItemIds: [ITEM.itemId],
      cachedTriggerAttemptIds: ["attempt-old"],
    });
  });

  it("keeps missing and unreadable storage distinct and never overwrites corrupt bytes", async () => {
    const adapter = memoryAdapter();
    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-1",
        ITEM.itemId,
      ),
    ).resolves.toEqual({ status: "missing" });

    const key = "rh-practice-breaker-item:scholar-1";
    adapter.values.set(key, "{broken");
    const original = adapter.values.get(key);
    const writesBefore = adapter.writeCount;

    const restored = await restoreBreakerTriggerItemPayload(
      adapter,
      "scholar-1",
      "attempt-1",
      ITEM.itemId,
    );
    expect(restored.status).toBe("unreadable");

    const staged = await stageBreakerTriggerItemPayload(
      adapter,
      "scholar-1",
      {
        clientEventId: "event-1",
        itemId: ITEM.itemId,
        item: ITEM,
      },
    );
    expect(staged.ok).toBe(false);
    expect(adapter.writeCount).toBe(writesBefore);
    expect(adapter.values.get(key)).toBe(original);
  });

  it("rejects receipt reuse for a different item without erasing the first payload", async () => {
    const adapter = memoryAdapter();
    await stageBreakerTriggerItemPayload(adapter, "scholar-1", {
      clientEventId: "event-1",
      itemId: ITEM.itemId,
      item: ITEM,
    });

    const reused = await stageBreakerTriggerItemPayload(
      adapter,
      "scholar-1",
      {
        clientEventId: "event-1",
        itemId: "item-other",
        item: { ...ITEM, itemId: "item-other" },
      },
    );
    expect(reused.ok).toBe(false);
    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-1",
        ITEM.itemId,
      ),
    ).resolves.toMatchObject({ status: "ready", item: ITEM });
  });

  it("reads the prior v1 cache without losing an already-active episode", async () => {
    const adapter = memoryAdapter();
    adapter.values.set(
      "rh-practice-breaker-item:scholar-1",
      JSON.stringify({
        v: 1,
        triggerAttemptId: "attempt-legacy",
        itemId: ITEM.itemId,
        item: ITEM,
      }),
    );

    await expect(
      restoreBreakerTriggerItemPayload(
        adapter,
        "scholar-1",
        "attempt-legacy",
        ITEM.itemId,
      ),
    ).resolves.toMatchObject({
      status: "ready",
      source: "bound",
      item: ITEM,
    });
  });
});
