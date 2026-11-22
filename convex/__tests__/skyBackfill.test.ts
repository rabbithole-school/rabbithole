/**
 * The Sky backfill (TRA-699, PR 8b): the dry run writes nothing and reports
 * what the run would do, the per-kid cap included; the run refreshes every
 * scholar in scope (a part-done sky resumes), writes only `skyStars` and
 * `skyStarEmbeddings`, pages through scholars, stops inside its time budget
 * without losing its place, and is idempotent; scholars who couldn't open a
 * sky are skipped and counted; the read-back counts stars per school and
 * shows one kid's sky. Fictional names and titles only, with a fake embedder.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { makeWorld, type WorldScholar } from "./factories/world";
import { EMBED_TIMEOUT_MESSAGE } from "../lib/embeddings";
import { SKY_STAR_MAX } from "../lib/skySources";

const embedder = vi.hoisted(() => {
  /** Minutes of fake clock each request takes, and an error to throw. */
  const state = { minutesPerCall: 0, failWith: null as string | null };
  return {
    state,
    embed(texts: string[]): number[][] {
      if (state.failWith) throw new Error(state.failWith);
      if (state.minutesPerCall) vi.setSystemTime(Date.now() + state.minutesPerCall * 60_000);
      return texts.map((text) => {
        const v = new Array<number>(512).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? ["blank"]) {
          let h = 2166136261;
          for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
          for (let i = 0; i < 512; i++) {
            h = Math.imul(h ^ (h >>> 13), 1274126177);
            v[i] += ((h >>> 0) / 4294967296) * 2 - 1;
          }
        }
        return v;
      });
    },
  };
});
vi.mock("../lib/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/embeddings")>()),
  embedTexts: async (texts: string[]) => embedder.embed(texts),
  requireEmbeddingKey: () => "test-key",
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  embedder.state.minutesPerCall = 0;
  embedder.state.failWith = null;
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;
type Kid = Pick<WorldScholar, "id" | "institutionId">;

async function chat(
  t: T,
  kid: Kid,
  fields: Partial<Doc<"sessions">>,
  kidTurns: string[],
): Promise<Id<"sessions">> {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: kid.id,
      title: "A chat",
      isArchived: false,
      institutionId: kid.institutionId,
      ...fields,
    });
    for (const content of kidTurns) {
      await ctx.db.insert("messages", { sessionId, role: "user", content, flagged: false });
    }
    return sessionId;
  });
}

async function seed(t: T, kid: Kid, topic: string, origin: "wonder" | "ai") {
  return await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId: kid.id,
      origin,
      status: "active",
      suggestionType: "frontier",
      topic,
      rationale: "",
    }),
  );
}

async function quest(
  t: T,
  kid: Kid,
  title: string,
  opts: { approval?: Doc<"units">["questApproval"]; chat?: Partial<Doc<"sessions">> } = {},
) {
  const unitId = await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId: kid.id,
      institutionId: kid.institutionId,
      title,
      isActive: true,
      authorScholarId: kid.id,
      ...(opts.approval ? { questApproval: opts.approval } : {}),
    }),
  );
  await chat(t, kid, { unitId, ...opts.chat }, [`I am making ${title}`]);
  return unitId;
}

/** A scholar account outside the world's schools. */
async function looseScholar(t: T, name: string, fields: Partial<Doc<"users">>): Promise<Kid> {
  const id = await t.run((ctx) =>
    ctx.db.insert("users", { name, username: name.toLowerCase().replace(/\s+/g, "-"), role: "scholar", ...fields }),
  );
  return { id, institutionId: fields.institutionId as Id<"institutions"> };
}

/**
 * Kid A has every kind of source and label; kid B's sky has one placed star
 * (never embedded) and one source not yet added; kid C is at the second
 * school; guest H is a program guest; kid D has nothing that earns a star.
 * Out of scope, each with a Quest: E (no school), F (school suspended), G
 * (school deleted).
 */
