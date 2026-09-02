import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { richSeed } from "../seed/rich";
import { normalizeGranules } from "../lib/granules";
import { deriveHomeTabs } from "../../shared/scholarHomeNow";

// Why this file: the rich-cohort inserter (convex/seedRichCohort.ts) is run
// through the LIVE schema validators here — convexTest validates every inserted
// row against schema.ts, so any field drift (a renamed/removed column, a
// tightened union) fails this test BEFORE it can reach a deployment. On top of
// that drift net we assert the structural + referential invariants the fixture
// must always hold, plus a table-coverage guard so a schema change that
// silently drops a whole table's worth of seed data can't pass unnoticed.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Every table the rich seed (this shard) is contractually required to populate.
// If any ends up empty post-insert, either the fixture lost data or a schema
// change dropped it — both are regressions we want to catch.
const REQUIRED_TABLES = [
  "users",
  "institutions",
  "guardianships",
  "notificationPrefs",
  "scholarGroups",
  "reportingPeriods",
  "scheduleBlocks",
  "schedulePlacements",
  "teacherAffinities",
  "scholarDossiers",
  "teacherDirectives",
  "readingLevelHistory",
  "units",
  "lessons",
  "activities",
  "assignments",
  "sessions",
  "messages",
  "analyses",
  "deliverables",
  "activityCompletions",
  "masteryObservations",
  "granuleEvidence",
  "sessionSignals",
  "crossDomainConnections",
  "seeds",
  "observations",
  "syntheticScholarProfiles",
  "curriculumVariants",
  "curriculumExperiments",
  "simulatedSessions",
  "groundedSessionVerdicts",
  "unitReviews",
  "activityReflections",
  "momentTriage",
  "chats",
  "curriculumMessages",
] as const;

