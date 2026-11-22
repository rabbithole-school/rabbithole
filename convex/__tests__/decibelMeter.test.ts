import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  countFillers,
  countWords,
  meterCaption,
  peerName,
  pickerNames,
  selfIntroducedName,
} from "../decibelMeter";
import { makeScholar, makeWorld, type World } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;
type As = Awaited<ReturnType<World["as"]["scholar"]>>;

// Each save with a sound file schedules its transcription, and each upload
// its sweep. Fake timers keep those from running (and reaching for Whisper)
// unless a test asks for them.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Upload = { uploadId: Id<"decibelMeterUploads">; storageId: Id<"_storage"> };

/** Reserve an upload as `as`, land a blob, and bind it, the way the BunnyPad does. */
async function upload(t: T, as: As, kind: "video" | "poster" | "audio", type: string): Promise<Upload> {
  const { uploadId } = await as.mutation(api.decibelMeter.generateUploadUrl, { kind });
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([kind], { type })));
  await as.mutation(api.decibelMeter.recordUpload, { uploadId, storageId });
  return { uploadId, storageId };
}

async function uploads(t: T, as: As) {
  return {
    video: await upload(t, as, "video", "video/quicktime"),
    poster: await upload(t, as, "poster", "image/jpeg"),
    audio: await upload(t, as, "audio", "audio/mp4"),
  };
}

function takeArgs(u: { video: Upload; poster: Upload; audio?: Upload }) {
  return {
    videoUploadId: u.video.uploadId,
    posterUploadId: u.poster.uploadId,
    ...(u.audio ? { audioUploadId: u.audio.uploadId } : {}),
    durationMs: 90_000,
    levels: "AAAA",
    frameMs: 80,
    roomDbfs: -55,
    thresholdDb: 8,
  };
}

/** saveTake's answer for a take it accepted. */
function saved(result: { portfolioItemId: Id<"portfolioItems"> } | { refused: string }) {
  if ("refused" in result) throw new Error(`refused: ${result.refused}`);
  return result;
}

async function world(t: T): Promise<World> {
  return await makeWorld(t, { scholarsPerSchool: 2, parentsPerSchool: 0, includePlatformAdmin: false });
}

async function saveAs(t: T, as: As, extra: { scholarId?: Id<"users"> | null } = {}) {
  const u = await uploads(t, as);
  const { portfolioItemId } = saved(await as.mutation(api.decibelMeter.saveTake, { ...takeArgs(u), ...extra }));
  return { portfolioItemId, u };
}

describe("transcript and name helpers", () => {
  test("counts words and only the unmistakable fillers", () => {
    expect(countWords("Um, so today I'm going to, uh, talk about fish.")).toBe(10);
    expect(countFillers("Um, so today I'm, uh, like, umm, going to hmm talk.")).toBe(4);
  });

  test("finds a name the speaker gives for themselves near the start", () => {
    expect(selfIntroducedName("Hi everyone, I'm Avery and this is my project.")).toBe("Avery");
    expect(selfIntroducedName("My name is Avery Stone. Today I'll explain.")).toBe("Avery Stone");
    expect(selfIntroducedName("I'm going to tell you about volcanoes.")).toBeNull();
    // "This is …" as often introduces a partner or a picture.
    expect(selfIntroducedName("This is Kai, my partner, and I'm going first.")).toBeNull();
  });

  test("shows a classmate as first name and last initial", () => {
    expect(peerName({ name: "Avery Stone" })).toBe("Avery S.");
    expect(peerName({ firstName: "Kai", lastName: "Kahale", name: "Kai Kahale" })).toBe("Kai K.");
    expect(peerName({ name: "Lehua" })).toBe("Lehua");
  });

  test("gives the whole name only where two short names would match", () => {
    const id = (n: number) => `user${n}` as Id<"users">;
    expect(
      pickerNames([
        { _id: id(1), name: "Avery Stone" },
        { _id: id(2), name: "Avery Santos" },
        { _id: id(3), name: "Lehua Torres" },
      ]).map((r) => r.name),
    ).toEqual(["Avery Stone", "Avery Santos", "Lehua T."]);
  });

  test("captions a take with its opening words, length and pace", () => {
    expect(meterCaption("Hi, I'm Avery and I built a fish tank.", 60_000)).toBe(
      "“Hi, I'm Avery and I built a fish tank.” · 1:00 talk · 9 words a minute",
    );
    expect(meterCaption("", 5_000)).toBe("0:05 talk");
  });
});

