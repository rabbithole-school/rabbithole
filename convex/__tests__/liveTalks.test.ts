import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  LISTENER_STALE_MS,
  TALK_STALE_MS,
  UPLOAD_EXPIRY_MS,
} from "../liveTalks";
import { makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const T0 = Date.parse("2026-11-17T20:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const SLIDES = {
  kind: "slides" as const,
  mode: "present" as const,
  title: "Why volcanoes sing",
  slideCount: 5,
  slideIndex: 0,
};

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 3,
    parentsPerSchool: 1,
    includePlatformAdmin: false,
  });
  const [moli, kona] = world.schools;
  return {
    t,
    world,
    moli,
    kona,
    // Kai presents; Lani is a classmate at the back; Oliver is another classmate.
    presenter: await world.as.scholar(moli.scholars[0]),
    classmate: await world.as.scholar(moli.scholars[1]),
    otherClassmate: await world.as.scholar(moli.scholars[2]),
    teacher: await world.as.staffOf(moli),
    opsStaff: await world.as.staffOf(moli, "staff"),
    parent: await world.as.parent(moli.parents[0]),
    otherSchoolScholar: await world.as.scholar(kona.scholars[0]),
    otherSchoolTeacher: await world.as.staffOf(kona),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function talk(s: Setup, id: Id<"liveTalks">) {
  return await s.t.run((ctx) => ctx.db.get(id));
}

async function recordingsFor(s: Setup, id: Id<"liveTalks">) {
  return await s.t.run((ctx) =>
    ctx.db
      .query("talkRecordings")
      .withIndex("by_talk", (q) => q.eq("talkId", id))
      .collect(),
  );
}

/** Join, record one take, stop: returns the take's recording id. */
async function recordOneTake(s: Setup, takeId = "take-1") {
  const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
  await s.classmate.mutation(api.liveTalks.join, { talkId });
  await s.presenter.mutation(api.liveTalks.startRecording, { talkId, takeId });
  await s.presenter.mutation(api.liveTalks.stopRecording, { talkId });
  const [row] = await recordingsFor(s, talkId);
  return { talkId, recordingId: row!._id };
}

async function storeVideo(s: Setup) {
  return await s.t.run((ctx) =>
    ctx.storage.store(new Blob(["back row"], { type: "video/mp4" })),
  );
}

function uploadArgs(recordingId: Id<"talkRecordings">, storageId: Id<"_storage">) {
  return {
    recordingId,
    storageId,
    mimeType: "video/mp4",
    sizeBytes: 999,
    durationMs: 42_000,
    levels: "AAECAw==",
    frameMs: 80,
    roomDbfs: -48.5,
    cameraStartedAtClient: 1_700_000_000_000,
  };
}

describe("audience list", () => {
  test("shows a talk to its school's scholars and teachers only", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);

    const expected = [
      {
        talkId,
        presenterName: "Kai",
        kind: "slides",
        title: "Why volcanoes sing",
        mode: "present",
        state: "waiting",
        listening: null,
      },
    ];
    expect(await s.classmate.query(api.liveTalks.listForAudience, {})).toEqual(
      expected,
    );
    expect(await s.teacher.query(api.liveTalks.listForAudience, {})).toEqual(
      expected,
    );

    expect(
      await s.otherSchoolScholar.query(api.liveTalks.listForAudience, {}),
    ).toEqual([]);
    expect(
      await s.otherSchoolTeacher.query(api.liveTalks.listForAudience, {}),
    ).toEqual([]);
    expect(await s.parent.query(api.liveTalks.listForAudience, {})).toBeNull();
    // The presenter's own talk is not in their audience list.
    expect(await s.presenter.query(api.liveTalks.listForAudience, {})).toEqual(
      [],
    );
  });

  test("lists newest first and drops ended talks", async () => {
    const s = await setup();
    const first = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    vi.advanceTimersByTime(1_000);
    const second = await s.otherClassmate.mutation(api.liveTalks.begin, {
      ...SLIDES,
      kind: "app",
      mode: "rehearse",
      title: "Tide clock",
      slideCount: 0,
      slideIndex: 0,
    });

    const rows = await s.classmate.query(api.liveTalks.listForAudience, {});
    expect(rows?.map((r) => [r.talkId, r.kind, r.mode])).toEqual([
      [second, "app", "rehearse"],
      [first, "slides", "present"],
    ]);

    await s.presenter.mutation(api.liveTalks.end, { talkId: first });
    const after = await s.classmate.query(api.liveTalks.listForAudience, {});
    expect(after?.map((r) => r.talkId)).toEqual([second]);
  });

  test("a parent or another school cannot begin or join", async () => {
    const s = await setup();
    await expect(
      s.parent.mutation(api.liveTalks.begin, SLIDES),
    ).rejects.toMatchObject({ data: { kind: "no_school" } });

    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await expect(
      s.otherSchoolTeacher.mutation(api.liveTalks.join, { talkId }),
    ).rejects.toMatchObject({ data: { kind: "not_found" } });
    await expect(
      s.parent.mutation(api.liveTalks.join, { talkId }),
    ).rejects.toMatchObject({ data: { kind: "no_school" } });
  });
});