async function fixture() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 2, scholarsPerSchool: 3, parentsPerSchool: 0 });
  const [home, away] = world.schools;
  const [a, b, d] = home.scholars;
  const c = away.scholars[0];

  const wonderSeed = await seed(t, a, "How do bats find bugs in the dark?", "wonder");
  const wonderChat = await chat(t, a, { seedId: wonderSeed }, ["How do bats find bugs in the dark?"]);
  const oldSeed = await seed(t, a, "Volcano lava", "ai");
  await chat(t, a, { seedId: oldSeed }, ["is lava hotter than fire"]);
  const quietSeed = await seed(t, a, "Tides", "ai");
  await chat(t, a, { seedId: quietSeed }, []);
  await quest(t, a, "MY VOLCANO GAME");
  await quest(t, a, "  Robot   dog ");
  await quest(t, a, "asdfghjkl");
  await quest(t, a, "1 + 1 = ?");
  await quest(t, a, "Echo game", {
    approval: {
      state: "approved",
      kind: "app",
      revision: 1,
      advisorId: home.teacher.id,
      fromSessionId: wonderChat,
      shownAt: 1_700_000_000_000,
    },
  });
  await quest(t, a, "Waiting one", {
    approval: { state: "waiting", kind: "app", revision: 1, scholarWords: "a plan", proposedAt: 1 },
  });
  await quest(t, a, "Rehearsal", { chat: { isTestDrive: true } });

  const bSeed = await seed(t, b, "Why do owls hoot?", "wonder");
  await chat(t, b, { seedId: bSeed }, ["Why do owls hoot?"]);
  await t.run((ctx) =>
    ctx.db.insert("skyStars", { scholarId: b.id, seedId: bSeed, label: "Why do owls hoot?", x: 0, y: 0 }),
  );
  await quest(t, b, "Owl maze");

  await quest(t, c, "Robot arm");

  const h = await looseScholar(t, "Guest Kalani", {
    institutionId: home.id,
    enrollmentStanding: "program_guest",
  });
  await quest(t, h, "Kite designer");

  const e = await looseScholar(t, "Unenrolled Kekoa", {});
  await quest(t, e, "Lost quest");
  const paused = await t.run((ctx) =>
    ctx.db.insert("institutions", { name: "Paused School", slug: "paused", kind: "school", disabledAt: 1 }),
  );
  const f = await looseScholar(t, "Paused Leilani", { institutionId: paused });
  await quest(t, f, "Paused quest");
  const gone = await t.run((ctx) =>
    ctx.db.insert("institutions", { name: "Gone School", slug: "gone", kind: "school" }),
  );
  const g = await looseScholar(t, "Orphan Makoa", { institutionId: gone });
  await quest(t, g, "Orphan quest");
  await t.run((ctx) => ctx.db.delete(gone));

  return { t, world, home, away, a, b, c, d, e, f, g, h };
}

/** Every table but the ones named, plus the scheduler's queue. */
async function snapshot(t: T, except: string[] = []) {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables).sort()) {
      if (except.includes(table)) continue;
      out[table] = await ctx.db.query(table as "users").collect();
    }
    out._scheduled_functions = await ctx.db.system.query("_scheduled_functions").collect();
    return JSON.stringify(out);
  });
}

type RunPage = Awaited<ReturnType<typeof runOne>>;

function runOne(t: T, args: { cursor?: string | null; startAt?: number; pageSize?: number }) {
  return t.action(internal.skyBackfill.run, args);
}