describe("uploads belong to whoever reserved them", () => {
  test("a blob that existed before the reservation can't be bound", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const scholar = await w.as.scholar(w.schools[0].scholars[0]);
    // Someone else's file, its storage id seen in a served URL.
    const theirs = await t.run((ctx) =>
      ctx.storage.store(new Blob(["a teacher's resource"], { type: "application/pdf" })),
    );
    vi.setSystemTime(Date.now() + 60_000);
    const { uploadId } = await scholar.mutation(api.decibelMeter.generateUploadUrl, { kind: "video" });
    await expect(
      scholar.mutation(api.decibelMeter.recordUpload, { uploadId, storageId: theirs }),
    ).rejects.toThrow(/wasn't found/);
    expect(await t.run(async (ctx) => (await ctx.storage.get(theirs)) !== null)).toBe(true);
  });

  test("a blob another feature holds can't be bound", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const scholar = await w.as.scholar(home.scholars[0]);
    const { uploadId } = await scholar.mutation(api.decibelMeter.generateUploadUrl, { kind: "video" });
    const held = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["scan"], { type: "video/quicktime" }));
      await ctx.db.insert("portfolioItems", {
        institutionId: home.id,
        title: "Someone's scan",
        source: "upload",
        fileStorageId: storageId,
        matchStatus: "unmatched",
        processingStatus: "ready",
      });
      return storageId;
    });
    await expect(
      scholar.mutation(api.decibelMeter.recordUpload, { uploadId, storageId: held }),
    ).rejects.toThrow(/belongs to something else/);
  });

  test("another account can't save with someone else's uploads", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const a = await w.as.scholar(home.scholars[0]);
    const b = await w.as.scholar(home.scholars[1]);
    const u = await uploads(t, a);
    await expect(b.mutation(api.decibelMeter.saveTake, takeArgs(u))).rejects.toThrow(/wasn't found/);
    expect(await t.run(async (ctx) => (await ctx.storage.get(u.video.storageId)) !== null)).toBe(true);
  });

  test("the sweep deletes an upload no take adopted and keeps an adopted one", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const scholar = await w.as.scholar(w.schools[0].scholars[0]);
    const stray = await upload(t, scholar, "video", "video/quicktime");
    const { u } = await saveAs(t, scholar);
    await t.mutation(internal.decibelMeter.expireUpload, { uploadId: stray.uploadId });
    await t.mutation(internal.decibelMeter.expireUpload, { uploadId: u.video.uploadId });
    await t.run(async (ctx) => {
      expect(await ctx.storage.get(stray.storageId)).toBeNull();
      expect(await ctx.storage.get(u.video.storageId)).not.toBeNull();
    });
  });
});

describe("decibelMeter.saveTake", () => {
  test("an unnamed take lands in its school's inbox and nowhere else", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home, other] = w.schools;
    const { portfolioItemId } = await saveAs(t, await w.as.scholar(home.scholars[0]));

    const feed = await (await w.as.staffOf(home)).query(api.portfolio.scannerFeed, {});
    const row = feed.toReview.find((item) => item._id === portfolioItemId);
    expect(row).toMatchObject({ source: "decibel_meter", videoDurationMs: 90_000 });
    expect(row?.videoThumbUrl).toBeTruthy();

    const otherFeed = await (await w.as.staffOf(other)).query(api.portfolio.scannerFeed, {});
    expect(otherFeed.toReview.some((item) => item._id === portfolioItemId)).toBe(false);
  });

  test("a take named on the meter is filed to that scholar", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const speaker = home.scholars[1];
    const { portfolioItemId } = await saveAs(t, await w.as.scholar(home.scholars[0]), {
      scholarId: speaker.id,
    });
    const item = await t.run((ctx) => ctx.db.get(portfolioItemId));
    expect(item).toMatchObject({ matchStatus: "matched", scholarId: speaker.id, assignmentStatus: "none" });
    const feed = await (await w.as.staffOf(home)).query(api.portfolio.scannerFeed, {});
    expect(feed.processed.some((i) => i._id === portfolioItemId)).toBe(true);
  });

  test("refuses a speaker from another school, and deletes the caller's uploads", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home, other] = w.schools;
    const recorder = await w.as.scholar(home.scholars[0]);
    const u = await uploads(t, recorder);
    const result = await recorder.mutation(api.decibelMeter.saveTake, {
      ...takeArgs(u),
      scholarId: other.scholars[0].id,
    });
    expect(result).toEqual({ refused: "That scholar isn't at your school." });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("portfolioItems").collect()).toEqual([]);
      expect(await ctx.db.query("decibelMeterUploads").collect()).toEqual([]);
      for (const { storageId } of [u.video, u.poster, u.audio]) {
        expect(await ctx.storage.get(storageId)).toBeNull();
      }
    });
  });

  test("saving the same uploads twice returns the first save", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const recorder = await w.as.scholar(w.schools[0].scholars[0]);
    const args = takeArgs(await uploads(t, recorder));
    const first = saved(await recorder.mutation(api.decibelMeter.saveTake, args));
    const second = saved(await recorder.mutation(api.decibelMeter.saveTake, args));
    expect(second.portfolioItemId).toBe(first.portfolioItemId);
  });
});

