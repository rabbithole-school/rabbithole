import { convexTest } from "convex-test";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { STANDING_STORY_INVITATION_CAP } from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 11, 12);

function makeHarness() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof makeHarness>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(t: Harness, username = "standing-scholar") {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Standing Scholar",
      username,
      role: "scholar",
    }),
  );
}

async function withUser(t: Harness, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + HOUR_MS,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

type MomentOutcome = Doc<"momentEvents">["outcome"];
type SeedOrigin = Doc<"seeds">["origin"];
type SeedStatus = Doc<"seeds">["status"];

async function seedInvitation(
  t: Harness,
  scholarId: Id<"users">,
  options: {
    key: string;
    offeredAt: number;
    outcome?: MomentOutcome;
    origin?: SeedOrigin;
    status?: SeedStatus;
    teaser?: string;
    visualEmoji?: string;
  },
) {
  const fromKey = `skill_${options.key}`;
  const toKey = `idea_${options.key}`;
  const skillLabel = `Skill ${options.key}`;
  const hook = `Hook ${options.key}`;
  const outcome = options.outcome ?? "offered";

  return await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: fromKey,
      label: skillLabel,
      domain: "fraction-arithmetic",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: toKey,
      label: `Idea ${options.key}`,
      domain: "history",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey,
      toKey,
      domain: "history",
      kind: "bridge",
      method: "curated",
      story: {
        kind: "applies",
        hook,
        narrative: `SECRET_NARRATIVE_${options.key}`,
        ...(options.teaser === undefined ? {} : { teaser: options.teaser }),
        ...(options.visualEmoji === undefined
          ? {}
          : { visualEmoji: options.visualEmoji }),
        probe: `SECRET_PROBE_${options.key}`,
        provenance: "registry",
      },
    });
    const origin = options.origin ?? "story";
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin,
      status: options.status ?? "active",
      topic: `SECRET_TOPIC_${options.key}`,
      domain: `SECRET_DOMAIN_${options.key}`,
      suggestionType:
        origin === "teacher" ? "teacher_suggestion" : "cross_domain",
      rationale: `SECRET_RATIONALE_${options.key}`,
      scholarInvitation: `SECRET_INVITATION_${options.key}`,
      approachHint: `SECRET_APPROACH_${options.key}`,
      connectionTo: skillLabel,
      storyFromKey: fromKey,
      storyToKey: toKey,
    });
    const eventId = await ctx.db.insert("momentEvents", {
      scholarId,
      kind: "story",
      fromKey,
      toKey,
      trigger: "fluency_transition",
      offeredAt: options.offeredAt,
      outcome,
      ...(outcome === "offered"
        ? {}
        : { outcomeAt: options.offeredAt + 1 }),
      clientEventId: `event-${options.key}`,
    });
    return { seedId, eventId, fromKey, toKey, skillLabel, hook };
  });
}