/** Every page of the run, following `nextArgs`, added up. */
async function runAll(t: T, pageSize: number) {
  const totals = {
    calls: 0,
    scholarsRead: 0,
    kidsProcessed: 0,
    kidsAlreadyComplete: 0,
    skipped: { noSchool: 0, schoolMissing: 0, schoolSuspended: 0 },
    added: 0,
    embedded: 0,
    placed: 0,
    firstLayouts: 0,
    errors: [] as RunPage["errors"],
  };
  let args: RunPage["nextArgs"] | { pageSize: number } = { pageSize };
  for (;;) {
    const page: RunPage = await runOne(t, args!);
    totals.calls++;
    totals.scholarsRead += page.scholarsRead;
    totals.kidsProcessed += page.kidsProcessed;
    totals.kidsAlreadyComplete += page.kidsAlreadyComplete;
    for (const key of ["noSchool", "schoolMissing", "schoolSuspended"] as const) {
      totals.skipped[key] += page.skipped[key];
    }
    totals.added += page.added;
    totals.embedded += page.embedded;
    totals.placed += page.placed;
    totals.firstLayouts += page.firstLayouts;
    totals.errors.push(...page.errors);
    if (page.isDone) return totals;
    args = page.nextArgs;
  }
}

async function positions(t: T) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("skyStars").collect()).map((row) => [row._id, row.x ?? null, row.y ?? null]),
  );
}