describe("begin", () => {
  test("ends the presenter's earlier live talk", async () => {
    const s = await setup();
    const first = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    const second = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    expect(await talk(s, first)).toMatchObject({
      state: "ended",
      endedAt: T0,
      endedReason: "replaced",
    });
    expect((await talk(s, second))?.state).toBe("waiting");
    // The replaced device is told why, so it does not begin again and end
    // the new talk in turn.
    expect(
      await s.presenter.mutation(api.liveTalks.heartbeat, { talkId: first }),
    ).toEqual({ state: "ended", endedReason: "replaced" });
    expect(
      await s.presenter.query(api.liveTalks.forPresenter, { talkId: first }),
    ).toEqual({ state: "ended", endedReason: "replaced", listener: null });
  });

  test("validates title, slide numbers and kind", async () => {
    const s = await setup();
    const bad = [
      { ...SLIDES, title: "x".repeat(201) },
      { ...SLIDES, slideCount: 0 },
      { ...SLIDES, slideIndex: 5 },
      { ...SLIDES, slideIndex: 1.5 },
      { ...SLIDES, slideIndex: -1 },
      { ...SLIDES, kind: "app" as const, slideCount: -1, slideIndex: 0 },
    ];
    for (const args of bad) {
      await expect(
        s.presenter.mutation(api.liveTalks.begin, args),
      ).rejects.toMatchObject({ data: { kind: "invalid" } });
    }
    // An app talk has no slides.
    const appTalk = await s.presenter.mutation(api.liveTalks.begin, {
      ...SLIDES,
      kind: "app",
      slideCount: 0,
      slideIndex: 0,
    });
    expect((await talk(s, appTalk))?.kind).toBe("app");
  });

  test("showSlide moves within the deck and refuses past its end", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.presenter.mutation(api.liveTalks.showSlide, { talkId, slideIndex: 4 });
    expect((await talk(s, talkId))?.slideIndex).toBe(4);
    await expect(
      s.presenter.mutation(api.liveTalks.showSlide, { talkId, slideIndex: 5 }),
    ).rejects.toMatchObject({ data: { kind: "invalid" } });
    await expect(
      s.classmate.mutation(api.liveTalks.showSlide, { talkId, slideIndex: 1 }),
    ).rejects.toMatchObject({ data: { kind: "not_found" } });
  });
});