describe("the recorder's hold", () => {
  test("only the recorder may name the speaker, and not after a teacher files it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const recorder = await w.as.scholar(home.scholars[0]);
    const { portfolioItemId } = await saveAs(t, recorder);

    const classmate = await w.as.scholar(home.scholars[1]);
    await expect(
      classmate.mutation(api.decibelMeter.setSpeaker, { portfolioItemId, scholarId: home.scholars[1].id }),
    ).rejects.toThrow(/wasn't found/);

    await recorder.mutation(api.decibelMeter.setSpeaker, { portfolioItemId, scholarId: home.scholars[1].id });
    const [mine] = await recorder.query(api.decibelMeter.takesForRecorder, {
      portfolioItemIds: [portfolioItemId],
    });
    expect(mine).toMatchObject({ speakerId: home.scholars[1].id, filedByTeacher: false });

    await (await w.as.staffOf(home)).mutation(api.portfolio.setAttributions, {
      itemId: portfolioItemId,
      scholarIds: [home.scholars[0].id],
    });
    await expect(
      recorder.mutation(api.decibelMeter.setSpeaker, { portfolioItemId, scholarId: null }),
    ).rejects.toThrow(/teacher has filed/);
    await expect(recorder.mutation(api.decibelMeter.discardTake, { portfolioItemId })).rejects.toThrow(
      /teacher has filed/,
    );
  });

  test("any staff edit ends the hold for good, even a label", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const recorder = await w.as.scholar(home.scholars[0]);
    const { portfolioItemId } = await saveAs(t, recorder);
    await (await w.as.staffOf(home)).mutation(api.portfolio.setLabels, {
      itemIds: [portfolioItemId],
      label: "Volcano talk",
    });
    await expect(recorder.mutation(api.decibelMeter.discardTake, { portfolioItemId })).rejects.toThrow(
      /teacher has filed/,
    );
    const [mine] = await recorder.query(api.decibelMeter.takesForRecorder, {
      portfolioItemIds: [portfolioItemId],
    });
    expect(mine.filedByTeacher).toBe(true);
  });

  test("a teacher sending a take back to the inbox still ends the hold", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const recorder = await w.as.scholar(home.scholars[0]);
    const { portfolioItemId } = await saveAs(t, recorder, { scholarId: home.scholars[1].id });
    await (await w.as.staffOf(home)).mutation(api.portfolio.setAttributions, {
      itemId: portfolioItemId,
      scholarIds: [],
    });
    await expect(
      recorder.mutation(api.decibelMeter.setSpeaker, { portfolioItemId, scholarId: home.scholars[1].id }),
    ).rejects.toThrow(/teacher has filed/);
  });

  test("someone who has left the school loses their say and their view", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home, other] = w.schools;
    const scholar = home.scholars[0];
    const recorder = await w.as.scholar(scholar);
    const { portfolioItemId } = await saveAs(t, recorder);
    await t.run((ctx) => ctx.db.patch(scholar.id, { institutionId: other.id }));
    expect(
      await recorder.query(api.decibelMeter.takesForRecorder, { portfolioItemIds: [portfolioItemId] }),
    ).toEqual([]);
    await expect(recorder.mutation(api.decibelMeter.discardTake, { portfolioItemId })).rejects.toThrow(
      /wasn't found/,
    );
  });

  test("naming and then clearing the speaker leaves the take unfiled for staff", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const recorder = await w.as.scholar(home.scholars[0]);
    const { portfolioItemId } = await saveAs(t, recorder, { scholarId: home.scholars[1].id });
    await recorder.mutation(api.decibelMeter.setSpeaker, { portfolioItemId, scholarId: null });
    const item = await t.run((ctx) => ctx.db.get(portfolioItemId));
    expect(item).toMatchObject({ matchStatus: "unmatched" });
    expect(item?.firstFiledAt).toBeUndefined();
  });

  test("discarding deletes the item, its take row and every blob", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const recorder = await w.as.scholar(w.schools[0].scholars[0]);
    const { portfolioItemId, u } = await saveAs(t, recorder);
    await recorder.mutation(api.decibelMeter.discardTake, { portfolioItemId });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(portfolioItemId)).toBeNull();
      expect(await ctx.db.query("decibelMeterTakes").collect()).toEqual([]);
      for (const { storageId } of [u.video, u.poster, u.audio]) {
        expect(await ctx.storage.get(storageId)).toBeNull();
      }
    });
  });
});

