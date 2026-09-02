import { describe, expect, test } from "vitest";
import { createDraftSaveDrain } from "../draftSaveDrain";

describe("draft save drain", () => {
  test("coalesces edits made while a save is in flight", async () => {
    let draft = "first";
    let saved = "";
    const writes: string[] = [];
    const drain = createDraftSaveDrain({
      hasPending: () => draft !== saved,
      readDraft: () => draft,
      save: async (value) => {
        writes.push(value);
        if (value === "first") draft = "second";
        saved = value;
      },
    });

    await drain();
    expect(writes).toEqual(["first", "second"]);
    expect(saved).toBe("second");
  });

  test("shares one active drain and allows retry after failure", async () => {
    let saved = false;
    let attempts = 0;
    const drain = createDraftSaveDrain({
      hasPending: () => !saved,
      readDraft: () => "draft",
      save: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("conflict");
        saved = true;
      },
    });

    const first = drain();
    expect(drain()).toBe(first);
    await expect(first).rejects.toThrow("conflict");
    await drain();
    expect(attempts).toBe(2);
  });
});