describe("linking a listener", () => {
  test("join, someone else listening, leave", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);

    await s.classmate.mutation(api.liveTalks.join, { talkId });
    expect(
      (await s.classmate.query(api.liveTalks.listForAudience, {}))?.[0]?.listening,
    ).toBe("me");
    expect(
      (await s.teacher.query(api.liveTalks.listForAudience, {}))?.[0]?.listening,
    ).toBe("someone");
    expect(
      await s.presenter.query(api.liveTalks.forPresenter, { talkId }),
    ).toEqual({ state: "waiting", endedReason: null, listener: { name: "Lani" } });

    const refused = s.teacher.mutation(api.liveTalks.join, { talkId });
    await expect(refused).rejects.toMatchObject({
      data: {
        kind: "someone_listening",
        message: "Someone else is already listening",
      },
    });
    // Joining again is harmless.
    await s.classmate.mutation(api.liveTalks.join, { talkId });

    await s.classmate.mutation(api.liveTalks.leave, { talkId });
    expect(
      await s.presenter.query(api.liveTalks.forPresenter, { talkId }),
    ).toEqual({ state: "waiting", endedReason: null, listener: null });
    await s.teacher.mutation(api.liveTalks.join, { talkId });
    expect((await talk(s, talkId))?.listenerId).toBe(s.moli.teacher.id);
  });

  test("the presenter cannot be their own audience", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await expect(
      s.presenter.mutation(api.liveTalks.join, { talkId }),
    ).rejects.toMatchObject({ data: { kind: "own_talk" } });
  });

  test("joining one talk leaves the other", async () => {
    const s = await setup();
    const first = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    const second = await s.otherClassmate.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId: first });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId: first,
      takeId: "take-1",
    });

    await s.classmate.mutation(api.liveTalks.join, { talkId: second });
    expect((await talk(s, first))?.listenerId).toBeUndefined();
    expect((await talk(s, second))?.listenerId).toBe(s.moli.scholars[1].id);
    expect((await recordingsFor(s, first)).map((r) => r.status)).toEqual([
      "failed",
    ]);
  });

  test("dropListener unlinks and fails a take in progress", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });

    await s.presenter.mutation(api.liveTalks.dropListener, { talkId });
    expect((await talk(s, talkId))?.listenerId).toBeUndefined();
    const listenerView = await s.classmate.query(api.liveTalks.forListener, {
      talkId,
    });
    expect(listenerView).toMatchObject({
      connected: false,
      recording: { takeId: "take-1", status: "failed" },
    });
    // Only the presenter may drop.
    await expect(
      s.classmate.mutation(api.liveTalks.dropListener, { talkId }),
    ).rejects.toMatchObject({ data: { kind: "not_found" } });
  });

  test("leave fails the caller's take in progress", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    await s.classmate.mutation(api.liveTalks.leave, { talkId });
    expect((await recordingsFor(s, talkId)).map((r) => r.status)).toEqual([
      "failed",
    ]);
  });

  test("forListener is null for someone who never listened", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    expect(
      await s.otherClassmate.query(api.liveTalks.forListener, { talkId }),
    ).toBeNull();
    expect(
      await s.otherSchoolScholar.query(api.liveTalks.forPresenter, { talkId }),
    ).toBeNull();
  });
});