describe("transcripts", () => {
  test("a speaker who says their name is filed to them, and the sound file goes", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const avery = await makeScholar(t, home, { name: "Avery Stone" });
    const { portfolioItemId, u } = await saveAs(t, await w.as.scholar(home.scholars[0]));

    await t.mutation(internal.decibelMeter.saveTranscript, {
      portfolioItemId,
      text: "Hi, I'm Avery, and um, I built a fish tank.",
      segments: [[0, 4000, "Hi, I'm Avery, and um, I built a fish tank."]],
    });

    await t.run(async (ctx) => {
      const item = await ctx.db.get(portfolioItemId);
      expect(item).toMatchObject({
        scholarId: avery.id,
        matchStatus: "matched",
        detectedName: "Avery",
        extractedText: "Hi, I'm Avery, and um, I built a fish tank.",
      });
      expect(item?.aiCaption).toContain("1:30 talk");
      const [take] = await ctx.db.query("decibelMeterTakes").collect();
      expect(take).toMatchObject({ transcriptStatus: "ready", wordCount: 10, fillerCount: 1 });
      expect(take.audioStorageId).toBeUndefined();
      expect(await ctx.storage.get(u.audio.storageId)).toBeNull();
    });
  });

  test("the recorder can still correct or discard a take the transcript filed", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    await makeScholar(t, home, { name: "Avery Stone" });
    const recorder = await w.as.scholar(home.scholars[0]);
    const { portfolioItemId } = await saveAs(t, recorder);
    await t.mutation(internal.decibelMeter.saveTranscript, { portfolioItemId, text: "Hi, I'm Avery.", segments: [] });
    const [mine] = await recorder.query(api.decibelMeter.takesForRecorder, {
      portfolioItemIds: [portfolioItemId],
    });
    expect(mine).toMatchObject({ speakerName: "Avery S.", filedByTeacher: false });
    await recorder.mutation(api.decibelMeter.setSpeaker, { portfolioItemId, scholarId: home.scholars[1].id });
    await recorder.mutation(api.decibelMeter.discardTake, { portfolioItemId });
    expect(await t.run((ctx) => ctx.db.get(portfolioItemId))).toBeNull();
  });

  test("never files a take the recorder left for a teacher, before or after saving", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    await makeScholar(t, home, { name: "Avery Stone" });
    const recorder = await w.as.scholar(home.scholars[0]);
    // Left for a teacher with the save itself.
    const first = await saveAs(t, recorder, { scholarId: null });
    // Named, then cleared after saving.
    const second = await saveAs(t, recorder, { scholarId: home.scholars[1].id });
    await recorder.mutation(api.decibelMeter.setSpeaker, {
      portfolioItemId: second.portfolioItemId,
      scholarId: null,
    });
    for (const { portfolioItemId } of [first, second]) {
      await t.mutation(internal.decibelMeter.saveTranscript, { portfolioItemId, text: "I'm Avery.", segments: [] });
      const item = await t.run((ctx) => ctx.db.get(portfolioItemId));
      expect(item).toMatchObject({ matchStatus: "unmatched", detectedName: "Avery" });
    }
  });

  test("a name the meter gave is never replaced by the transcript's", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    await makeScholar(t, home, { name: "Avery Stone" });
    const { portfolioItemId } = await saveAs(t, await w.as.scholar(home.scholars[0]), {
      scholarId: home.scholars[1].id,
    });
    await t.mutation(internal.decibelMeter.saveTranscript, { portfolioItemId, text: "I'm Avery.", segments: [] });
    const item = await t.run((ctx) => ctx.db.get(portfolioItemId));
    expect(item?.scholarId).toBe(home.scholars[1].id);
  });
});

describe("deleting", () => {
  test("a teacher deleting the item from the inbox takes the take row and sound with it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home] = w.schools;
    const { portfolioItemId, u } = await saveAs(t, await w.as.scholar(home.scholars[0]));
    await (await w.as.staffOf(home)).mutation(api.portfolio.deleteItem, { itemId: portfolioItemId });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("decibelMeterTakes").collect()).toEqual([]);
      expect(await ctx.storage.get(u.audio.storageId)).toBeNull();
    });
  });
});

describe("speakers", () => {
  test("lists only the caller's own school", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const [home, other] = w.schools;
    const ids = (await (await w.as.scholar(home.scholars[0])).query(api.decibelMeter.speakers, {})).map(
      (s) => s.id,
    );
    expect(ids).toEqual(expect.arrayContaining(home.scholars.map((s) => s.id)));
    expect(ids.some((id) => other.scholars.some((s) => s.id === id))).toBe(false);
  });
});