describe("the dry run", () => {
  test("writes nothing and reports what the run would do, in scope only", async () => {
    const { t, home, away } = await fixture();
    const before = await snapshot(t);

    const report = await t.action(internal.skyBackfill.dryRun, {});

    expect(await snapshot(t)).toBe(before);
    expect(report.totals).toEqual({
      scholars: 4, // A, B, C and guest H; D has nothing that earns a star
      sources: { wonder: 2, legacySeed: 1, quest: 8 },
      kidsComplete: 0,
      kidsNeedingWork: 4,
      starsToAdd: 10, // A 7, B 1, C 1, H 1
      starsCapped: 0,
      starsToEmbed: 10, // A 6 (not the mash), B 2 (its placed star has no vector), C 1, H 1
      starsToPlace: 9, // A 6, B 1, C 1, H 1
      brightQuests: 1,
      labelsChanged: 2,
      labelsHidden: 1,
    });
    expect(report.skipped).toEqual({ noSchool: 1, schoolMissing: 1, schoolSuspended: 1 });
    expect(report.labelChanges).toEqual(
      expect.arrayContaining([
        { before: "MY VOLCANO GAME", after: "My volcano game", hidden: false },
        { before: "  Robot   dog ", after: "Robot dog", hidden: false },
        { before: "asdfghjkl", after: "asdfghjkl", hidden: true },
      ]),
    );
    expect(report.labelChanges).toHaveLength(3);

    const bySchool = new Map(report.perInstitution.map((s) => [s.institutionId, s]));
    expect(bySchool.get(home.id)).toMatchObject({ scholars: 3, starsToAdd: 9, kidsNeedingWork: 3 });
    expect(bySchool.get(away.id)).toMatchObject({ scholars: 1, starsToAdd: 1 });
  });

  test("one scholar per page adds up to the same report", async () => {
    const { t } = await fixture();
    const whole = await t.action(internal.skyBackfill.dryRun, { pageSize: 50 });
    const paged = await t.action(internal.skyBackfill.dryRun, { pageSize: 1 });
    expect(paged.pages).toBeGreaterThan(whole.pages);
    expect(paged.scholarsRead).toBe(whole.scholarsRead);
    expect(paged.totals).toEqual(whole.totals);
    expect(paged.skipped).toEqual(whole.skipped);
    expect(paged.labelChanges).toEqual(expect.arrayContaining(whole.labelChanges));
  });

  test("each scholar is read by a query of their own", async () => {
    const { t, a } = await fixture();
    const kid = await t.query(internal.skyBackfill.dryRunScholar, { scholarId: a.id });
    expect(kid?.totals).toMatchObject({ scholars: 1, starsToAdd: 7, starsToPlace: 6 });
  });

  test("a kid with no qualifying source but an unfinished star is reported as the run will treat it", async () => {
    const { t, d } = await fixture();
    const dKid = { id: d.id, institutionId: d.institutionId };
    // A Quest put away since its star was added: it no longer earns a star,
    // but its source is still theirs, so the run embeds and places the row.
    const archived = await quest(t, dKid, "Snail race");
    await t.run((ctx) => ctx.db.patch(archived, { isActive: false }));
    await t.run((ctx) => ctx.db.insert("skyStars", { scholarId: d.id, unitId: archived, label: "Snail race" }));
    // A star whose source is gone: the run never writes to it.
    const gone = await quest(t, dKid, "Frog life");
    await t.run((ctx) => ctx.db.insert("skyStars", { scholarId: d.id, unitId: gone, label: "Frog life" }));
    await t.run((ctx) => ctx.db.delete(gone));

    const kid = await t.query(internal.skyBackfill.dryRunScholar, { scholarId: d.id });
    expect(kid?.totals).toMatchObject({
      scholars: 1,
      sources: { wonder: 0, legacySeed: 0, quest: 0 },
      kidsNeedingWork: 1,
      starsToAdd: 0,
      starsToEmbed: 1,
      starsToPlace: 1,
    });

    const result = await t.action(internal.skyStars.refreshForScholar, { scholarId: d.id });
    expect(result).toMatchObject({ added: 0, embedded: 1, placed: 1 });
  });

  test("addStars applies the cap after rechecking sources: a gone source leaves its slot to a valid one", async () => {
    const { t, d } = await fixture();
    const dKid = { id: d.id, institutionId: d.institutionId };
    const filler = await seed(t, dKid, "filler", "ai");
    await t.run(async (ctx) => {
      for (let i = 0; i < SKY_STAR_MAX - 1; i++) {
        await ctx.db.insert("skyStars", { scholarId: d.id, seedId: filler, label: "asdfghjkl", hidden: true });
      }
    });
    const goneSeed = await seed(t, dKid, "Gone wonder", "ai");
    await t.run((ctx) => ctx.db.delete(goneSeed));
    const valid = await quest(t, dKid, "Bee dance");

    const added = await t.mutation(internal.skyStars.addStars, {
      scholarId: d.id,
      sources: [
        { seedId: goneSeed, text: "Gone wonder" },
        { unitId: valid, text: "Bee dance" },
      ],
    });
    expect(added).toBe(1);
    const rows = await t.run((ctx) =>
      ctx.db.query("skyStars").withIndex("by_scholar_unit", (q) => q.eq("scholarId", d.id).eq("unitId", valid)).collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("the per-kid cap: a full sky adds nothing, and the dry run says so", async () => {
    const { t, d } = await fixture();
    const dKid = { id: d.id, institutionId: d.institutionId };
    const filler = await seed(t, dKid, "filler", "ai");
    await t.run(async (ctx) => {
      for (let i = 0; i < SKY_STAR_MAX; i++) {
        await ctx.db.insert("skyStars", { scholarId: d.id, seedId: filler, label: "asdfghjkl", hidden: true });
      }
    });
    for (const title of ["Comet catcher", "Frog life", "Snail race", "Bee dance"]) {
      await quest(t, dKid, title);
    }

    const kid = await t.query(internal.skyBackfill.dryRunScholar, { scholarId: d.id });
    expect(kid?.totals).toMatchObject({ starsToAdd: 0, starsCapped: 4, kidsComplete: 1 });

    await runAll(t, 50);
    const rows = await t.run((ctx) =>
      ctx.db.query("skyStars").withIndex("by_scholar_seed", (q) => q.eq("scholarId", d.id)).collect(),
    );
    expect(rows).toHaveLength(SKY_STAR_MAX);
  });
});

describe("the run", () => {
  test("pages through scholars in scope and writes only the two Sky tables", async () => {
    const { t, e, f, g } = await fixture();
    const before = await snapshot(t, ["skyStars", "skyStarEmbeddings"]);

    const first = await runAll(t, 2);

    expect(await snapshot(t, ["skyStars", "skyStarEmbeddings"])).toBe(before);
    expect(first.calls).toBeGreaterThan(1);
    expect(first).toMatchObject({
      added: 10,
      embedded: 10,
      placed: 9,
      firstLayouts: 3, // A, C and H; B's sky already had a placed star
      skipped: { noSchool: 1, schoolMissing: 1, schoolSuspended: 1 },
      errors: [],
    });
    const outOfScope = await t.run(async (ctx) =>
      (await ctx.db.query("skyStars").collect()).filter((row) =>
        [e.id, f.id, g.id].includes(row.scholarId),
      ),
    );
    expect(outOfScope).toEqual([]);
  });

  test("a second run adds nothing and moves nothing", async () => {
    const { t } = await fixture();
    await runAll(t, 3);
    const before = await positions(t);

    const again = await runAll(t, 3);

    expect(again).toMatchObject({ added: 0, embedded: 0, placed: 0, firstLayouts: 0, errors: [] });
    expect(again.kidsAlreadyComplete).toBe(again.kidsProcessed);
    expect(await positions(t)).toEqual(before);
  });

  test("a part-done sky resumes: missing stars are added, embedded and placed", async () => {
    const { t, a } = await fixture();
    await runAll(t, 50);
    const placedBefore = await positions(t);
    // A star whose refresh died before its vector and position, and a new
    // source with no row at all.
    const late = await quest(t, a, "Glacier slide");
    await t.run((ctx) =>
      ctx.db.insert("skyStars", { scholarId: a.id, unitId: late, label: "Glacier slide" }),
    );
    await quest(t, a, "Crystal garden");

    const kid = await t.query(internal.skyBackfill.dryRunScholar, { scholarId: a.id });
    expect(kid?.totals).toMatchObject({ kidsNeedingWork: 1, starsToAdd: 1, starsToEmbed: 2, starsToPlace: 2 });

    const resumed = await runAll(t, 50);
    expect(resumed).toMatchObject({ added: 1, embedded: 2, placed: 2, firstLayouts: 0, errors: [] });
    const after = new Map((await positions(t)).map(([id, x, y]) => [id, [x, y]]));
    for (const [id, x, y] of placedBefore) expect(after.get(id)).toEqual([x, y]);
  });

  /** Five kids with a Quest each and a provider that takes two minutes a
   *  request: the first call does three kids and stops. */
  async function stoppedRun() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 16, 15, 0, 0));
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, scholarsPerSchool: 5, parentsPerSchool: 0 });
    const kids = world.schools[0].scholars;
    for (const [i, kid] of kids.entries()) await quest(t, kid, `Kite ${i}`);
    embedder.state.minutesPerCall = 2;
    const first = await runOne(t, { pageSize: 10 });
    const starsOf = (kid: WorldScholar) =>
      t.run((ctx) =>
        ctx.db.query("skyStars").withIndex("by_scholar_seed", (q) => q.eq("scholarId", kid.id)).collect(),
      );
    return { t, world, kids, first, starsOf };
  }

  test("stops inside its time budget and resumes after the last kid it handled", async () => {
    const { t, kids, first } = await stoppedRun();
    // Kids start at 0, 2 and 4 minutes; the fourth would start at 6.
    expect(first).toMatchObject({ isDone: false, kidsProcessed: 3, added: 3 });
    const third = await t.run((ctx) => ctx.db.get(kids[2].id));
    expect(first.nextArgs).toEqual({
      cursor: null,
      startAfter: { creationTime: third!._creationTime, scholarId: kids[2].id },
      pageSize: 10,
    });

    const second = await runOne(t, first.nextArgs!);
    expect(second).toMatchObject({ isDone: true, kidsProcessed: 2, added: 2, nextArgs: null });
  });

  test("an account leaving the list before the resume point skips nobody", async () => {
    const { t, kids, first, starsOf } = await stoppedRun();
    await t.run((ctx) => ctx.db.patch(kids[1].id, { role: "parent" }));

    const second = await runOne(t, first.nextArgs!);
    expect(second).toMatchObject({ isDone: true, kidsProcessed: 2, added: 2 });
    expect(await starsOf(kids[3])).toHaveLength(1);
    expect(await starsOf(kids[4])).toHaveLength(1);
  });

  test("an account joining the list before the resume point repeats nobody", async () => {
    const { t, world, kids, first, starsOf } = await stoppedRun();
    // The school's teacher, created before the kids, becomes a scholar.
    const teacher = world.schools[0].teacher;
    const [teacherDoc, firstKid] = await t.run(async (ctx) => [
      await ctx.db.get(teacher.id),
      await ctx.db.get(kids[0].id),
    ]);
    expect(teacherDoc!._creationTime).toBeLessThan(firstKid!._creationTime);
    await t.run((ctx) => ctx.db.patch(teacher.id, { role: "scholar" }));

    const second = await runOne(t, first.nextArgs!);
    expect(second).toMatchObject({ isDone: true, scholarsRead: 2, kidsProcessed: 2, added: 2 });
    expect(await starsOf(kids[3])).toHaveLength(1);
    expect(await starsOf(kids[4])).toHaveLength(1);
  });

  test("a kid whose refresh fails is reported by id with a fixed reason, and the run goes on", async () => {
    const { t, a } = await fixture();
    embedder.state.failWith = EMBED_TIMEOUT_MESSAGE;
    const result = await runAll(t, 50);
    expect(result.errors).toContainEqual({ scholarId: a.id, error: EMBED_TIMEOUT_MESSAGE });
    expect(result.errors.every((e) => e.error === EMBED_TIMEOUT_MESSAGE)).toBe(true);
  });
});