describe("recording takes", () => {
  test("without a listener nothing is recorded at the back", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    expect(
      await s.presenter.mutation(api.liveTalks.startRecording, {
        talkId,
        takeId: "take-1",
      }),
    ).toEqual({ withListener: false });
    expect((await talk(s, talkId))?.state).toBe("recording");
    await s.presenter.mutation(api.liveTalks.stopRecording, { talkId });
    expect((await talk(s, talkId))?.state).toBe("waiting");
    expect(await recordingsFor(s, talkId)).toEqual([]);
  });

  test("with a listener a take opens a row that stop moves to uploading", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    expect(
      await s.presenter.mutation(api.liveTalks.startRecording, {
        talkId,
        takeId: "take-1",
      }),
    ).toEqual({ withListener: true });
    // A retried start for the same take does not open a second row.
    expect(
      await s.presenter.mutation(api.liveTalks.startRecording, {
        talkId,
        takeId: "take-1",
      }),
    ).toEqual({ withListener: true });

    const during = await s.classmate.query(api.liveTalks.forListener, { talkId });
    expect(during).toMatchObject({
      state: "recording",
      presenterName: "Kai",
      kind: "slides",
      title: "Why volcanoes sing",
      slideIndex: 0,
      slideCount: 5,
      takeId: "take-1",
      connected: true,
      recording: { takeId: "take-1", status: "recording" },
    });

    await s.presenter.mutation(api.liveTalks.stopRecording, { talkId });
    expect((await talk(s, talkId))?.state).toBe("waiting");
    const rows = await recordingsFor(s, talkId);
    expect(rows.map((r) => [r.takeId, r.status, r.startedAt])).toEqual([
      ["take-1", "uploading", T0],
    ]);

    // A finished take id cannot be started again.
    await expect(
      s.presenter.mutation(api.liveTalks.startRecording, {
        talkId,
        takeId: "take-1",
      }),
    ).rejects.toMatchObject({ data: { kind: "invalid" } });
  });

  test("a new take while recording stops the old one", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-2",
    });
    const rows = await recordingsFor(s, talkId);
    expect(
      rows.map((r) => [r.takeId, r.status]).sort(([a], [b]) => a!.localeCompare(b!)),
    ).toEqual([
      ["take-1", "uploading"],
      ["take-2", "recording"],
    ]);
  });

  test("end stops the take, is idempotent, and refuses a new take", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    await s.presenter.mutation(api.liveTalks.end, { talkId });
    await s.presenter.mutation(api.liveTalks.end, { talkId });
    expect(
      await s.presenter.query(api.liveTalks.forPresenter, { talkId }),
    ).toEqual({ state: "ended", endedReason: "left", listener: { name: "Lani" } });
    expect((await recordingsFor(s, talkId))[0]?.status).toBe("uploading");
    // The listener still sees the talk end and can finish the upload.
    expect(
      await s.classmate.query(api.liveTalks.forListener, { talkId }),
    ).toMatchObject({ state: "ended", connected: true });
    await expect(
      s.presenter.mutation(api.liveTalks.startRecording, {
        talkId,
        takeId: "take-2",
      }),
    ).rejects.toMatchObject({ data: { kind: "ended" } });
  });

  test("validates the take id", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    for (const takeId of ["", "   ", "x".repeat(101)]) {
      await expect(
        s.presenter.mutation(api.liveTalks.startRecording, { talkId, takeId }),
      ).rejects.toMatchObject({ data: { kind: "invalid" } });
    }
  });
});