async function seeded() {
  const t = convexTest(schema, modules);
  const result = await t.run(async (ctx) =>
    ctx.runMutation(internal.seedRichCohort.seedAll, {}),
  );
  return { t, result };
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("rich cohort seed — schema drift + invariants", () => {
  test("inserts cleanly through the live schema validators", async () => {
    const { result } = await seeded();
    expect(result.inserted).toBe(true);
    expect(result.captureStationToken).toMatch(/^rhcapture_[0-9a-f]{48}$/);
    // The counts object is non-empty and every value is a positive integer.
    const counts = result.counts;
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    for (const [table, n] of Object.entries(counts)) {
      expect(n, `${table} count`).toBeGreaterThan(0);
    }
  });

  test("is idempotent — a second run inserts nothing", async () => {
    const t = convexTest(schema, modules);
    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.seedRichCohort.seedAll, {}),
    );
    expect(first.inserted).toBe(true);
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.seedRichCohort.seedAll, {}),
    );
    expect(second.inserted).toBe(false);
    expect(second.counts).toEqual({});
    expect(second.captureStationToken).toBeUndefined();
    // The roster wasn't doubled.
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(users.filter((u) => u.role === "teacher").length).toBe(
      richSeed.teachers.length,
    );
  });

  test("table-coverage guard — every required table has ≥1 row", async () => {
    const { t } = await seeded();
    for (const table of REQUIRED_TABLES) {
      const rows = await t.run(async (ctx) =>
        ctx.db.query(table as any).collect(),
      );
      expect(rows.length, `table "${table}" must be seeded`).toBeGreaterThan(0);
    }
  });

  test("seed stars persist scholar-facing invitations", async () => {
    const { t } = await seeded();
    const rows = await t.run(async (ctx) => ctx.db.query("seeds").collect());
    const byTopic = new Map(rows.map((row) => [row.topic, row]));

    for (const seed of richSeed.seeds) {
      const row = byTopic.get(seed.topic);
      expect(row?.rationale, `${seed.key} teacher rationale`).toBe(
        seed.rationale,
      );
      expect(row?.scholarInvitation, `${seed.key} scholar invitation`).toBe(
        seed.scholarInvitation,
      );
    }
  });

  test("baseline pre-assessments carry a scholar-safe blurb that never leaks the mechanic", () => {
    // Fixture-level check (no seeding needed). The two "baseline" activities —
    // Pizza talk (fractions) and Tell me a story (Small Moments) — are stealth
    // pre-assessments. Their TEACHER-facing `description` is allowed to say so;
    // their SCHOLAR-facing `scholarDescription` must exist and must NOT reveal
    // that it is an assessment (scholar reads never fall back to `description`).
    const baselineActivities = richSeed.units
      .flatMap((u) => u.lessons)
      .flatMap((l) => l.activities)
      .filter((a) => a.recipe === "baseline");

    // Both baseline stealth pre-assessments are present in the fixture.
    expect(baselineActivities.map((a) => a.key).sort()).toEqual([
      "a.fractions.baseline",
      "a.smallmoments.baseline",
    ]);

    const banned = ["assessment", "pre-assessment", "stealth"];
    for (const a of baselineActivities) {
      const blurb = a.scholarDescription;
      expect(blurb, `${a.key} scholarDescription is authored`).toBeTruthy();
      expect(
        (blurb ?? "").trim().length,
        `${a.key} scholarDescription is non-empty`,
      ).toBeGreaterThan(0);
      const lower = (blurb ?? "").toLowerCase();
      for (const word of banned) {
        expect(
          lower.includes(word),
          `${a.key} scholarDescription must not leak "${word}"`,
        ).toBe(false);
      }
    }
  });

  test("activity inserter passes scholarDescription through to the row", async () => {
    // Guards the seedRichCohort inserter: an authored scholarDescription must
    // survive to the persisted `activities` row (not silently dropped).
    const { t } = await seeded();
    const activities = await t.run(async (ctx) =>
      ctx.db.query("activities").collect(),
    );
    const byTitle = new Map(activities.map((a) => [a.title, a]));

    const fixtureBaselines = richSeed.units
      .flatMap((u) => u.lessons)
      .flatMap((l) => l.activities)
      .filter((a) => a.recipe === "baseline");

    for (const a of fixtureBaselines) {
      const row = byTitle.get(a.title);
      expect(row?.scholarDescription, `${a.key} persisted scholarDescription`).toBe(
        a.scholarDescription,
      );
    }
  });

  test("roster shape — teachers, scholars, parents, groups partition", async () => {
    const { t } = await seeded();
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    const byRole = (r: string) => users.filter((u) => u.role === r);

    expect(byRole("teacher").length).toBe(richSeed.teachers.length);
    expect(byRole("scholar").length).toBe(richSeed.scholars.length);
    expect(byRole("parent").length).toBe(richSeed.parents.length);
    for (const scholar of byRole("scholar")) {
      expect(scholar.profileSetupComplete, `${scholar.username} profile setup`).toBe(
        true,
      );
    }

    // Every user is dev-login-able (username set, mirrored to externalId).
    for (const u of users) {
      expect(u.username, `${u.name} username`).toBeTruthy();
      expect(u.externalId).toBe(u.username);
    }

    // Enrolled scholars retain one primary cohort and may also join additive
    // program groups. Program guests belong only to their program group.
    const groups = await t.run(async (ctx) =>
      ctx.db.query("scholarGroups").collect(),
    );
    expect(groups).toHaveLength(richSeed.groups.length);
    for (const group of groups) {
      expect(group.emoji?.trim(), `${group.name} emoji`).toBeTruthy();
    }
    const scholarIds = new Set(byRole("scholar").map((u) => u._id));
    const seen = new Map<string, number>();
    for (const group of groups) {
      for (const sid of group.scholarIds) {
        seen.set(sid, (seen.get(sid) ?? 0) + 1);
      }
    }
    for (const sid of scholarIds) {
      const scholar = byRole("scholar").find((user) => user._id === sid);
      expect(seen.get(sid), "each scholar belongs to at least one group").toBeGreaterThanOrEqual(1);
      if (scholar?.enrollmentStanding === "program_guest") {
        expect(seen.get(sid), "program guests belong only to program groups").toBe(1);
      }
    }
    expect(seen.size).toBe(scholarIds.size);
  });

  test("dev Sloane owns Robotics with scoped capabilities, not teacher access", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.seedRichCohort.seedAll, {});
      await ctx.runMutation(internal.seed.devPersonas.seedDevPersonas, {});
    });

    const {
      sloane,
      robotics,
      roboticsPlacements,
      memberships,
      grants,
      moli,
    } = await t.run(async (ctx) => {
      const sloane = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", "sloane"))
        .unique();
      const moli = (await ctx.db.query("institutions").collect()).find(
        (institution) => institution.isPrimary,
      );
      const robotics = (await ctx.db.query("scholarGroups").collect()).find(
        (group) => group.type === "robotics",
      );
      const memberships = sloane
        ? await ctx.db
            .query("memberships")
            .withIndex("by_user", (q) => q.eq("userId", sloane._id))
            .collect()
        : [];
      const grants = sloane
        ? (await ctx.db.query("staffCapabilityGrants").collect()).filter(
            (grant) => grant.granteeUserId === sloane._id,
          )
        : [];
      const roboticsPlacements = robotics
        ? (await ctx.db.query("schedulePlacements").collect()).filter(
            (placement) => placement.groupId === robotics._id,
          )
        : [];
      return {
        sloane,
        robotics,
        roboticsPlacements,
        memberships,
        grants,
        moli,
      };
    });

    expect(sloane?.role).toBe("staff");
    expect(robotics?.ownerId).toBe(sloane?._id);
    expect(roboticsPlacements.length).toBeGreaterThan(0);
    expect(
      roboticsPlacements.every(
        (placement) => placement.teacherId === sloane?._id,
      ),
    ).toBe(true);
    expect(memberships.map((membership) => membership.role).sort()).toEqual([
      "parent",
      "staff",
    ]);
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          institutionId: moli?._id,
          capability: "curriculum:edit",
        }),
        expect.objectContaining({
          institutionId: moli?._id,
          scholarGroupId: robotics?._id,
          capability: "program:publish",
        }),
        expect.objectContaining({
          institutionId: moli?._id,
          scholarGroupId: robotics?._id,
          capability: "captures:review",
        }),
      ]),
    );
  });

  test("weekly timetable mirrors the seeded school cadence", async () => {
    const { t } = await seeded();
    const blocks = await t.run(async (ctx) =>
      ctx.db.query("scheduleBlocks").collect(),
    );
    expect(
      blocks
        .filter((block) => block.kind !== "homework")
        .map((block) => [
          block.label,
          block.startLocal,
          block.endLocal,
          block.weekdays,
        ]),
    ).toEqual([
      ["Morning Circle", "08:00", "08:30", [1, 2, 3, 4, 5]],
      ["Block A", "08:30", "09:40", [1, 2, 3, 4, 5]],
      ["Block B", "09:40", "10:50", [1, 2, 3, 4, 5]],
      ["Recess A", "10:50", "11:05", [1, 2, 3, 4]],
      ["Block C", "11:10", "12:20", [1, 2, 3, 4]],
      ["Lunch / Recess", "12:20", "13:00", [1, 2, 3, 4]],
      ["Block D", "13:00", "14:10", [1, 2, 3, 4]],
      ["Recess B", "14:10", "14:25", [1, 2, 3, 4]],
      ["Scholar’s Prep", "14:30", "15:00", [1, 2, 3, 4]],
      ["Block E", "15:05", "16:30", [1, 2, 3, 4]],
    ]);
    expect(
      blocks.find((block) => block.label === "Scholar’s Prep")?.kind,
    ).toBe("prep");

    const groups = await t.run(async (ctx) =>
      ctx.db.query("scholarGroups").collect(),
    );
    const groupByName = new Map(groups.map((group) => [group.name, group]));
    const placements = await t.run(async (ctx) =>
      ctx.db.query("schedulePlacements").collect(),
    );
    const blocksById = new Map(blocks.map((block) => [block._id, block]));
    const friday = placements
      .filter((row) => row.weekday === 5)
      .map((row) => ({
        group: groups.find((group) => group._id === row.groupId)?.name,
        block: row.blockId ? blocksById.get(row.blockId)?.label : undefined,
        subject: row.subject,
      }));
    expect(friday).toEqual([
      { group: "ʻIwa", block: "Block A", subject: "Humanities" },
      { group: "ʻIwa", block: "Block B", subject: "Science" },
      { group: "Honu", block: "Block A", subject: "Science" },
      { group: "Honu", block: "Block B", subject: "Humanities" },
    ]);
    expect(groupByName.has("ʻIwa")).toBe(true);
    expect(groupByName.has("Honu")).toBe(true);
  });

  test("showcase scholar Home has all four core subjects", async () => {
    const { t } = await seeded();
    await t.run(async (ctx) =>
      ctx.runMutation(internal.masterSchedule.autoMaterializeTick, {}),
    );
    const scholar = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", "leilani_park"))
        .unique(),
    );
    expect(scholar).toBeTruthy();
    const asScholar = await withUser(t, scholar!._id);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const tabs = deriveHomeTabs({
      subjectTabs: plate.subjectTabs,
      rows: plate.rows,
    }).tabs.map((tab) => tab.label);

    expect(
      new Set(
        plate.rows
          .filter(
            (row) =>
              row.origin === "classFocus" || row.origin === "homework",
          )
          .map((row) => row.subject),
      ),
    ).toEqual(
      new Set(["Humanities", "Language Arts", "Math Workshop", "Science"]),
    );
    expect(tabs).toEqual([
      "Now",
      "All",
      "Humanities",
      "Language Arts",
      "Math",
      "Science",
      "Scholar’s Prep",
      "Quests",
    ]);
  });

  test("leilani_park has a deterministic mid-journey practice blend (≥2 domains, sustained, no card↔session divergence)", async () => {
    // Unlike the other tests here, this one seeds the PRACTICE GRAPH first — the
    // rich-cohort practiceMastery fixture (convex/seed/rich/practice.ts) derives
    // each row's domain/strand from a knowledgeNodes node and SKIPS any skill
    // whose node is absent, so without the graph it inserts nothing (which is
    // exactly why the graph-less `seeded()` helper stays green). With the graph
    // present the fixture lights up, and we drive the REAL functions the native
    // card + Start button call to prove the blend is non-empty, sustained, and
    // interleaved — and that no domain the card can preview dead-ends at Start.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.practiceSkills.seedGraph, {});
      await ctx.runMutation(internal.seedRichCohort.seedAll, {});
      await ctx.runMutation(
        internal.practiceSkills.seedDefaultManipulativePractice,
        {},
      );
      await ctx.runMutation(internal.practiceSkills.seedFadedWorkedExamples, {});
    });

    const leilani = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", "leilani_park"))
        .unique(),
    );
    expect(leilani).toBeTruthy();
    const asScholar = await withUser(t, leilani!._id);

    // (a) ≥2 started domains → the interleaved blend path is exercised.
    const domains = await asScholar.query(api.practiceSkills.domainsForScholar, {
      scholarId: leilani!._id,
    });
    const startedDomains = domains.filter((d) => d.started).map((d) => d.domain);
    expect(startedDomains).toContain("whole-number-arithmetic");
    expect(startedDomains).toContain("fraction-arithmetic");
    expect(startedDomains.length).toBeGreaterThanOrEqual(2);

    // (b) The native card preview (playlistForScholar, single-domain, mapping-aware)
    //     is non-empty — the card advertises real work.
    const card = await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: leilani!._id,
      domain: startedDomains[0],
      includeMapping: true,
    });
    expect(card.set.length).toBeGreaterThan(0);
    expect(card.needsPlacement).toBe(false);

    // (c) Start (practiceSession, mixed domains) serves a SUSTAINED, INTERLEAVED
    //     session — fills the session and spans both started domains.
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: leilani!._id,
      size: 6,
      seed: 42,
      domains: startedDomains,
      includeMapping: true,
    });
    const servedDomains = new Set(
      session.items.map((it) => it.domain).filter(Boolean),
    );
    expect(session.items.length).toBeGreaterThanOrEqual(6);
    expect(session.items.length).toBeGreaterThan(2); // not a two-item dead-end
    expect(servedDomains.size).toBeGreaterThanOrEqual(2);
    expect(session.allMapping).toBe(false); // a real blend, not the cold-start band

    // (d) No card↔session divergence: EVERY domain the card can preview actually
    //     serves items at Start (the original bug class — card non-empty but
    //     session empty). Check each started domain's single-domain session.
    for (const d of startedDomains) {
      const single = await asScholar.query(
        api.practiceSkills.practiceSession,
        { scholarId: leilani!._id, size: 6, seed: 7, domain: d },
      );
      expect(single.items.length).toBeGreaterThan(0);
    }

    // Surface the numbers for the PR body (run with --disableConsoleIntercept).
    console.log(
      `[leilani practice] startedDomains=${JSON.stringify(startedDomains)} ` +
        `cardSet=${card.set.length} servedItems=${session.items.length} ` +
        `servedDomains=${JSON.stringify([...servedDomains])}`,
    );
  });

  test("every scholar is assigned a unit in all four core subjects", async () => {
    const { t } = await seeded();
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    const scholars = users.filter((u) => u.role === "scholar");
    expect(scholars.length).toBeGreaterThan(0);

    const units = await t.run(async (ctx) => ctx.db.query("units").collect());
    const subjectByUnit = new Map(
      units.map((u) => [String(u._id), u.subject?.trim() ?? null]),
    );
    const assignments = await t.run(async (ctx) =>
      ctx.db.query("assignments").collect(),
    );
    // scholarId → the set of subjects they are assigned a unit in.
    const subjectsByScholar = new Map<string, Set<string>>();
    for (const assignment of assignments) {
      if (!assignment.unitId) continue;
      const subject = subjectByUnit.get(String(assignment.unitId));
      if (!subject) continue;
      for (const scholarId of assignment.scholarIds) {
        const key = String(scholarId);
        if (!subjectsByScholar.has(key)) subjectsByScholar.set(key, new Set());
        subjectsByScholar.get(key)!.add(subject);
      }
    }

    // Full-school curriculum expectations apply only to enrolled scholars.
    const CORE_SUBJECTS = [
      "Humanities",
      "Language Arts",
      "Math Workshop",
      "Science",
    ];
    for (const scholar of scholars) {
      if (scholar.enrollmentStanding === "program_guest") continue;
      const subjects = subjectsByScholar.get(String(scholar._id)) ?? new Set();
      for (const subject of CORE_SUBJECTS) {
        expect(
          subjects.has(subject),
          `${scholar.username} is not assigned ${subject}`,
        ).toBe(true);
      }
    }
  });

  test("every session has ≥1 message, and last-message metadata is derived", async () => {
    const { t } = await seeded();
    const sessions = await t.run(async (ctx) =>
      ctx.db.query("sessions").collect(),
    );
    expect(sessions.length).toBeGreaterThan(0);
    for (const sess of sessions) {
      const msgs = await t.run(async (ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", sess._id))
          .collect(),
      );
      expect(msgs.length, `session "${sess.title}" has messages`).toBeGreaterThan(0);
      expect(sess.lastMessageAt).toBeTruthy();
      expect(sess.lastMessageRole).toBeTruthy();
    }
  });

  test("scripted execution sessions are marked as seed exemplars", async () => {
    const { t } = await seeded();
    const sessions = await t.run(async (ctx) =>
      ctx.db.query("sessions").collect(),
    );
    expect(sessions.length).toBeGreaterThan(0);
    for (const sess of sessions) {
      expect(sess.seedExemplar, `session "${sess.title}" seed exemplar`).toBe(
        true,
      );
    }
  });

  test("observer scores use the real scales — 0–1 analyses, 0–5 pulse", async () => {
    // The observer writes engagementScore/complexityLevel/onTaskScore as 0–1
    // and pulseScore as 0–5 (convex/lib/observerShared.ts). Seeding 0–100
    // values makes any aggregating surface (weekly digest, sparklines) show
    // absurd numbers on dev deployments.
    const { t } = await seeded();
    const analyses = await t.run(async (ctx) => ctx.db.query("analyses").collect());
    expect(analyses.length).toBeGreaterThan(0);
    for (const a of analyses) {
      for (const field of ["engagementScore", "complexityLevel", "onTaskScore"] as const) {
        const value = a[field];
        if (value === undefined) continue;
        expect(value, `analysis ${field} is on the 0–1 scale`).toBeGreaterThanOrEqual(0);
        expect(value, `analysis ${field} is on the 0–1 scale`).toBeLessThanOrEqual(1);
      }
    }
    const sessions = await t.run(async (ctx) => ctx.db.query("sessions").collect());
    const withPulse = sessions.filter((s) => s.pulseScore !== undefined);
    expect(withPulse.length).toBeGreaterThan(0);
    for (const sess of withPulse) {
      expect(sess.pulseScore, `session "${sess.title}" pulse is on the 0–5 scale`).toBeGreaterThanOrEqual(0);
      expect(sess.pulseScore, `session "${sess.title}" pulse is on the 0–5 scale`).toBeLessThanOrEqual(5);
    }
  });

  test("referential — mastery supersession chains resolve", async () => {
    const { t } = await seeded();
    const mastery = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    const ids = new Set(mastery.map((m) => m._id));
    const withSupersedes = mastery.filter((m) => m.supersedesId);
    // The fixture is supposed to demonstrate growth — at least one chain.
    expect(withSupersedes.length).toBeGreaterThan(0);
    for (const m of withSupersedes) {
      expect(ids.has(m.supersedesId!), "supersedesId points at a real row").toBe(
        true,
      );
      // The superseded row should be flagged as such.
      const prior = mastery.find((x) => x._id === m.supersedesId);
      expect(prior?.isSuperseded).toBe(true);
    }
  });

  test("referential — granuleEvidence keys exist on their unit", async () => {
    const { t } = await seeded();
    const units = await t.run(async (ctx) => ctx.db.query("units").collect());
    const granuleKeysByUnit = new Map<string, Set<string>>();
    for (const u of units) {
      const keys = new Set<string>([
        ...normalizeGranules(u.essentialQuestions, "eq").map((q) => q.key),
        ...normalizeGranules(u.enduringUnderstandings, "eu").map((e) => e.key),
      ]);
      granuleKeysByUnit.set(u._id, keys);
    }
    const evidence = await t.run(async (ctx) =>
      ctx.db.query("granuleEvidence").collect(),
    );
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      const keys = granuleKeysByUnit.get(e.unitId);
      expect(keys, "evidence references a seeded unit").toBeTruthy();
      expect(
        keys!.has(e.granuleKey),
        `granuleKey "${e.granuleKey}" exists on its unit`,
      ).toBe(true);
    }
  });

  test("referential — momentTriage sourceId points at a real mastery row", async () => {
    const { t } = await seeded();
    const mastery = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    const masteryIds = new Set(mastery.map((m) => m._id as string));
    const triage = await t.run(async (ctx) =>
      ctx.db.query("momentTriage").collect(),
    );
    expect(triage.length).toBeGreaterThan(0);
    for (const m of triage) {
      if (m.source === "mastery") {
        expect(masteryIds.has(m.sourceId), "sourceId resolves to a mastery row").toBe(
          true,
        );
      }
    }
  });

  test("referential — experiment ↔ variant circular link is wired both ways", async () => {
    const { t } = await seeded();
    const experiments = await t.run(async (ctx) =>
      ctx.db.query("curriculumExperiments").collect(),
    );
    const variants = await t.run(async (ctx) =>
      ctx.db.query("curriculumVariants").collect(),
    );
    const variantIds = new Set(variants.map((v) => v._id));
    const experimentIds = new Set(experiments.map((e) => e._id));
    expect(experiments.length).toBeGreaterThan(0);
    expect(variants.length).toBeGreaterThan(0);

    for (const e of experiments) {
      if (e.baselineVariantId) {
        expect(variantIds.has(e.baselineVariantId)).toBe(true);
      }
    }
    // At least one variant back-references its experiment.
    const linked = variants.filter((v) => v.experimentId);
    expect(linked.length).toBeGreaterThan(0);
    for (const v of linked) {
      expect(experimentIds.has(v.experimentId!)).toBe(true);
    }
  });

  test("referential — guardianships link real parents to real scholars", async () => {
    const { t } = await seeded();
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    const parentIds = new Set(
      users.filter((u) => u.role === "parent").map((u) => u._id),
    );
    const scholarIds = new Set(
      users.filter((u) => u.role === "scholar").map((u) => u._id),
    );
    const links = await t.run(async (ctx) =>
      ctx.db.query("guardianships").collect(),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const g of links) {
      expect(parentIds.has(g.parentUserId), "parent exists").toBe(true);
      expect(scholarIds.has(g.scholarUserId), "scholar exists").toBe(true);
    }
  });

  test("independent study — scholar-authored units have teacherId === authorScholarId === the scholar", async () => {
    const { t } = await seeded();
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    const scholarIds = new Set(
      users.filter((u) => u.role === "scholar").map((u) => u._id as string),
    );
    const units = await t.run(async (ctx) => ctx.db.query("units").collect());
    const isUnits = units.filter((u) => u.authorScholarId);
    // The fixture must seed at least one IS unit so the teacher "Independent"
    // tab (units.listScholarAuthored) renders real data.
    expect(isUnits.length).toBeGreaterThan(0);
    for (const u of isUnits) {
      // Mirrors createQuest: the scholar owns the unit outright.
      expect(scholarIds.has(u.authorScholarId as string), "author is a scholar").toBe(
        true,
      );
      expect(u.teacherId).toBe(u.authorScholarId);
      // IS units must carry at least one lesson so the tab shows real counts.
      const lessons = await t.run(async (ctx) =>
        ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", u._id))
          .collect(),
      );
      expect(lessons.length, `IS unit "${u.title}" has lessons`).toBeGreaterThan(0);
    }
  });

  test("teacher chat — every chat session belongs to a real teacher and has ≥1 message", async () => {
    const { t } = await seeded();
    const users = await t.run(async (ctx) => ctx.db.query("users").collect());
    const teacherIds = new Set(
      users.filter((u) => u.role === "teacher").map((u) => u._id as string),
    );
    const sessions = await t.run(async (ctx) =>
      ctx.db.query("chats").collect(),
    );
    expect(sessions.length).toBeGreaterThan(0);
    const messages = await t.run(async (ctx) =>
      ctx.db.query("curriculumMessages").collect(),
    );
    const sessionIds = new Set(sessions.map((s) => s._id as string));
    const teachersWithChat = new Set<string>();
    for (const s of sessions) {
      expect(teacherIds.has(s.teacherId as string), "chat owner is a teacher").toBe(
        true,
      );
      teachersWithChat.add(s.teacherId as string);
      const msgs = messages.filter((m) => m.chatId === s._id);
      expect(msgs.length, `chat "${s.title}" has messages`).toBeGreaterThan(0);
    }
    // Every curriculum message that names a session must name a real one.
    for (const m of messages) {
      if (m.chatId) {
        expect(sessionIds.has(m.chatId as string), "message session exists").toBe(
          true,
        );
      }
    }
    // Every teacher represented in the curriculum-chat fixture has history.
    expect(teachersWithChat.size).toBe(
      new Set(richSeed.chats.map((chat) => chat.teacherKey)).size,
    );
  });
});