describe("the read-back", () => {
  test("counts stars per school and shows one kid's sky as forSelf does", async () => {
    const { t, world, home, away, a } = await fixture();
    await runAll(t, 5);

    const back = await t.query(internal.skyBackfill.readBack, { pageSize: 50, scholarId: a.id });
    const bySchool = new Map(back.perInstitution.map((s) => [s.institutionId, s]));
    expect(bySchool.get(home.id)).toEqual({
      institutionId: home.id,
      scholars: 3, // A, B and H
      total: 10, // A 7 (one hidden), B 2, H 1
      placed: 9,
      unplaced: 0,
      hidden: 1,
      bright: 1,
      withoutEmbedding: 0,
    });
    expect(bySchool.get(away.id)).toMatchObject({ scholars: 1, total: 1, placed: 1 });

    const asA = await world.as.scholar(a);
    expect(back.sky).toEqual(await asA.query(api.skyStars.forSelf, {}));
    expect(back.sky!.map((star) => star.label).sort()).toEqual([
      "1 + 1 = ?",
      "Echo game",
      "How do bats find bugs in the dark?",
      "My volcano game",
      "Robot dog",
      "Volcano lava",
    ]);
    expect(back.outOfScope).toEqual({
      noSchool: { scholars: 0, stars: 0 },
      schoolMissing: { scholars: 0, stars: 0 },
      schoolSuspended: { scholars: 0, stars: 0 },
    });
  });

  test("stars of a kid the run puts out of scope are counted apart, by reason", async () => {
    const { t, home, f } = await fixture();
    await runAll(t, 50);
    // Kid F's school is suspended: stars from before stay unplaced.
    const unitId = await t.run(async (ctx) =>
      (await ctx.db.query("units").withIndex("by_authorScholar", (q) => q.eq("authorScholarId", f.id)).first())!._id,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("skyStars", { scholarId: f.id, unitId, label: "Paused quest" });
      await ctx.db.insert("skyStars", { scholarId: f.id, unitId, label: "Paused quest", hidden: true });
    });

    const back = await t.query(internal.skyBackfill.readBack, { pageSize: 50 });
    expect(back.outOfScope.schoolSuspended).toEqual({ scholars: 1, stars: 2 });
    for (const school of back.perInstitution) expect(school.unplaced).toBe(0);
    const allRows = await t.run(async (ctx) => (await ctx.db.query("skyStars").collect()).length);
    const inScope = back.perInstitution.reduce((sum, school) => sum + school.total, 0);
    expect(inScope).toBe(allRows - 2);
    expect(back.perInstitution.some((school) => school.institutionId === home.id)).toBe(true);
  });
});