describe("seeds.standingStoryInvitationsForSelf", () => {
  test("returns active story seeds only", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    const active = await seedInvitation(t, scholarId, {
      key: "active",
      offeredAt: NOW,
    });
    await seedInvitation(t, scholarId, {
      key: "pending",
      offeredAt: NOW + 2,
      status: "pending",
    });
    await seedInvitation(t, scholarId, {
      key: "teacher",
      offeredAt: NOW + 1,
      origin: "teacher",
    });
    const asScholar = await withUser(t, scholarId);

    const invitations = await asScholar.query(
      api.seeds.standingStoryInvitationsForSelf,
      {},
    );

    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      seedId: active.seedId,
      eventId: active.eventId,
      hook: active.hook,
    });
  });

  test.each(["offered", "opened", "probed"] as const)(
    "includes the non-terminal %s outcome",
    async (outcome) => {
      const t = makeHarness();
      const scholarId = await seedUser(t);
      const invitation = await seedInvitation(t, scholarId, {
        key: outcome,
        offeredAt: NOW,
        outcome,
      });
      const asScholar = await withUser(t, scholarId);

      await expect(
        asScholar.query(api.seeds.standingStoryInvitationsForSelf, {}),
      ).resolves.toMatchObject([
        { eventId: invitation.eventId, seedId: invitation.seedId },
      ]);
    },
  );

  test.each(["tried", "saved", "dismissed"] as const)(
    "excludes the terminal %s outcome",
    async (outcome) => {
      const t = makeHarness();
      const scholarId = await seedUser(t);
      await seedInvitation(t, scholarId, {
        key: outcome,
        offeredAt: NOW,
        outcome,
      });
      const asScholar = await withUser(t, scholarId);

      await expect(
        asScholar.query(api.seeds.standingStoryInvitationsForSelf, {}),
      ).resolves.toEqual([]);
    },
  );

  test("excludes an invitation once its seed has started a session", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    const invitation = await seedInvitation(t, scholarId, {
      key: "started",
      offeredAt: NOW,
      outcome: "opened",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: scholarId,
        seedId: invitation.seedId,
        title: "Started story",
        isArchived: false,
      });
    });
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.query(api.seeds.standingStoryInvitationsForSelf, {}),
    ).resolves.toEqual([]);
  });

  test("returns the newest two invitations by offeredAt", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    await seedInvitation(t, scholarId, {
      key: "oldest",
      offeredAt: NOW - 2,
    });
    const middle = await seedInvitation(t, scholarId, {
      key: "middle",
      offeredAt: NOW - 1,
    });
    const newest = await seedInvitation(t, scholarId, {
      key: "newest",
      offeredAt: NOW,
    });
    const asScholar = await withUser(t, scholarId);

    const invitations = await asScholar.query(
      api.seeds.standingStoryInvitationsForSelf,
      {},
    );

    expect(invitations).toHaveLength(STANDING_STORY_INVITATION_CAP);
    expect(invitations.map((invitation) => invitation.eventId)).toEqual([
      newest.eventId,
      middle.eventId,
    ]);
  });

  test("joins the latest edge event and de-duplicates duplicate edge seeds", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    const invitation = await seedInvitation(t, scholarId, {
      key: "repeat",
      offeredAt: NOW - 2,
    });
    const { duplicateSeedId, latestEventId } = await t.run(async (ctx) => {
      const seed = await ctx.db.get("seeds", invitation.seedId);
      if (!seed) throw new Error("seed missing");
      const duplicateSeedId = await ctx.db.insert("seeds", {
        scholarId: seed.scholarId,
        origin: seed.origin,
        status: seed.status,
        topic: seed.topic,
        domain: seed.domain,
        suggestionType: seed.suggestionType,
        rationale: seed.rationale,
        scholarInvitation: seed.scholarInvitation,
        approachHint: seed.approachHint,
        connectionTo: seed.connectionTo,
        storyFromKey: seed.storyFromKey,
        storyToKey: seed.storyToKey,
      });
      const latestEventId = await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "story",
        fromKey: invitation.fromKey,
        toKey: invitation.toKey,
        trigger: "fluency_transition",
        offeredAt: NOW,
        outcome: "opened",
        outcomeAt: NOW + 1,
        clientEventId: "event-repeat-latest",
      });
      return { duplicateSeedId, latestEventId };
    });
    const asScholar = await withUser(t, scholarId);

    const invitations = await asScholar.query(
      api.seeds.standingStoryInvitationsForSelf,
      {},
    );

    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      eventId: latestEventId,
      offeredAt: NOW,
    });
    expect([invitation.seedId, duplicateSeedId]).toContain(
      invitations[0]?.seedId,
    );
  });

  test("returns only the contracted graph-derived scholar-safe fields", async () => {
    const t = makeHarness();
    const scholarId = await seedUser(t);
    const invitation = await seedInvitation(t, scholarId, {
      key: "safe",
      offeredAt: NOW,
      teaser: "A scholar-safe clue",
      visualEmoji: "🧭",
    });
    const { artStorageId, artUrl } = await t.run(async (ctx) => {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", invitation.toKey))
        .unique();
      if (!node) throw new Error("far-end story node missing");
      const artStorageId = await ctx.storage.store(
        new Blob(["invitation-art"], { type: "image/png" }),
      );
      await ctx.db.patch(node._id, {
        artStorageId,
        artContentHash: "invitation-art-hash",
        artStatus: "ready",
      });
      const artUrl = await ctx.storage.getUrl(artStorageId);
      if (!artUrl) throw new Error("story art URL missing");
      return { artStorageId, artUrl };
    });
    const asScholar = await withUser(t, scholarId);

    const invitations = await asScholar.query(
      api.seeds.standingStoryInvitationsForSelf,
      {},
    );

    expect(invitations).toEqual([
      {
        seedId: invitation.seedId,
        eventId: invitation.eventId,
        fromKey: invitation.fromKey,
        toKey: invitation.toKey,
        skillLabel: invitation.skillLabel,
        hook: invitation.hook,
        teaser: "A scholar-safe clue",
        visualEmoji: "🧭",
        artUrl,
        kindLabel: "applies to",
        hasApplication: false,
        offeredAt: NOW,
      },
    ]);
    const serialized = JSON.stringify(invitations);
    for (const secret of [
      "SECRET_NARRATIVE",
      "SECRET_PROBE",
      "SECRET_TOPIC",
      "SECRET_DOMAIN",
      "SECRET_RATIONALE",
      "SECRET_INVITATION",
      "SECRET_APPROACH",
      "provenance",
      "outcome",
      "clientEventId",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(invitations[0]).not.toHaveProperty("artStorageId");
    expect(invitations[0]).not.toHaveProperty("artContentHash");
    expect(invitations[0]).not.toHaveProperty("artStatus");
    const { artUrl: _servedUrl, ...redacted } = invitations[0]!;
    expect(JSON.stringify(redacted)).not.toContain(String(artStorageId));
  });

  test("never returns another scholar's invitations", async () => {
    const t = makeHarness();
    const mine = await seedUser(t, "mine");
    const theirs = await seedUser(t, "theirs");
    await seedInvitation(t, theirs, {
      key: "theirs",
      offeredAt: NOW,
    });
    const asMine = await withUser(t, mine);

    await expect(
      asMine.query(api.seeds.standingStoryInvitationsForSelf, {}),
    ).resolves.toEqual([]);
  });
});