describe("uploading the back-row video", () => {
  test("only the row's listener may get an upload URL or finish", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);

    for (const other of [s.presenter, s.otherClassmate, s.teacher]) {
      await expect(
        other.mutation(api.liveTalks.generateUploadUrl, { recordingId }),
      ).rejects.toMatchObject({ data: { kind: "not_found" } });
      await expect(
        other.mutation(api.liveTalks.finishUpload, uploadArgs(recordingId, storageId)),
      ).rejects.toMatchObject({ data: { kind: "not_found" } });
      await expect(
        other.mutation(api.liveTalks.markUploadFailed, { recordingId }),
      ).rejects.toMatchObject({ data: { kind: "not_found" } });
    }

    expect(
      typeof (await s.classmate.mutation(api.liveTalks.generateUploadUrl, {
        recordingId,
      })),
    ).toBe("string");
    await s.classmate.mutation(
      api.liveTalks.finishUpload,
      uploadArgs(recordingId, storageId),
    );
    const row = await s.t.run((ctx) => ctx.db.get(recordingId));
    expect(row).toMatchObject({
      status: "ready",
      storageId,
      mimeType: "video/mp4",
      // The stored size, not the client's claim.
      sizeBytes: "back row".length,
      durationMs: 42_000,
      levels: "AAECAw==",
      frameMs: 80,
      roomDbfs: -48.5,
      cameraStartedAtClient: 1_700_000_000_000,
    });
    // A repeated finish for the same upload is harmless; a new URL is not.
    await s.classmate.mutation(
      api.liveTalks.finishUpload,
      uploadArgs(recordingId, storageId),
    );
    await expect(
      s.classmate.mutation(api.liveTalks.generateUploadUrl, { recordingId }),
    ).rejects.toMatchObject({ data: { kind: "closed" } });
  });

  test("refuses a blob that predates the take or belongs to another take", async () => {
    const s = await setup();
    const oldBlob = await storeVideo(s);
    vi.advanceTimersByTime(5_000);
    const { talkId, recordingId } = await recordOneTake(s, "take-1");
    await expect(
      s.classmate.mutation(api.liveTalks.finishUpload, uploadArgs(recordingId, oldBlob)),
    ).rejects.toMatchObject({ data: { kind: "invalid" } });

    vi.advanceTimersByTime(1_000);
    const blob = await storeVideo(s);
    await s.classmate.mutation(api.liveTalks.finishUpload, uploadArgs(recordingId, blob));

    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-2",
    });
    await s.presenter.mutation(api.liveTalks.stopRecording, { talkId });
    const second = (await recordingsFor(s, talkId)).find((r) => r.takeId === "take-2")!;
    await expect(
      s.classmate.mutation(api.liveTalks.finishUpload, uploadArgs(second._id, blob)),
    ).rejects.toMatchObject({ data: { kind: "invalid" } });
  });

  test("refuses an oversized loudness trace", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);
    await expect(
      s.classmate.mutation(api.liveTalks.finishUpload, {
        ...uploadArgs(recordingId, storageId),
        levels: "x".repeat(200_001),
      }),
    ).rejects.toMatchObject({ data: { kind: "invalid" } });
  });

  test("keeps the back meter's green threshold for the presenter's review, when sent", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);
    await s.classmate.mutation(api.liveTalks.finishUpload, {
      ...uploadArgs(recordingId, storageId),
      thresholdDb: 12,
    });
    expect(
      await s.presenter.query(api.liveTalks.backRowForTake, { takeId: "take-1" }),
    ).toMatchObject({ status: "ready", thresholdDb: 12 });
  });

  test("reads no threshold from a back device that didn't send one, and refuses one out of range", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);
    await expect(
      s.classmate.mutation(api.liveTalks.finishUpload, {
        ...uploadArgs(recordingId, storageId),
        thresholdDb: 61,
      }),
    ).rejects.toMatchObject({ data: { kind: "invalid" } });
    await s.classmate.mutation(api.liveTalks.finishUpload, uploadArgs(recordingId, storageId));
    expect(
      await s.presenter.query(api.liveTalks.backRowForTake, { takeId: "take-1" }),
    ).toMatchObject({ status: "ready", thresholdDb: null });
  });

  test("keeps the head-direction trace for the presenter's review, when sent", async () => {
    const s = await setup();
    const { talkId, recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);
    await s.classmate.mutation(api.liveTalks.finishUpload, {
      ...uploadArgs(recordingId, storageId),
      facing: "12,-5,55;;-3,2,54",
      facingFrameMs: 250,
      facingZone: { centerYaw: -25, centerPitch: 5, turnDeg: 40, tiltDeg: 20 },
    });
    expect(
      await s.presenter.query(api.liveTalks.backRowForTake, { takeId: "take-1" }),
    ).toMatchObject({
      status: "ready",
      facing: "12,-5,55;;-3,2,54",
      facingFrameMs: 250,
      // The zone the back BunnyPad's meter used, so the review judges the trace the same way.
      facingZone: { centerYaw: -25, centerPitch: 5, turnDeg: 40, tiltDeg: 20 },
    });

    // A back device whose build can't read head direction sends none.
    await s.presenter.mutation(api.liveTalks.startRecording, { talkId, takeId: "take-2" });
    await s.presenter.mutation(api.liveTalks.stopRecording, { talkId });
    const second = (await recordingsFor(s, talkId)).find((r) => r.takeId === "take-2")!;
    vi.advanceTimersByTime(1_000);
    await s.classmate.mutation(
      api.liveTalks.finishUpload,
      uploadArgs(second._id, await storeVideo(s)),
    );
    expect(
      await s.presenter.query(api.liveTalks.backRowForTake, { takeId: "take-2" }),
    ).toMatchObject({ status: "ready", facing: null, facingFrameMs: null, facingZone: null });
  });

  test("refuses an oversized head-direction trace, a bad frame length or a zone out of range", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);
    for (const bad of [
      { facing: "x".repeat(200_001), facingFrameMs: 250 },
      { facing: "1,2,3", facingFrameMs: 0 },
      { facing: "1,2,3", facingFrameMs: Number.NaN },
      { facing: "1,2,3", facingFrameMs: 250, facingZone: { centerYaw: 0, centerPitch: 0, turnDeg: 0, tiltDeg: 15 } },
      { facing: "1,2,3", facingFrameMs: 250, facingZone: { centerYaw: 120, centerPitch: 0, turnDeg: 30, tiltDeg: 15 } },
      {
        facing: "1,2,3",
        facingFrameMs: 250,
        facingZone: { centerYaw: 0, centerPitch: Number.NaN, turnDeg: 30, tiltDeg: 15 },
      },
    ]) {
      await expect(
        s.classmate.mutation(api.liveTalks.finishUpload, {
          ...uploadArgs(recordingId, storageId),
          ...bad,
        }),
      ).rejects.toMatchObject({ data: { kind: "invalid" } });
    }
  });

  test("markUploadFailed fails an open row but never a ready one", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    await s.classmate.mutation(api.liveTalks.markUploadFailed, { recordingId });
    expect((await s.t.run((ctx) => ctx.db.get(recordingId)))?.status).toBe(
      "failed",
    );
    const storageId = await storeVideo(s);
    await expect(
      s.classmate.mutation(api.liveTalks.finishUpload, uploadArgs(recordingId, storageId)),
    ).rejects.toMatchObject({ data: { kind: "closed" } });
  });
});

