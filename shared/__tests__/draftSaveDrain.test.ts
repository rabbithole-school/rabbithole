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

  test("a read-only pending draft does not loop the drain", async () => {
    // Play mode (N1): the viewer is read-only, so its `save` is a no-op that
    // never clears the pending condition (draft still differs from saved).
    // `hasPending` folds in read-only exactly as CodeArtifactViewer does, so
    // the drain must settle in ZERO iterations instead of spinning forever and
    // blocking every tutor send (flushAllArtifactSaves awaits it).
    const readOnly: boolean = true;
    const draft: string = "unsaved-play-draft";
    const saved: string = "server-truth";
    let iterations = 0;
    const drain = createDraftSaveDrain({
      hasPending: () => !readOnly && draft !== saved,
      readDraft: () => draft,
      save: async () => {
        iterations += 1;
        // Bounded guard: without the read-only fold this would never stop.
        if (iterations > 50) throw new Error("drain looped in read-only mode");
      },
    });

    await drain();
    expect(iterations).toBe(0);
  });
});
