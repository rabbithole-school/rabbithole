import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { emptyDeck } from "../../shared/slidesScene";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TEXT_EL = { type: "text", frame: { x: 10, y: 10, w: 300, h: 90 }, text: "Hello" };

async function seedScholarSession(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Kai Kahale",
      username: "kai-slides-test",
      role: "scholar",
    });
    const otherId = await ctx.db.insert("users", {
      name: "Lani Kahale",
      username: "lani-slides-test",
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Volcanoes",
      isArchived: false,
    });
    return { scholarId, otherId, sessionId };
  });
}

describe("slides artifacts — AI path", () => {
  test("allows only media registered to the session owner", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, otherId, sessionId } = await seedScholarSession(t);
    const foreign = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])]));
      await ctx.db.insert("slideAssets", { storageId, uploaderId: otherId });
      return storageId;
    });

    const deck = emptyDeck("D", "sl1");
    deck.slides[0].elements.el1 = {
      id: "el1",
      type: "image",
      assetId: foreign,
      alt: "private image",
      frame: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    };
    deck.slides[0].elementIds.push("el1");
    const rejectedCreate = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(deck),
    });
    expect(rejectedCreate).toEqual({
      error: "That media isn't available to this deck.",
    });

    await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    const rejectedPatch = await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([
        {
          op: "addElement",
          slideId: "sl1",
          element: { type: "video", assetId: foreign, frame: {}, alt: "private video" },
        },
      ]),
    });
    expect(rejectedPatch).toEqual({
      error: "That media isn't available to this deck.",
    });

    const mine = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([4, 5, 6])])),
    );
    await t
      .withIdentity({ subject: scholarId })
      .mutation(api.artifacts.registerSlideAsset, { storageId: mine });
    const accepted = await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([
        {
          op: "addElement",
          slideId: "sl1",
          element: { type: "image", assetId: mine, frame: {}, alt: "my image" },
        },
      ]),
    });
    expect("artifactId" in accepted && accepted.artifactId).toBeTruthy();
  });

  test("REFUSES a second create rather than replacing an edited deck", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);
    const deckJson = JSON.stringify(emptyDeck("My deck", "sl1"));

    const first = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson,
    });
    expect("artifactId" in first && first.artifactId).toBeTruthy();
    if (!("artifactId" in first)) throw new Error("expected create to succeed");

    // The scholar does some work.
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
    });

    // A model calling `create` again in a later turn used to REPLACE the deck
    // wholesale, discarding everything absent from its payload.
    const second = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson,
    });
    expect("error" in second).toBe(true);
    if ("error" in second) expect(second.error).toMatch(/already exists/i);

    // The scholar's element survived.
    const read = await t.query(internal.artifacts.aiReadDeck, { sessionId });
    if ("error" in read) throw new Error(read.error);
    expect(read.summary).toContain("el1");
  });

  test("rejects malformed JSON and an invalid deck without writing", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);

    const bad = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: "{not json",
    });
    expect("error" in bad).toBe(true);

    const empty = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify({ slides: [] }),
    });
    expect("error" in empty).toBe(true);

    const rows = await t.run(async (ctx) => ctx.db.query("artifacts").collect());
    expect(rows).toHaveLength(0);
  });

  test("applies an op batch and mints ids deterministically", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);
    await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });

    const res = await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([
        { op: "addElement", slideId: "sl1", element: TEXT_EL },
      ]),
    });
    if ("error" in res) throw new Error(res.error);
    expect(res.createdIds).toEqual(["el1"]);
    expect(res.revision).toBe(1);
  });

  test("a stale baseRevision is refused rather than overwriting", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);
    await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    // Someone edits, moving revision 0 -> 1.
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
    });
    // A model that read revision 0 and thought for a while now tries to write.
    const stale = await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
      baseRevision: 0,
    });
    expect("error" in stale).toBe(true);
    if ("error" in stale) expect(stale.error).toContain("stale");

    // …and the earlier edit survived untouched.
    const read = await t.query(internal.artifacts.aiReadDeck, { sessionId });
    if ("error" in read) throw new Error(read.error);
    expect(read.revision).toBe(1);
  });

  test("refuses to patch a deck that does not exist yet", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);
    const res = await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "setTitle", title: "x" }]),
    });
    expect("error" in res).toBe(true);
  });

  test("aiReadDeck returns an id-addressed summary the model can patch against", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);
    await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
    });
    const read = await t.query(internal.artifacts.aiReadDeck, { sessionId });
    if ("error" in read) throw new Error(read.error);
    expect(read.summary).toContain("el1");
    expect(read.summary).toContain("sl1");
  });

  test("persists speaker notes through the canonical slide op path", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{
        op: "setSpeakerNotes",
        slideId: "sl1",
        notes: "Ask the room to predict the answer.",
      }]),
    });

    const row = await t.run(async (ctx) => ctx.db.get(created.artifactId));
    expect(JSON.parse(row!.content).slides[0].speakerNotes).toBe(
      "Ask the room to predict the answer.",
    );
    const read = await t.query(internal.artifacts.aiReadDeck, { sessionId });
    if ("error" in read) throw new Error(read.error);
    expect(read.summary).toContain("notes: Ask the room to predict the answer.");
  });
});