describe("backRowForTake", () => {
  test("the presenter and their teacher see it; others do not", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const presenterId = s.moli.scholars[0].id;

    const uploading = await s.presenter.query(api.liveTalks.backRowForTake, {
      takeId: "take-1",
    });
    expect(uploading).toMatchObject({ status: "uploading", url: null, startedAt: T0 });

    const storageId = await storeVideo(s);
    await s.classmate.mutation(
      api.liveTalks.finishUpload,
      uploadArgs(recordingId, storageId),
    );

    const mine = await s.presenter.query(api.liveTalks.backRowForTake, {
      takeId: "take-1",
    });
    expect(mine).toMatchObject({
      status: "ready",
      levels: "AAECAw==",
      frameMs: 80,
      roomDbfs: -48.5,
      durationMs: 42_000,
      cameraStartedAtClient: 1_700_000_000_000,
      startedAt: T0,
    });
    expect(typeof mine?.url).toBe("string");

    expect(
      await s.teacher.query(api.liveTalks.backRowForTake, {
        takeId: "take-1",
        presenterId,
      }),
    ).toMatchObject({ status: "ready" });

    for (const outsider of [
      s.otherClassmate,
      s.classmate, // the listener who recorded it
      s.opsStaff, // account admin is not a licence to browse a scholar's work
      s.parent,
      s.otherSchoolTeacher,
    ]) {
      expect(
        await outsider.query(api.liveTalks.backRowForTake, {
          takeId: "take-1",
          presenterId,
        }),
      ).toBeNull();
    }
    // Without presenterId the caller reads their own takes, of which they have none.
    expect(
      await s.teacher.query(api.liveTalks.backRowForTake, { takeId: "take-1" }),
    ).toBeNull();
  });
});

describe("expiry", () => {
  test("ends a talk gone quiet but not one that kept heart-beating", async () => {
    const s = await setup();
    const quiet = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    const lively = await s.otherClassmate.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId: quiet });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId: quiet,
      takeId: "take-1",
    });

    vi.advanceTimersByTime(40_000);
    expect(
      await s.otherClassmate.mutation(api.liveTalks.heartbeat, { talkId: lively }),
    ).toEqual({ state: "waiting", endedReason: null });

    vi.advanceTimersByTime(TALK_STALE_MS - 40_000 + 1_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await talk(s, quiet))?.state).toBe("ended");
    // The take in progress moves on to uploading, like a stop.
    expect((await recordingsFor(s, quiet))[0]?.status).toBe("uploading");
    expect((await talk(s, lively))?.state).toBe("waiting");
    expect(
      await s.presenter.mutation(api.liveTalks.heartbeat, { talkId: quiet }),
    ).toEqual({ state: "ended", endedReason: "stale" });

    // With no further heartbeats the lively talk's own check ends it.
    vi.advanceTimersByTime(40_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await talk(s, lively))?.state).toBe("ended");
  });
});

describe("listener liveness", () => {
  test("a back device gone quiet is unlinked; one heart-beating is not", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });

    // T0+40s: both devices heart-beat.
    vi.advanceTimersByTime(40_000);
    await s.presenter.mutation(api.liveTalks.heartbeat, { talkId });
    expect(
      await s.classmate.mutation(api.liveTalks.listenerHeartbeat, { talkId }),
    ).toEqual({ connected: true });

    // T0+61s: join's check sees a fresh heartbeat and keeps the link.
    vi.advanceTimersByTime(LISTENER_STALE_MS - 40_000 + 1_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await talk(s, talkId))?.listenerId).toBe(s.moli.scholars[1].id);

    // T0+80s: only the presenter keeps heart-beating.
    vi.advanceTimersByTime(19_000);
    await s.presenter.mutation(api.liveTalks.heartbeat, { talkId });

    // T0+101s: the listener's last check finds it a minute quiet.
    vi.advanceTimersByTime(21_000);
    await s.t.finishInProgressScheduledFunctions();
    expect(await talk(s, talkId)).toMatchObject({ state: "recording" });
    expect((await talk(s, talkId))?.listenerId).toBeUndefined();
    expect((await talk(s, talkId))?.listenerSeenAt).toBeUndefined();
    expect((await recordingsFor(s, talkId)).map((r) => r.status)).toEqual([
      "failed",
    ]);
    expect(
      await s.presenter.query(api.liveTalks.forPresenter, { talkId }),
    ).toMatchObject({ listener: null });

    // The dropped device learns it, and someone else can take the slot.
    expect(
      await s.classmate.mutation(api.liveTalks.listenerHeartbeat, { talkId }),
    ).toEqual({ connected: false });
    await s.teacher.mutation(api.liveTalks.join, { talkId });
    expect((await talk(s, talkId))?.listenerId).toBe(s.moli.teacher.id);
  });

  test("only the current listener's heartbeat counts", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    for (const other of [s.presenter, s.teacher, s.otherSchoolScholar]) {
      expect(
        await other.mutation(api.liveTalks.listenerHeartbeat, { talkId }),
      ).toEqual({ connected: false });
    }
    expect((await talk(s, talkId))?.listenerSeenAt).toBe(T0);
  });
});