describe("slides artifacts — scholar path", () => {
  test("the owning scholar can edit their own deck", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    const res = await t
      .withIdentity({ subject: scholarId })
      .mutation(api.artifacts.scholarApplySlideOps, {
        artifactId: created.artifactId,
        ops: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
      });
    expect(res.conflict).toBe(false);
    expect(res.revision).toBe(1);
  });

  test("another scholar cannot edit someone else's deck", async () => {
    const t = convexTest(schema, modules);
    const { otherId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    await expect(
      t.withIdentity({ subject: otherId }).mutation(api.artifacts.scholarApplySlideOps, {
        artifactId: created.artifactId,
        ops: JSON.stringify([{ op: "setTitle", title: "hijacked" }]),
      }),
    ).rejects.toThrow();
  });

  test("a scholar edit reports a conflict instead of clobbering", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");
    // The AI edits while the scholar's editor still shows revision 0.
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
    });

    const res = await t
      .withIdentity({ subject: scholarId })
      .mutation(api.artifacts.scholarApplySlideOps, {
        artifactId: created.artifactId,
        ops: JSON.stringify([{ op: "setTitle", title: "mine" }]),
        baseRevision: 0,
      });
    expect(res.conflict).toBe(true);
    expect(res.revision).toBe(1);
  });

  test("an op batch with NO baseRevision still applies after an AI edit", async () => {
    // The scholar's clients deliberately omit baseRevision: their ops are
    // absolute and id-addressed, describing a gesture just performed, so a
    // tutor edit to a DIFFERENT element must not refuse them. Sending it was a
    // silent data-loss bug — the mutation RETURNS { conflict } rather than
    // throwing, and neither client read the result, so the kid's drag vanished.
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    // The tutor edits, moving revision 0 -> 1 while the kid's editor still
    // renders revision 0.
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
    });

    const res = await t
      .withIdentity({ subject: scholarId })
      .mutation(api.artifacts.scholarApplySlideOps, {
        artifactId: created.artifactId,
        ops: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
      });
    expect(res.conflict).toBe(false);
    expect(res.revision).toBe(2);

    // Both elements survive — the edits commuted rather than clobbering.
    const read = await t.query(internal.artifacts.aiReadDeck, { sessionId });
    if ("error" in read) throw new Error(read.error);
    expect(read.summary).toContain("el1");
    expect(read.summary).toContain("el2");
  });

  test("an op naming an element the tutor deleted fails loudly, not silently", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "addElement", slideId: "sl1", element: TEXT_EL }]),
    });
    await t.mutation(internal.artifacts.aiApplySlideOps, {
      sessionId,
      opsJson: JSON.stringify([{ op: "removeElement", slideId: "sl1", id: "el1" }]),
    });

    await expect(
      t.withIdentity({ subject: scholarId }).mutation(api.artifacts.scholarApplySlideOps, {
        artifactId: created.artifactId,
        ops: JSON.stringify([
          { op: "patchElement", slideId: "sl1", id: "el1", frame: { x: 5 } },
        ]),
      }),
    ).rejects.toThrow(/el1/);
  });

  test("refuses a media asset the scholar did not upload", async () => {
    // A storage id is NOT authorization: `_storage` is one namespace shared with
    // scanned health documents, so without this a scholar could reference any
    // id they learned and have the export action embed that blob for them.
    const t = convexTest(schema, modules);
    const { scholarId, otherId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    // An asset belonging to someone else.
    const foreign = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])]));
      await ctx.db.insert("slideAssets", { storageId, uploaderId: otherId });
      return storageId;
    });

    await expect(
      t.withIdentity({ subject: scholarId }).mutation(api.artifacts.scholarApplySlideOps, {
        artifactId: created.artifactId,
        ops: JSON.stringify([
          {
            op: "addElement",
            slideId: "sl1",
            element: { type: "video", assetId: foreign, frame: {}, alt: "x" },
          },
        ]),
      }),
    ).rejects.toThrow(/isn't available/i);
  });

  test("accepts a video the scholar registered themselves", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    const mine = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])])),
    );
    const asUser = t.withIdentity({ subject: scholarId });
    await asUser.mutation(api.artifacts.registerSlideAsset, { storageId: mine });

    const res = await asUser.mutation(api.artifacts.scholarApplySlideOps, {
      artifactId: created.artifactId,
      ops: JSON.stringify([
        {
          op: "addElement",
          slideId: "sl1",
          element: { type: "video", assetId: mine, frame: {}, alt: "x" },
        },
      ]),
    });
    expect(res.conflict).toBe(false);
  });

  test("persists a registered photo as a deck image that resolves from storage", async () => {
    // Both clients perform this same sequence: upload bytes, register the
    // storage ID, then emit addElement. Keeping it at the shared backend
    // boundary proves either client can only persist an authorized photo.
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
        type: "image/png",
      })),
    );
    const asScholar = t.withIdentity({ subject: scholarId });
    await asScholar.mutation(api.artifacts.registerSlideAsset, { storageId });
    const applied = await asScholar.mutation(api.artifacts.scholarApplySlideOps, {
      artifactId: created.artifactId,
      ops: JSON.stringify([{
        op: "addElement",
        slideId: "sl1",
        element: {
          type: "image",
          assetId: storageId,
          frame: { x: 80, y: 60, w: 480, h: 320, rotation: 0 },
          alt: "A photo",
        },
      }]),
    });
    expect(applied.conflict).toBe(false);

    const stored = await t.run(async (ctx) => ctx.db.get(created.artifactId));
    const deck = JSON.parse(stored!.content);
    const imageId = deck.slides[0].elementIds[0];
    expect(deck.slides[0].elements[imageId]).toMatchObject({
      type: "image",
      assetId: storageId,
      alt: "A photo",
    });
    const urls = await asScholar.query(api.files.getUrls, { storageIds: [storageId] });
    expect(urls).toEqual([{ storageId, url: expect.any(String) }]);
    const asset = await t.run(async (ctx) =>
      ctx.db.query("slideAssets")
        .withIndex("by_storage", (q) => q.eq("storageId", storageId))
        .first(),
    );
    expect(asset).toMatchObject({ storageId, uploaderId: scholarId });
  });

  test("a scholar edit marks the artifact as scholar-edited, not ai", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, sessionId } = await seedScholarSession(t);
    const created = await t.mutation(internal.artifacts.aiCreateSlidesDeck, {
      sessionId,
      deckJson: JSON.stringify(emptyDeck("D", "sl1")),
    });
    if (!created.artifactId) throw new Error("expected create to succeed");

    await t.withIdentity({ subject: scholarId }).mutation(api.artifacts.scholarApplySlideOps, {
      artifactId: created.artifactId,
      ops: JSON.stringify([{ op: "setTitle", title: "mine" }]),
    });
    const row = await t.run(async (ctx) => ctx.db.get(created.artifactId));
    expect(row?.lastEditedBy).toBe("scholar");
  });
});