describe("upload deadline", () => {
  test("a stopped take with no video fails after the deadline", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);

    vi.advanceTimersByTime(UPLOAD_EXPIRY_MS - 60_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await s.t.run((ctx) => ctx.db.get(recordingId)))?.status).toBe(
      "uploading",
    );

    vi.advanceTimersByTime(61_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await s.t.run((ctx) => ctx.db.get(recordingId)))?.status).toBe(
      "failed",
    );
    const storageId = await storeVideo(s);
    await expect(
      s.classmate.mutation(api.liveTalks.finishUpload, uploadArgs(recordingId, storageId)),
    ).rejects.toMatchObject({ data: { kind: "closed" } });
  });

  test("a video that arrived in time stays ready", async () => {
    const s = await setup();
    const { recordingId } = await recordOneTake(s);
    const storageId = await storeVideo(s);
    await s.classmate.mutation(
      api.liveTalks.finishUpload,
      uploadArgs(recordingId, storageId),
    );
    vi.advanceTimersByTime(UPLOAD_EXPIRY_MS + 1_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await s.t.run((ctx) => ctx.db.get(recordingId)))?.status).toBe(
      "ready",
    );
  });

  test("a take stopped by the talk going stale gets the same deadline", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    // Keep the listener linked while the presenter goes quiet.
    vi.advanceTimersByTime(40_000);
    await s.classmate.mutation(api.liveTalks.listenerHeartbeat, { talkId });
    vi.advanceTimersByTime(TALK_STALE_MS - 40_000 + 1_000);
    await s.t.finishInProgressScheduledFunctions();
    expect(await talk(s, talkId)).toMatchObject({
      state: "ended",
      endedReason: "stale",
    });
    expect((await recordingsFor(s, talkId))[0]?.status).toBe("uploading");

    vi.advanceTimersByTime(UPLOAD_EXPIRY_MS + 1_000);
    await s.t.finishInProgressScheduledFunctions();
    expect((await recordingsFor(s, talkId))[0]?.status).toBe("failed");
  });
});

describe("presenter talking", () => {
  test("travels to the back device only while recording", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    const view = () => s.classmate.query(api.liveTalks.forListener, { talkId });

    // Before a take it is ignored, without an error or a write.
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });
    expect((await talk(s, talkId))?.presenterTalking).toBeUndefined();
    expect((await view())?.presenterTalking).toBe(false);

    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });
    expect((await view())?.presenterTalking).toBe(true);
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: false });
    expect((await view())?.presenterTalking).toBe(false);
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });

    // Stopping the take clears it.
    await s.presenter.mutation(api.liveTalks.stopRecording, { talkId });
    expect((await talk(s, talkId))?.presenterTalking).toBeUndefined();
    expect((await view())?.presenterTalking).toBe(false);

    // Ending mid-take clears it too.
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-2",
    });
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });
    await s.presenter.mutation(api.liveTalks.end, { talkId });
    expect((await view())?.presenterTalking).toBe(false);
  });

  test("only the presenter may set it", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.classmate.mutation(api.liveTalks.join, { talkId });
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    await expect(
      s.classmate.mutation(api.liveTalks.setTalking, { talkId, talking: true }),
    ).rejects.toMatchObject({ data: { kind: "not_found" } });

    // Repeating a value is harmless.
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });
    expect((await talk(s, talkId))?.presenterTalking).toBe(true);
  });

  test("a talk going stale mid-take clears it", async () => {
    const s = await setup();
    const talkId = await s.presenter.mutation(api.liveTalks.begin, SLIDES);
    await s.presenter.mutation(api.liveTalks.startRecording, {
      talkId,
      takeId: "take-1",
    });
    await s.presenter.mutation(api.liveTalks.setTalking, { talkId, talking: true });
    vi.advanceTimersByTime(TALK_STALE_MS + 1_000);
    await s.t.finishInProgressScheduledFunctions();
    expect(await talk(s, talkId)).toMatchObject({ state: "ended", endedReason: "stale" });
    expect((await talk(s, talkId))?.presenterTalking).toBeUndefined();
  });
});
