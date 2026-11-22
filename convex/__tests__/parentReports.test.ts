import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld } from "./factories/world";
import { atClock } from "./clockTestHelpers";
import { deriveUnitIds, MAX_TERM_SESSIONS, narrativeToProse } from "../courseNarratives";
import {
  buildParentReportUserPrompt,
  classAlwaysReported,
  classForReportSubject,
  mathReportClass,
  NO_CLASS_WORK_REFUSAL,
  checkDraft,
  cleanDraft,
  DRAFT_STALE_MS,
  parseEnrichmentList,
  buildEnrichmentListRequest,
  pickEvidence,
  splitDraftPieces,
  findPlaceholders,
  isDrafting,
  publishBlocker,
  subjectKey,
  ENRICHMENT_SUBJECT,
  ENRICHMENT_TITLE,
  enrichmentListBody,
  hiddenClassRefusal,
  isEnrichmentSubject,
  NO_ENRICHMENT_REFUSAL,
  NOT_REPORTED_SUBJECT,
  reportBucketForUnit,
  reportTitle,
  wholeGradeLevel,
} from "../lib/parentReport";

/**
 * Parent reports: one prose report per derived subject plus SEL, drafted from
 * the record with bracketed placeholders for what the record lacks, and never
 * publishable while a placeholder remains.
 */

// The drafter's model calls; each test queues the replies it needs and can
// read the requests that were sent.
const model = vi.hoisted(() => ({
  replies: [] as Record<string, unknown>[],
  requests: [] as { messages: { role: string; content: unknown }[] }[],
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      create: async (req: { messages: { role: string; content: unknown }[] }) => {
        model.requests.push({ messages: [...req.messages] });
        const reply = model.replies.shift();
        if (!reply) throw new Error("no model reply queued");
        return { usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn", ...reply };
      },
    };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});
const reply = (text: string, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text }] });

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 24 * 3_600_000;

describe("parent report helpers", () => {
  test("words a grade-equivalent value as the grade being worked in, never the next one up", () => {
    expect(wholeGradeLevel(6.5)).toBe("sixth-grade level");
    expect(wholeGradeLevel(6.9)).toBe("sixth-grade level");
    expect(wholeGradeLevel(7)).toBe("seventh-grade level");
    expect(wholeGradeLevel(0.4)).toBe("kindergarten level");
    expect(wholeGradeLevel(13.2)).toBe("grade-13 level");
  });

  test("placeholders are single-line bracketed spans", () => {
    const body = "Oliver read [title of the novel] and [a moment]. No [split\nline].";
    expect(findPlaceholders(body).map((p) => p.text)).toEqual(["[title of the novel]", "[a moment]"]);
    const [first] = findPlaceholders(body);
    expect(body.slice(first.start, first.end)).toBe("[title of the novel]");
  });

  test("subjects fold math spellings and SEL together", () => {
    expect(subjectKey("Mathematics")).toBe("math");
    expect(subjectKey(" maths ")).toBe("math");
    expect(subjectKey("SEL")).toBe("sel");
    expect(subjectKey("Humanities")).toBe("humanities");
  });

  test("a report with placeholders, or with nothing written, can't be published", () => {
    expect(publishBlocker([{ key: "report", title: "Report", body: "Great term. [a goal]" }])).toMatch(/1 highlighted placeholder/);
    expect(publishBlocker([{ key: "report", title: "Report", body: "  " }])).toMatch(/Write the report/);
    expect(publishBlocker([{ key: "report", title: "Report", body: "All filled in." }])).toBeNull();
    // Rubric notes from the old form are never published on their own.
    expect(publishBlocker([{ key: "progress", title: "Progress", body: "Did well." }])).toMatch(/Write the report/);
  });

  test("a prose-form report needs prose; its earlier notes are never published on their own", () => {
    expect(
      publishBlocker([
        { key: "report", title: "Report", body: "" },
        { key: "progress", title: "Progress", body: "Teacher note." },
      ]),
    ).toMatch(/Write the report/);
    // Brackets in hidden notes don't block a finished prose report.
    expect(
      publishBlocker([
        { key: "report", title: "Report", body: "Done." },
        { key: "progress", title: "Progress", body: "[old note]" },
      ]),
    ).toBeNull();
  });

  test("a draft request goes stale so a killed draft can't lock the report", () => {
    expect(isDrafting({ draftRequestedAt: 1000 }, 1000 + DRAFT_STALE_MS - 1)).toBe(true);
    expect(isDrafting({ draftRequestedAt: 1000 }, 1000 + DRAFT_STALE_MS)).toBe(false);
    expect(isDrafting({}, 0)).toBe(false);
  });

  test("parents see only the prose once a report body exists", () => {
    const prose = narrativeToProse("Math", "Fall 2026", [
      { key: "report", title: "Report", body: "The report." },
      { key: "progress", title: "Progress", body: "Private teacher note." },
    ]);
    expect(prose).toBe("Math — Fall 2026\n\nThe report.");
  });

  test("the prompt says so when no family goals exist", () => {
    const prompt = buildParentReportUserPrompt({
      scholarFirstName: "Ada",
      pronouns: null,
      pieces: [],
      gradeLevel: "3",
      subject: "Math",
      isSel: false,
      periodLabel: "Fall",
      periodStart: "2026-08-01",
      periodEnd: "2026-12-01",
      familyGoals: [],
      groups: [{ key: "units", label: "Units", items: [] }],
    });
    expect(prompt).toMatch(/none recorded — do not mention family goals/);
    expect(prompt).toMatch(/grade 3/);
  });

  test("evidence is picked newest first, one per repeated thing, spread across kinds", () => {
    const picked = pickEvidence(
      [
        { text: "old fractions", at: 1, bucket: "fractions" },
        { text: "new fractions", at: 9, bucket: "fractions" },
        { text: "mid fractions", at: 5, bucket: "fractions" },
        { text: "geometry", at: 2, bucket: "geometry" },
        { text: "Area: first try", at: 3, key: "Area" },
        { text: "Area: later try", at: 8, key: "Area" },
      ],
      4,
    );
    expect(picked).toEqual(["new fractions", "Area: later try", "geometry", "mid fractions"]);
  });

  test("the draft check catches the rules drafts drift from, and ignores placeholders", () => {
    const clean = "Ada worked through it with Rabbithole and is working at a seventh-grade level. [a moment from class]";
    expect(checkDraft(clean)).toEqual([]);
    expect(checkDraft("Ada showed her work.")).toEqual([expect.stringMatching(/pronouns/)]);
    expect(checkDraft("Ada is at grade 6.9 in fractions.")).toEqual([expect.stringMatching(/decimal grade/)]);
    expect(checkDraft("Ada's metacognition grew.")).toEqual([expect.stringMatching(/jargon/)]);
    expect(checkDraft("Ada thanked a tutor.")).toEqual([expect.stringMatching(/a tutor/)]);
    expect(checkDraft("Ada corrected the AI tutor.")).toEqual([expect.stringMatching(/a tutor/)]);
    expect(checkDraft("Ada told Rabbithole, the AI tutor, that books beat AI.")).toHaveLength(2);
    expect(checkDraft("Ada told Rabbithole, the AI, that books are more reliable.")).toEqual([expect.stringMatching(/just say/)]);
    expect(checkDraft("Ada corrected the AI when it got the ending wrong.")).toEqual([]);
    expect(checkDraft("The evidence shows Ada grew.")).toEqual([expect.stringMatching(/about the evidence/)]);
    expect(checkDraft(Array(241).fill("word").join(" "))).toEqual([expect.stringMatching(/241 words/)]);
    // A placeholder's wording is the teacher's to fill, and quoted words aren't the report's.
    expect(checkDraft("Ada grew. [what her teacher noticed]")).toEqual([]);
    expect(checkDraft('Ada loved "Where the Red Fern Grows" and wrote "he ran home" in dialogue.')).toEqual([]);
    // Ordinary prose that only looks like a rule break.
    expect(checkDraft("Ada weighed the evidence from two sources about the American frontier.")).toEqual([]);
  });

  test("the pronoun check follows the profile, and stock closing lines are flagged", () => {
    expect(checkDraft("Ada showed her work.", "she/her")).toEqual([]);
    expect(checkDraft("Ada showed his work.", "she/her")).toEqual([expect.stringMatching(/\(she\/her\)/)]);
    expect(checkDraft("Ada showed her work.", "they/them")).toEqual([expect.stringMatching(/\(they\/them\)/)]);
    expect(checkDraft("Ada showed her work.", "she/they")).toEqual([]);
    expect(checkDraft("Ada showed her work.", null)).toEqual([expect.stringMatching(/he\/she/)]);
    expect(checkDraft("We can't wait to see what Ada builds next.")).toEqual([expect.stringMatching(/stock line/)]);
    expect(checkDraft("We're excited to watch Ada grow.")).toEqual([expect.stringMatching(/stock line/)]);
    expect(checkDraft("We can’t wait to read Ada’s next story.")).toEqual([expect.stringMatching(/stock line/)]);
    expect(checkDraft("Ada is a joy to have in class.")).toEqual([expect.stringMatching(/stock line/)]);
    expect(checkDraft("We've seen Ada's confidence grow, and we're excited to watch it keep growing.")).toEqual([expect.stringMatching(/stock line/)]);
    // About the child, not a closer.
    expect(checkDraft("Ada can't wait to start the next unit, and was excited to see the graph match.")).toEqual([]);
    expect(checkDraft("This term Ada grew into a more honest and independent learner.")).toEqual([expect.stringMatching(/without a before/)]);
    expect(checkDraft("Ada became more careful once fractions came up.")).toEqual([expect.stringMatching(/without a before/)]);
    expect(checkDraft("Ada asks for a hint when stuck and checks her work.", "she/her")).toEqual([]);
  });

  test("the request gives the drafter the profile pronouns, or says to use they/them", () => {
    const base = {
      scholarFirstName: "Ada", gradeLevel: null, subject: "SEL", isSel: true, periodLabel: "Fall 2026",
      periodStart: "2026-08-11", periodEnd: "2026-12-19", familyGoals: [], groups: [], pieces: [],
    };
    expect(buildParentReportUserPrompt({ ...base, pronouns: "she/her" })).toMatch(/for Ada \(pronouns: she\/her — use exactly these\)/);
    expect(buildParentReportUserPrompt({ ...base, pronouns: null })).toMatch(/for Ada \(pronouns unknown — default they\/them\)/);
  });

  test("the drafter's Pieces line becomes the report's piece list", () => {
    const offered = [{ ref: 1, id: "a" }, { ref: 2, id: "b" }];
    expect(splitDraftPieces("Report text.\n\nPieces: 2, 1, 2, 7", offered)).toEqual({ text: "Report text.", pieceIds: ["b", "a"], found: true });
    expect(splitDraftPieces("Report text.\nPieces: none", offered)).toEqual({ text: "Report text.", pieceIds: [], found: true });
    expect(splitDraftPieces("Report text.", offered)).toEqual({ text: "Report text.", pieceIds: [], found: false });
    expect(splitDraftPieces("Report text.\nPieces: 2\n\nLet me know if you'd like changes.", offered)).toEqual({ text: "Report text.", pieceIds: ["b"], found: true });
    expect(splitDraftPieces("Report text.\n**Pieces:** 1", offered)).toEqual({ text: "Report text.", pieceIds: ["a"], found: true });
    expect(checkDraft("Ada's essay (piece 2) shows a clear theme.")).toEqual([expect.stringMatching(/piece number/)]);
  });

  test("cleanDraft drops a heading line and wrapping quotes", () => {
    expect(cleanDraft('# Math report\n\n"Ada grew."')).toBe("Ada grew.");
  });
});

async function setup() {
  const t = convexTest(schema, modules);
  // The school's people exist well before the term, so the pace window is
  // the whole term (it starts no earlier than a scholar's account).
  const world = await atClock(Date.now() - 365 * DAY, () => makeWorld(t, { schools: 2, scholarsPerSchool: 1, parentsPerSchool: 1 }));
  const [a, b] = world.schools;
  const scholarId = a.scholars[0].id;
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: now - 30 * DAY,
      endsAt: now + 10 * DAY,
      status: "writing",
      institutionId: a.id,
    });
    const teacherId = (await ctx.db.query("users").collect()).find((u) => u.role !== "scholar")!._id;
    const humanities = await ctx.db.insert("units", { teacherId, title: "Wild Robot", subject: "Humanities", isActive: true });
    const science = await ctx.db.insert("units", { teacherId, title: "Volcanoes", subject: "Science", isActive: true });
    const humSession = await ctx.db.insert("sessions", { userId: scholarId, unitId: humanities, title: "s", isArchived: false });
    const sciSession = await ctx.db.insert("sessions", { userId: scholarId, unitId: science, title: "s", isArchived: false });
    // Practice fluency in the window → Math gets a report with no math unit.
    await ctx.db.insert("knowledgeNodes", { nodeKey: "plot_points_q1", label: "Plot points in the first quadrant", domain: "integers-coordinates", grade: "5" });
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: "plot_points_q1",
      domain: "integers-coordinates",
      repetition: 4,
      halfLifeDays: 10,
      lastPracticedAt: now - DAY,
      frontier: false,
      updatedAt: now,
      source: "practice",
      becameFluentAt: now - 2 * DAY,
    });
    // Mastery in each subject: only the matching one may reach a report.
    await ctx.db.insert("masteryObservations", {
      scholarId, conceptLabel: "Theme", domain: "literature", observedAt: now - DAY, sessionId: humSession,
      evidenceType: "explanation", evidenceSummary: "Explained the theme of belonging", isSuperseded: false,
      transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
    });
    await ctx.db.insert("masteryObservations", {
      scholarId, conceptLabel: "Magma", domain: "earth science", observedAt: now - DAY, sessionId: sciSession,
      evidenceType: "explanation", evidenceSummary: "Explained how magma rises", isSuperseded: false,
      transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
    });
    // Family goals from the check-in and a conference note (redacted fields only).
    await ctx.db.insert("interimCheckins", {
      scholarId, periodId, teacherId, ratings: {}, flags: [],
      comments: { strengths: "", growth: "", familyGoals: "Wants Ada to write longer pieces" },
      status: "draft",
    });
    await ctx.db.insert("scholarDocuments", {
      scholarId, kind: "conference_notes", format: "text", title: "Fall conference",
      summary: "Scored 140 on the WISC. Parents hope for more confidence speaking up.",
      redactedSummary: "Parents hope for more confidence speaking up.",
      uploadedBy: teacherId, processingStatus: "ready",
    });
    return { periodId, teacherId };
  });
  return { t, world, a, b, scholarId, ...ids };
}

describe("parent reports — subjects, evidence, drafting, publishing", () => {
  test("subjects are derived from the period's units and practice, plus SEL", async () => {
    const { world, a, scholarId, periodId } = await setup();
    const asA = await world.as.staffOf(a);
    const subjects = (await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rows.map((r) => r.subject);
    expect(subjects).toEqual(["Humanities", "Math", "Science", "SEL", ENRICHMENT_SUBJECT]);
  });

  test("evidence is scoped to the subject and carries family goals without scores", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    const all = e.groups.flatMap((g) => g.items).join("\n");
    expect(all).toMatch(/theme of belonging/);
    expect(all).not.toMatch(/magma/);
    expect(e.familyGoals.join("\n")).toMatch(/write longer pieces/);
    // The month says when the family shared it, so a draft can say so.
    expect(e.familyGoals[0]).toMatch(/^From the Fall 2026 check-in \([A-Z][a-z]+\): /);
    expect(e.familyGoals.join("\n")).toMatch(/confidence speaking up/);
    expect(e.familyGoals.join("\n")).not.toMatch(/WISC|140/);

    const mathId = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    const m = (await asA.query(api.parentReports.evidence, { narrativeId: mathId }))!;
    expect(m.groups.find((g) => g.key === "fluency")?.items.join("\n")).toMatch(/Plot points in the first quadrant \(grade 5 skill\)/);
    expect(m.groups.find((g) => g.key === "milestones")?.items).toEqual([]);
    await t.run(async (ctx) => {
      const issuedBy = (await ctx.db.query("users").collect()).find((u) => u.role !== "scholar")!._id;
      await ctx.db.insert("calculatorLicenses", { scholarId, issuedAt: Date.now() - DAY, issuedBy, expiresOn: "2099-01-01" });
    });
    const withLicense = (await asA.query(api.parentReports.evidence, { narrativeId: mathId }))!;
    expect(withLicense.groups.find((g) => g.key === "milestones")?.items.join("\n")).toMatch(/Calculator License/);
    void t;
  });

  test("a Math report gets the overall, per-area and term groups; other reports don't", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    await t.run(async (ctx) => {
      const now = Date.now();
      // Eighth grade: the overall level of about 6.7 sits more than half a
      // grade below the grade equivalent (8.1 to 8.9) in every school month,
      // so the position line is the teacher placeholder whenever the test runs.
      await ctx.db.patch(scholarId, { gradeLevel: "8" });
      const node = (nodeKey: string, label: string, domain: string, grade: string) =>
        ctx.db.insert("knowledgeNodes", { nodeKey, label, domain, grade });
      const row = (skillKey: string, domain: string, source: string, becameFluentAt?: number) =>
        ctx.db.insert("practiceMastery", {
          scholarId, skillKey, domain, repetition: 3, halfLifeDays: 10, lastPracticedAt: now - DAY,
          frontier: false, updatedAt: now, source, becameFluentAt,
        });
      // Coordinates (setup already holds plot_points_q1, grade 5, fluent two
      // days ago and never missed: already known). One more grade-5 skill
      // learned after a miss, one grade-5 and one grade-6 skill not reached,
      // and a grade-7 skill shown before the term: reach above the level.
      await node("plot_points_q4", "Plot points in all four quadrants", "integers-coordinates", "5");
      await node("reflect_points", "Reflect points across an axis", "integers-coordinates", "5");
      await node("ordered_pairs_rules", "Ordered pairs from a rule", "integers-coordinates", "6");
      await node("distance_on_grid", "Distance on a grid", "integers-coordinates", "7");
      await row("plot_points_q4", "integers-coordinates", "practice", now - 3 * DAY);
      await ctx.db.insert("practiceAttempts", { scholarId, nodeKey: "plot_points_q4", correct: false, createdAt: now - 4 * DAY });
      // Probability: its catalog is one grade-6 skill, new to the child this
      // term (one miss, at or above the level the term started at, 5.5), so
      // the area is finished. Older than the grade-5 skill above, it still
      // leads the fluency list: highest grade first.
      await node("simple_probability", "Probability of a single event", "probability", "6");
      await row("simple_probability", "probability", "practice", now - 5 * DAY);
      await ctx.db.insert("practiceAttempts", { scholarId, nodeKey: "simple_probability", correct: false, createdAt: now - 6 * DAY });
      await row("distance_on_grid", "integers-coordinates", "practice", now - 60 * DAY);
      // Fractions: one of two grade-3 skills credited by the placement check-in only.
      await node("add_like_fractions", "Add fractions with like denominators", "fraction-arithmetic", "3");
      await node("compare_fractions", "Compare fractions", "fraction-arithmetic", "3");
      await row("add_like_fractions", "fraction-arithmetic", "placement");
    });
    const asA = await world.as.staffOf(a);
    const mathId = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    const m = (await asA.query(api.parentReports.evidence, { narrativeId: mathId }))!;
    const keys = m.groups.map((g) => g.key);
    expect(keys.indexOf("overall")).toBeGreaterThan(-1);
    expect(keys.indexOf("overall")).toBeLessThan(keys.indexOf("level"));
    const items = (k: string) => m.groups.find((g) => g.key === k)?.items ?? [];
    // Three skills turned fluent this term: under the pace floor, so the
    // count is stated and no pace.
    expect(items("overall")).toEqual([
      'Across all math areas together: the record can\'t say yet how this compares with eighth-grade math. Write "[how this child\'s math compares with eighth-grade expectations]" for the teacher to fill in.',
      "Where this picture comes from: mostly from daily practice (4 skills observed in daily practice work, 1 skill credited from the placement check-in).",
      "Pace: 3 skills reached fluency in daily practice this term, too few to state a pace. Say nothing about pace, and nothing about how much the child practised: few new fluent skills can also mean the child spent the term reviewing skills already known.",
    ]);
    // A summary first, then curriculum order. Coordinates: grade 5 is
    // 5 + 2/3 of grade 5 + all of grade 7 = 6.67, while the highest skill shown
    // is grade 7. Grade 6 holds no credit, so its line words each grade's own
    // coverage instead of "most of the way through sixth grade" (cross-family
    // review). Probability's level, 7, is one past its catalog's top grade,
    // so it counts as sixth grade in the range. The tie in new learning keeps
    // curriculum order.
    expect(items("level")).toEqual([
      "Summary of 3 areas: All 2 areas with daily practice are at a sixth-grade level. Most new learning this term: Probability (1 skill new) and Integers & the coordinate plane (1 skill new). Resting on the placement check-in alone, with no daily practice yet: Fractions (third-grade level).",
      "Fractions: placed at a third-grade level by the placement check-in (1 skill credited), about halfway through that grade's skills here. No skills shown in daily practice in this area yet.",
      "Probability: has covered every probability skill through sixth grade. 1 skill shown in daily practice. This term: 1 skill new to the child this term reached fluency.",
      "Integers & the coordinate plane: covers most of fifth grade's skills, and some skills in higher grades up to seventh grade. 3 skills shown in daily practice. This term: 1 skill new to the child this term reached fluency, along with 1 skill the child already knew and has now shown.",
    ]);
    expect(items("level").join("\n")).not.toMatch(/\d\.\d|up from|seventh-grade level/);
    const fluency = items("fluency");
    expect(fluency[0]).toBe(
      "3 skills reached fluency in daily practice this term: 2 new to the child this term and 1 the child already knew and has now shown.",
    );
    // New skills first, highest grade first, so the drafter's examples are
    // the hardest new learning; then the already-known skill.
    expect(fluency[1]).toMatch(/^Probability of a single event \(grade 6 skill\): new to the child this term, fluent /);
    expect(fluency[2]).toMatch(/^Plot points in all four quadrants \(grade 5 skill\): new to the child this term, fluent /);
    expect(fluency[3]).toMatch(/^Plot points in the first quadrant \(grade 5 skill\): already known, now shown, fluent /);
    expect(fluency).toHaveLength(4);

    const humId = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const h = (await asA.query(api.parentReports.evidence, { narrativeId: humId }))!;
    for (const k of ["overall", "level", "fluency", "milestones"]) expect(h.groups.some((g) => g.key === k)).toBe(false);
  });

  test("drafting marks the report busy, lands prose, and clears the flag", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "SEL" });
    const requestedAt = Date.now();
    await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
    // A superseded request's result is dropped.
    await t.mutation(internal.parentReports.saveDraft, { narrativeId: id, requestedAt: requestedAt - 1, body: "Old draft." });
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.draftRequestedAt).toBe(requestedAt);
    await t.mutation(internal.parentReports.saveDraft, { narrativeId: id, requestedAt, body: "Ada grew. [a moment from class]" });
    const n = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(n.draftRequestedAt).toBeUndefined();
    expect(n.draftedAt).toBeTypeOf("number");
    expect(n.sections[0]).toEqual({ key: "report", title: "Report", body: "Ada grew. [a moment from class]" });
  });

  test("a draft the model didn't finish is an error, never a saved report", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "SEL" });
    const draft = async (r: Record<string, unknown>) => {
      model.replies = [r];
      const requestedAt = Date.now();
      await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
      await t.action(internal.parentReportActions.draft, { narrativeId: id, requestedAt });
      return (await t.run(async (ctx) => ctx.db.get(id)))!;
    };

    // Thinking used up the budget: the text stops mid-sentence.
    const cut = await draft(reply("Ada asked for a targeted hint rather than a full", "max_tokens"));
    expect(cut.draftError).toMatch(/cut off/);
    expect(cut.sections.find((s) => s.key === "report")?.body ?? "").toBe("");

    const done = await draft(reply("Ada grew this term."));
    expect(done.draftError).toBeUndefined();
    expect(done.sections.find((s) => s.key === "report")?.body).toBe("Ada grew this term.");
  });

  test("a draft that breaks a checked rule gets one revision", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const requestedAt = Date.now();
    await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
    model.requests = [];
    model.replies = [reply("Ada finished her essay."), reply("Ada finished the essay.")];
    await t.action(internal.parentReportActions.draft, { narrativeId: id, requestedAt });
    const n = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(n.sections.find((s) => s.key === "report")?.body).toBe("Ada finished the essay.");
    expect(model.requests).toHaveLength(2);
    const revision = model.requests[1].messages;
    expect(revision.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(String(revision[2].content)).toMatch(/pronouns/);
  });

  test("a revision that fails keeps the first draft", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const requestedAt = Date.now();
    await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
    model.replies = [reply("Ada finished her essay."), reply("Ada finished the", "max_tokens")];
    await t.action(internal.parentReportActions.draft, { narrativeId: id, requestedAt });
    const n = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(n.draftError).toBeUndefined();
    expect(n.sections.find((s) => s.key === "report")?.body).toBe("Ada finished her essay.");
  });

  test("work on paper from the subject joins the evidence, but a page shared with another scholar doesn't", async () => {
    const { world, a, b, scholarId, periodId, t } = await setup();
    const other = b.scholars[0].id;
    await t.run(async (ctx) => {
      const unit = (await ctx.db.query("units").collect()).find((u) => u.subject === "Humanities")!;
      const lessonId = await ctx.db.insert("lessons", { unitId: unit._id, title: "Essays", order: 0 });
      const activityId = await ctx.db.insert("activities", { lessonId, title: "Robot essay", kind: "offline", order: 0 });
      const page = { source: "upload" as const, matchStatus: "confirmed" as const, processingStatus: "ready" as const, activityId };
      const own = await ctx.db.insert("portfolioItems", { ...page, scholarId, title: "scan1", aiCaption: "A two-page essay on the robot" });
      await ctx.db.insert("masteryObservations", {
        scholarId, portfolioItemId: own, conceptLabel: "Theme", domain: "literature", observedAt: Date.now(),
        evidenceType: "explanation", evidenceSummary: "Named the theme of belonging", isSuperseded: false,
        transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
      });
      const shared = await ctx.db.insert("portfolioItems", { ...page, title: "scan2", aiCaption: "A poster made with a partner" });
      for (const sid of [scholarId, other]) await ctx.db.insert("portfolioAttributions", { portfolioItemId: shared, scholarId: sid, attributedAt: Date.now() });
    });
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    const items = e.groups.find((g) => g.key === "paperWork")!.items;
    // Each candidate line ends with its date; the piece number still leads.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/^\(piece 1\) Robot essay — A two-page essay on the robot\. Seen on the page: Theme: Named the theme of belonging \([A-Z][a-z]{2} \d{1,2}\)$/);
    expect(e.pieces.map((p) => [p.ref, p.title])).toEqual([[1, "Robot essay"]]);
  });

  test("a draft lists the pieces it describes; the family sees only shared ones; a teacher can take one off", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const { own, hidden } = await t.run(async (ctx) => {
      const unit = (await ctx.db.query("units").collect()).find((u) => u.subject === "Humanities")!;
      const lessonId = await ctx.db.insert("lessons", { unitId: unit._id, title: "Essays", order: 0 });
      const activityId = await ctx.db.insert("activities", { lessonId, title: "Robot essay", kind: "offline", order: 0 });
      const page = {
        source: "upload" as const, matchStatus: "confirmed" as const, assignmentStatus: "confirmed" as const,
        processingStatus: "ready" as const, activityId, scholarId,
      };
      return {
        own: await ctx.db.insert("portfolioItems", { ...page, title: "scan1", familyVisibility: "attributed_families" as const }),
        hidden: await ctx.db.insert("portfolioItems", { ...page, title: "scan2", familyVisibility: "staff_only" as const }),
      };
    });
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const offered = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!.pieces;
    expect(offered).toHaveLength(2);
    const requestedAt = Date.now();
    await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
    model.replies = [reply(`Ada wrote an essay about the robot.\nPieces: ${offered.map((p) => p.ref).join(", ")}, 99`)];
    await t.action(internal.parentReportActions.draft, { narrativeId: id, requestedAt });
    const n = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(n.sections.find((s) => s.key === "report")?.body).toBe("Ada wrote an essay about the robot.");
    expect(new Set(n.pieces)).toEqual(new Set([own, hidden]));

    // The composer says which one the family can't see.
    const listed = await asA.query(api.parentReports.reportPieces, { narrativeId: id });
    expect(listed.find((p) => p.id === hidden)?.familyCanSee).toBe(false);
    expect(listed.find((p) => p.id === own)?.familyCanSee).toBe(true);

    // Published: the family sees the shared piece only.
    await t.run(async (ctx) => ctx.db.patch(id, { status: "shared", sharedAt: Date.now() }));
    const asParent = await world.as.parent(a.parents[0]);
    const shared = await asParent.query(api.parents.childSharedNarratives, { scholarId });
    expect(shared.course[0].pieces.map((p) => p._id)).toEqual([own]);

    await asA.mutation(api.parentReports.removeReportPiece, { narrativeId: id, pieceId: own });
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.pieces).toEqual([hidden]);
  });

  test("a scholar's reports are drafted as one queue, SEL last, each seeing the ones before", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    const jobs = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toHaveLength(1);
    const args = jobs[0].args[0] as { narrativeId: Id<"courseNarratives">; requestedAt: number; next: { narrativeId: Id<"courseNarratives"> }[] };
    const order = await t.run(async (ctx) =>
      Promise.all([args.narrativeId, ...args.next.map((q) => q.narrativeId)].map(async (nid) => (await ctx.db.get(nid))!.subject)),
    );
    expect(order).toHaveLength(4);
    expect(order[3]).toBe("SEL");

    // Draft the first report, then check the next draft sees it.
    model.requests = [];
    model.replies = [reply("Ada built a volcano model this term.")];
    await t.action(internal.parentReportActions.draft, { narrativeId: args.narrativeId, requestedAt: args.requestedAt });
    const sel = args.next[args.next.length - 1].narrativeId;
    const gathered = (await t.query(internal.parentReports.evidenceForDraft, { narrativeId: sel }))!;
    if (gathered.kind !== "report") throw new Error("expected a report");
    expect(gathered.otherReports).toEqual([{ subject: order[0], body: "Ada built a volcano model this term." }]);
  });

  test("a queued report stays locked while the queue runs, and a replaced request drops out", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const ids = await Promise.all(
      ["Humanities", "Science", "SEL"].map((subject) => asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject })),
    );
    const old = Date.now() - DRAFT_STALE_MS + 1000; // about to go stale
    await t.run(async (ctx) => {
      for (const id of ids) await ctx.db.patch(id, { draftRequestedAt: old });
      await ctx.db.patch(ids[1], { draftRequestedAt: old + 1 }); // the teacher redrafted Science on its own
    });
    const live = await t.mutation(internal.parentReports.claimDraftQueue, {
      items: ids.map((narrativeId) => ({ narrativeId, requestedAt: old })),
    });
    expect(live.map((q) => q.narrativeId)).toEqual([ids[0], ids[2]]);
    const sel = (await t.run(async (ctx) => ctx.db.get(ids[2])))!;
    expect(sel.draftRequestedAt).toBe(live[1].requestedAt);
    expect(isDrafting(sel, Date.now() + DRAFT_STALE_MS - 2000)).toBe(true);
  });

  test("evidence shows the newest work of a long term, not its first weeks", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    await t.run(async (ctx) => {
      const sessions = await ctx.db.query("sessions").collect();
      let humSession = sessions[0]._id;
      for (const s of sessions) if ((await ctx.db.get(s.unitId!))?.subject === "Humanities") humSession = s._id;
      const now = Date.now();
      for (let i = 0; i < 30; i++)
        await ctx.db.insert("masteryObservations", {
          scholarId, conceptLabel: `Concept ${i}`, domain: "literature", observedAt: now - (30 - i) * 3_600_000,
          sessionId: humSession, evidenceType: "explanation", evidenceSummary: `Explained idea ${i}`,
          isSuperseded: false, transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8,
          attemptContext: "session", studentInitiated: false,
        });
    });
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    const items = e.groups.find((g) => g.key === "understanding")!.items;
    expect(items[0]).toMatch(/Concept 29/);
    expect(items.join("\n")).not.toMatch(/Concept 0:/);
  });

  test("a report with placeholders can't be published, alone or in bulk", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Science" });
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "Ada explored [a project]." });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: id, done: true });
    await expect(asA.mutation(api.courseNarratives.share, { narrativeId: id })).rejects.toThrow(/placeholder/);
    expect(await asA.mutation(api.courseNarratives.sharePeriod, { periodId })).toEqual({ shared: 0, held: 1 });

    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "Ada explored volcanoes." });
    await asA.mutation(api.courseNarratives.share, { narrativeId: id });
    const n = (await t.run(async (ctx) => ctx.db.get(id)))!;
    expect(n.status).toBe("shared");
  });

  test("a published report takes clean corrections but never a placeholder or an empty body", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Science" });
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "Ada explored volcanoes." });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: id, done: true });
    await asA.mutation(api.courseNarratives.share, { narrativeId: id });
    await expect(
      asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "Edited [later]." }),
    ).rejects.toThrow(/Parents can already see this report/);
    await expect(
      asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: " " }),
    ).rejects.toThrow(/Write the report/);
    const bot = await t.mutation(internal.courseNarratives.setSectionInternal, { narrativeId: id, key: "report", body: "Bot [text]" });
    expect(bot.written).toBe(false);
    const body = () => t.run(async (ctx) => (await ctx.db.get(id))!.sections.find((s) => s.key === "report")!.body);
    expect(await body()).toBe("Ada explored volcanoes.");
    // A clean correction still lands, as it did before the prose form.
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "Ada explored volcanoes and lava flows." });
    expect(await body()).toBe("Ada explored volcanoes and lava flows.");
  });

  test("a fresh draft on a report marked done goes back to draft", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Science" });
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "Old text." });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: id, done: true });
    const requestedAt = Date.now();
    await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
    await t.mutation(internal.parentReports.saveDraft, { narrativeId: id, requestedAt, body: "A clean draft nobody has read." });
    expect((await t.run(async (ctx) => ctx.db.get(id)))!.status).toBe("draft");
    expect(await asA.mutation(api.courseNarratives.sharePeriod, { periodId })).toEqual({ shared: 0, held: 0 });
  });

  test("subject spellings fold to one report", async () => {
    const { world, a, scholarId, periodId } = await setup();
    const asA = await world.as.staffOf(a);
    const math = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Mathematics" });
    expect(await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" })).toBe(math);
    const sel = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "SEL" });
    expect(await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Social-emotional learning" })).toBe(sel);
  });

  test("draft-all opens every derived subject and schedules only empty ones", async () => {
    const { world, a, scholarId, periodId, t } = await setup();
    const asA = await world.as.staffOf(a);
    const sci = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Science" });
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: sci, key: "report", body: "Already written." });
    const res = await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect(res.scheduled).toBe(3); // Humanities, Math, SEL
    const rows = await t.run(async (ctx) =>
      ctx.db.query("courseNarratives").withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", periodId)).collect(),
    );
    expect(rows.map((r) => r.subject).sort()).toEqual(["Humanities", "Math", "SEL", "Science"]);
    expect(rows.find((r) => r.subject === "Science")!.draftRequestedAt).toBeUndefined();
    expect(rows.filter((r) => r.draftRequestedAt !== undefined)).toHaveLength(3);
  });

  test("another school's teacher can't read or draft a scholar's report", async () => {
    const { world, a, b, scholarId, periodId } = await setup();
    const asA = await world.as.staffOf(a);
    const asB = await world.as.staffOf(b);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "SEL" });
    await expect(asB.query(api.parentReports.evidence, { narrativeId: id as Id<"courseNarratives"> })).rejects.toThrow();
    await expect(asB.mutation(api.parentReports.requestDraft, { narrativeId: id })).rejects.toThrow();
    await expect(asB.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rejects.toThrow();
  });
});

describe("report buckets by class (pure partition)", () => {
  const cls = (subject: string, kind?: "enrichment") => ({
    subject,
    subjectKey: subjectKey(subject),
    kind,
  });
  const index = [cls("Math"), cls("Humanities"), cls("Science"), cls("Art"), cls("Robotics", "enrichment")];

  test("a staff unit goes to the class with the same folded subject", () => {
    expect(reportBucketForUnit({ subject: "Mathematics" }, index)).toBe("Math");
    expect(reportBucketForUnit({ subject: " humanities " }, index)).toBe("Humanities");
  });

  test("two groups sharing a class name are one entry", () => {
    const shared = [cls("Math"), cls("Math"), cls("Humanities")];
    expect(reportBucketForUnit({ subject: "Math" }, shared)).toBe("Math");
  });

  test("the meaning-matcher files Social Studies under the only fitting class", () => {
    expect(reportBucketForUnit({ subject: "Social Studies" }, index)).toBe("Humanities");
  });

  test("a subject fitting two classes is enrichment", () => {
    expect(reportBucketForUnit({ subject: "Science & Art" }, index)).toBe(ENRICHMENT_SUBJECT);
  });

  test("a class marked enrichment sends its units to enrichment", () => {
    expect(reportBucketForUnit({ subject: "Robotics" }, index)).toBe(ENRICHMENT_SUBJECT);
  });

  test("scholar-made, blank, and unmatched subjects are enrichment", () => {
    expect(reportBucketForUnit({ subject: "Math", authorScholarId: "u1" }, index)).toBe(
      ENRICHMENT_SUBJECT,
    );
    expect(reportBucketForUnit({ subject: "   " }, index)).toBe(ENRICHMENT_SUBJECT);
    expect(reportBucketForUnit({}, index)).toBe(ENRICHMENT_SUBJECT);
    expect(reportBucketForUnit({ subject: "Gardening" }, index)).toBe(ENRICHMENT_SUBJECT);
    expect(reportBucketForUnit({ subject: "Math" }, [])).toBe(ENRICHMENT_SUBJECT);
  });

  test("a class can never be bucketed under the reserved subject", () => {
    const rogue = [cls(ENRICHMENT_SUBJECT)];
    expect(reportBucketForUnit({ subject: ENRICHMENT_SUBJECT }, rogue)).toBe(ENRICHMENT_SUBJECT);
  });

  test("every unit lands in exactly one bucket: a class name or enrichment", () => {
    const names = new Set(index.map((c) => c.subject));
    for (const subject of ["Math", "Social Studies", "Science & Art", "Robotics", "", "Zzz"]) {
      const b = reportBucketForUnit({ subject }, index);
      expect(typeof b).toBe("string");
      expect(b === ENRICHMENT_SUBJECT || names.has(b)).toBe(true);
    }
  });

  test("enrichmentListBody lists titles by first session with no status words", () => {
    const body = enrichmentListBody([
      { title: "Kite Lab", firstSessionAt: 30 },
      { title: "Tide Pools", firstSessionAt: 10 },
      { title: "  ", firstSessionAt: 5 },
      { title: "Comics", firstSessionAt: 20 },
    ]);
    expect(body).toBe("- Tide Pools\n- Comics\n- Kite Lab");
    expect(body).not.toMatch(/done|late|incomplete/i);
    expect(enrichmentListBody([])).toBe("");
  });

  test("one class name spelled two ways gives one bucket, from either path", () => {
    const rows = [cls("math"), cls("Math"), cls("Humanities")];
    expect(reportBucketForUnit({ subject: "Math" }, rows)).toBe("math");
    expect(reportBucketForUnit({ subject: "Mathematics" }, rows)).toBe("math");
    expect(reportBucketForUnit({ subject: "Maths Workshop" }, rows)).toBe("math");
    const reversed = [cls("Math"), cls("math")];
    expect(reportBucketForUnit({ subject: "Maths Workshop" }, reversed)).toBe("Math");
  });

  test("a title with brackets or newlines gives a body that can be published", () => {
    const body = enrichmentListBody([
      { title: "Fractions [Part 2]", firstSessionAt: 1 },
      { title: "Tide\n  pools\t lab", firstSessionAt: 2 },
    ]);
    expect(body).toBe("- Fractions (Part 2)\n- Tide pools lab");
    expect(
      publishBlocker([{ key: "report", title: "Report", body }]),
    ).toBeNull();
  });

  test("a class folding to the SEL key is not a class bucket", () => {
    const rows = [cls("SEL"), cls("Social Emotional Learning"), cls("Math")];
    expect(reportBucketForUnit({ subject: "SEL" }, rows)).toBe(ENRICHMENT_SUBJECT);
    expect(reportBucketForUnit({ subject: "Social-Emotional Learning" }, rows)).toBe(
      ENRICHMENT_SUBJECT,
    );
    expect(reportBucketForUnit({ subject: "Math" }, rows)).toBe("Math");
    for (const subject of ["SEL", "Math", "Art"]) {
      expect(reportBucketForUnit({ subject }, rows)).not.toBe("SEL");
    }
  });

  test("a name is an enrichment class only when every row for it is marked", () => {
    const mixed = [cls("Robotics", "enrichment"), cls("Robotics"), cls("Math")];
    expect(reportBucketForUnit({ subject: "Robotics" }, mixed)).toBe("Robotics");
    const all = [cls("Robotics", "enrichment"), cls("robotics", "enrichment")];
    expect(reportBucketForUnit({ subject: "Robotics" }, all)).toBe(ENRICHMENT_SUBJECT);
    // The mixed class still takes part in the meaning match.
    const stale = [cls("Science", "enrichment"), cls("Science"), cls("Humanities")];
    expect(reportBucketForUnit({ subject: "Biology" }, stale)).toBe("Science");
  });

  test("Math beside Math Workshop: an exact name wins, an ambiguous fit is enrichment", () => {
    const rows = [cls("Math"), cls("Math Workshop")];
    expect(reportBucketForUnit({ subject: "Math" }, rows)).toBe("Math");
    expect(reportBucketForUnit({ subject: "Math Workshop" }, rows)).toBe("Math Workshop");
    // Fits both by meaning and equals neither by name: no guess, so enrichment.
    expect(reportBucketForUnit({ subject: "Mathematics Workshop" }, rows)).toBe(
      ENRICHMENT_SUBJECT,
    );
    // With only Math on the list the same unit fits one class and files there.
    expect(reportBucketForUnit({ subject: "Mathematics Workshop" }, [cls("Math")])).toBe("Math");
  });
});

describe("which class gets practice evidence, and which classes always get a row (pure)", () => {
  const cls = (subject: string, kind?: "enrichment") => ({ subject, subjectKey: subjectKey(subject), kind });

  test("math goes to one of the scholar's own classes: the one named Math, else the first by name, else none", () => {
    expect(mathReportClass([cls("Math Workshop"), cls("Math"), cls("Maths Lab")])).toBe("Math");
    expect(mathReportClass([cls("Maths Lab"), cls("Math Workshop")])).toBe("Math Workshop");
    expect(mathReportClass([cls("Science"), cls("Math", "enrichment")])).toBeNull();
    expect(mathReportClass([])).toBeNull();
  });

  test("a report row pairs with one of the scholar's classes by name, else by the one meaning that fits", () => {
    const own = [cls("Math"), cls("Humanities"), cls("Science"), cls("Art")];
    expect(classForReportSubject("Mathematics", own)).toBe("Math");
    expect(classForReportSubject("Social Studies", own)).toBe("Humanities");
    expect(classForReportSubject("Science & Art", own)).toBeNull();
    expect(classForReportSubject("Gardening", own)).toBeNull();
    expect(classForReportSubject("SEL", own)).toBeNull();
  });

  test("only a homeroom the scholar belongs to puts a class on their timetable", () => {
    expect(classAlwaysReported({ scholarIds: ["s1"] }, "s1")).toBe(true);
    expect(classAlwaysReported({ type: "primary", scholarIds: ["s1"] }, "s1")).toBe(true);
    expect(classAlwaysReported({ type: "robotics", scholarIds: ["s1"] }, "s1")).toBe(false);
    expect(classAlwaysReported({ scholarIds: ["s2"] }, "s1")).toBe(false);
  });
});

/**
 * Reports by class (TRA-723): a school whose term has classes on record.
 * Homeroom: Math, Math Workshop, Humanities, Science, Art, and Makerspace
 * marked enrichment. An elective group: Robotics and Photography. Another
 * homeroom the scholar is not in: Spanish. Another school: Latin.
 */
async function setupClasses(opts: { inHomeroom?: boolean; parents?: boolean } = {}) {
  const t = convexTest(schema, modules);
  // The school's people exist well before the term, so the pace window is
  // the whole term (it starts no earlier than a scholar's account).
  const world = await atClock(Date.now() - 365 * DAY, () => makeWorld(t, { schools: 2, scholarsPerSchool: 1, parentsPerSchool: opts.parents ? 1 : 0 }));
  const [a, b] = world.schools;
  const scholarId = a.scholars[0].id;
  const teacherId = a.teacher.id;
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026", startsAt: now - 30 * DAY, endsAt: now + 10 * DAY, status: "writing", institutionId: a.id,
    });
    const priorPeriodId = await ctx.db.insert("reportingPeriods", {
      label: "Spring 2026", startsAt: now - 200 * DAY, endsAt: now - 60 * DAY, status: "closed", institutionId: a.id,
    });
    const group = (name: string, scholarIds: Id<"users">[], type?: string) =>
      ctx.db.insert("scholarGroups", { institutionId: a.id, teacherId, name, scholarIds, ...(type ? { type } : {}) });
    const homeroom = await group("Geckos", opts.inHomeroom === false ? [] : [scholarId]);
    const elective = await group("Robotics club", [scholarId], "robotics");
    const otherHomeroom = await group("Owls", []);
    const cls = (groupId: Id<"scholarGroups">, subject: string, kind?: "enrichment", institutionId = a.id) =>
      ctx.db.insert("classes", {
        institutionId, periodId, groupId, subject, subjectKey: subject.trim().toLowerCase(), meetings: [],
        ...(kind ? { kind } : {}),
      });
    for (const s of ["Math", "Math Workshop", "Humanities", "Science", "Art"]) await cls(homeroom, s);
    await cls(homeroom, "Makerspace", "enrichment");
    await cls(elective, "Robotics");
    await cls(elective, "Photography");
    await cls(otherHomeroom, "Spanish");
    // Another school's class on this term must never reach a report.
    await cls(homeroom, "Latin", undefined, b.id);

    const unit = (title: string, subject?: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("units", { teacherId, title, isActive: true, ...(subject !== undefined ? { subject } : {}), ...extra });
    const units = {
      math: await unit("Fractions", "Mathematics"),
      humanities: await unit("Voyaging", "Social Studies"),
      photography: await unit("Pinhole cameras", "Photography"),
      makerspace: await unit("Circuits", "Makerspace"),
      scholarMade: await unit("My dice game", "Math", { authorScholarId: scholarId }),
      noSubject: await unit("Free exploration"),
      twoFit: await unit("Color and light", "Science & Art"),
      otherSchool: await unit("Their fractions", "Math", { institutionId: b.id }),
      latin: await unit("Roman roads", "Latin"),
    };
    const sessions: Record<string, Id<"sessions">> = {};
    for (const [k, unitId] of Object.entries(units))
      sessions[k] = await ctx.db.insert("sessions", { userId: scholarId, unitId, title: k, isArchived: false });
    const mastery = (sessionId: Id<"sessions">, summary: string) =>
      ctx.db.insert("masteryObservations", {
        scholarId, conceptLabel: summary, domain: "math", observedAt: now - DAY, sessionId,
        evidenceType: "explanation", evidenceSummary: summary, isSuperseded: false,
        transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
      });
    await mastery(sessions.math, "Explained equivalent fractions");
    await mastery(sessions.scholarMade, "Designed a dice game");
    await mastery(sessions.makerspace, "Soldered a circuit");
    await ctx.db.insert("knowledgeNodes", { nodeKey: "plot_points_q1", label: "Plot points in the first quadrant", domain: "integers-coordinates", grade: "5" });
    await ctx.db.insert("practiceMastery", {
      scholarId, skillKey: "plot_points_q1", domain: "integers-coordinates", repetition: 4, halfLifeDays: 10,
      lastPracticedAt: now - DAY, frontier: false, updatedAt: now, source: "practice", becameFluentAt: now - 2 * DAY,
    });
    // Last spring's report was for "Math Workshop".
    await ctx.db.insert("courseNarratives", {
      scholarId, teacherId, periodId: priorPeriodId, subject: "Math Workshop", unitIds: [], goalIds: [], status: "shared",
      sections: [{ key: "report", title: "Report", body: "Next term we will work on long division." }],
    });
    return { periodId, units };
  });
  const asA = await world.as.staffOf(a);
  const rows = () =>
    t.run((ctx) =>
      ctx.db
        .query("courseNarratives")
        .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", ids.periodId))
        .collect(),
    );
  return { t, world, a, b, asA, scholarId, teacherId, rows, ...ids };
}

describe("parent reports grouped by class", () => {
  test("work in a teacher's unit with no subject is placed by its own subject; a scholar's own unit stays out", async () => {
    const { t, asA, scholarId, periodId, units } = await setupClasses();
    await t.run(async (ctx) => {
      const session = (await ctx.db.query("sessions").collect()).find((x) => x.unitId === units.noSubject)!;
      const base = {
        scholarId, observedAt: Date.now() - DAY, evidenceType: "explanation" as const, isSuperseded: false,
        transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session" as const, studentInitiated: false,
      };
      // A multiplication app in a subject-less unit: its observation names the subject.
      await ctx.db.insert("masteryObservations", {
        ...base, sessionId: session._id, conceptLabel: "Area model", domain: "Mathematics", evidenceSummary: "Used an area model for 26 x 18",
      });
      const page = await ctx.db.insert("portfolioItems", {
        scholarId, title: "scan", label: "Times tables page", source: "upload", matchStatus: "confirmed",
        assignmentStatus: "confirmed", processingStatus: "ready",
        activityId: await ctx.db.insert("activities", {
          lessonId: await ctx.db.insert("lessons", { unitId: units.noSubject, title: "L", order: 0 }),
          title: "Times tables", kind: "offline", order: 0,
        }),
      });
      await ctx.db.insert("masteryObservations", {
        ...base, portfolioItemId: page, conceptLabel: "Times tables", domain: "whole-number-arithmetic", evidenceSummary: "Wrote the 7s table",
      });
      // The practice engine tags by math area, with no session.
      await ctx.db.insert("masteryObservations", {
        ...base, conceptLabel: "Ordering fractions", domain: "fraction-arithmetic", evidenceSummary: "Ordered five fractions by size",
      });
    });
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    const understood = e.groups.find((g) => g.key === "understanding")?.items.join("\n") ?? "";
    expect(understood).toMatch(/area model for 26 x 18/);
    expect(understood).toMatch(/Ordered five fractions/);
    expect(understood).not.toMatch(/dice game/);
    // A scanned page in that unit goes where its observed skills point too.
    expect(e.pieces.map((p) => p.title)).toContain("Times tables page");
    // The unit itself still lists as enrichment, not as a Math unit.
    expect(e.groups.find((g) => g.key === "units")?.items.join("\n") ?? "").not.toMatch(/Free exploration/);
  });

  test("every homeroom class gets a row, an elective class only with work, nothing for enrichment or another school", async () => {
    const { asA, scholarId, periodId } = await setupClasses();
    const subjects = (await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rows.map((r) => r.subject);
    expect(subjects).toEqual(["Art", "Humanities", "Math", "Math Workshop", "Photography", "Science", "SEL", ENRICHMENT_SUBJECT]);
  });

  test("a scholar with no homeroom gets reports only for classes with work", async () => {
    const { asA, scholarId, periodId } = await setupClasses({ inHomeroom: false });
    const subjects = (await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rows.map((r) => r.subject);
    // Only Robotics and Photography are theirs: the other units go to
    // enrichment, and practice keeps the old "Math" report, since none of
    // their own classes is math (never another group's class).
    expect(subjects).toEqual(["Math", "Photography", "SEL", ENRICHMENT_SUBJECT]);
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    expect(e.groups.find((g) => g.key === "fluency")?.items.join("\n")).toMatch(/Plot points/);
  });

  test("no unit lands in two reports, and enrichment, scholar-made, two-fit and other-school units land in none", async () => {
    const { t, asA, scholarId, periodId, units } = await setupClasses();
    const subjects = (await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rows.map((r) => r.subject);
    const byReport = await t.run(async (ctx) => {
      const out: Record<string, string[]> = {};
      for (const s of subjects) out[s] = (await deriveUnitIds(ctx, scholarId, periodId, s)).map(String);
      return out;
    });
    const all = Object.values(byReport).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(byReport.Math).toEqual([String(units.math)]);
    expect(byReport.Humanities).toEqual([String(units.humanities)]);
    expect(byReport.Photography).toEqual([String(units.photography)]);
    expect(byReport.Science).toEqual([]);
    expect(byReport.Art).toEqual([]);
    for (const k of ["makerspace", "scholarMade", "noSubject", "twoFit", "otherSchool", "latin"] as const)
      expect(all).not.toContain(String(units[k]));
  });

  test("math practice and session evidence go to one class, and enrichment work stays out", async () => {
    const { asA, scholarId, periodId } = await setupClasses();
    const evidence = async (subject: string) => {
      const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject });
      return (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    };
    const math = await evidence("Math");
    const mathText = math.groups.flatMap((g) => g.items).join("\n");
    expect(math.groups.find((g) => g.key === "fluency")?.items.join("\n")).toMatch(/Plot points/);
    expect(mathText).toMatch(/equivalent fractions/);
    expect(mathText).not.toMatch(/dice game|circuit/);
    const workshop = await evidence("Math Workshop");
    expect(workshop.groups.find((g) => g.key === "fluency")).toBeUndefined();
    expect(workshop.groups.flatMap((g) => g.items).join("\n")).not.toMatch(/Plot points|equivalent fractions|dice game|circuit/);
  });

  test("last term's Math Workshop report connects to this term's Math class", async () => {
    const { asA, scholarId, periodId } = await setupClasses();
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    expect(e.groups.find((g) => g.key === "prior")?.items).toEqual(["Next term we will work on long division."]);
  });

  test("draft all leaves a shared report alone, reuses an unshared one, and twice creates nothing new", async () => {
    const { t, asA, scholarId, periodId, teacherId, rows } = await setupClasses();
    await t.run(async (ctx) => {
      const base = { scholarId, teacherId, periodId, unitIds: [], goalIds: [] };
      await ctx.db.insert("courseNarratives", {
        ...base, subject: "Humanities", status: "shared", sharedAt: Date.now(),
        sections: [{ key: "report", title: "Report", body: "Already with parents." }],
      });
      await ctx.db.insert("courseNarratives", {
        ...base, subject: "math", status: "draft", sections: [{ key: "report", title: "Report", body: "" }],
      });
    });
    const first = await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    const after = await rows();
    // Art, Science and Math Workshop have no work this term: no report is
    // opened for them and nothing is sent to the model. The unshared "math"
    // row is reused for Math and takes the class's name when drafted.
    expect(after.map((r) => r.subject).sort()).toEqual(["Humanities", "Math", "Photography", "SEL"]);
    const humanities = after.find((r) => r.subject === "Humanities")!;
    expect(humanities.status).toBe("shared");
    expect(humanities.draftRequestedAt).toBeUndefined();
    expect(humanities.sections[0].body).toBe("Already with parents.");
    expect(after.find((r) => r.subject === "Math")!.draftRequestedAt).toBeTypeOf("number");
    expect(first.scheduled).toBe(3); // Math, Photography, SEL
    expect(after.find((r) => r.subject === "Photography")!.draftRequestedAt).toBeTypeOf("number");
    expect(after.find((r) => r.subject === "SEL")!.draftRequestedAt).toBeTypeOf("number");
    // A shared report can't be redrafted by hand either.
    await expect(asA.mutation(api.parentReports.requestDraft, { narrativeId: humanities._id })).rejects.toThrow(/published/);

    const second = await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect(second.scheduled).toBe(0);
    expect((await rows()).length).toBe(after.length);
  });

  test("requesting a draft of a class with no work refuses in plain words and calls no model", async () => {
    const { t, asA, scholarId, periodId } = await setupClasses();
    const art = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Art" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: art }))!;
    expect(e.classWithoutWork).toBe(true);
    const err = await asA.mutation(api.parentReports.requestDraft, { narrativeId: art }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<string>).data).toBe(NO_CLASS_WORK_REFUSAL);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(art)))!.draftRequestedAt).toBeUndefined();
    // The teacher can still write it by hand.
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: art, key: "report", body: "We painted murals." });

    // A class with work, and SEL, still draft.
    for (const subject of ["Photography", "SEL"]) {
      const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject });
      expect((await asA.query(api.parentReports.evidence, { narrativeId: id }))!.classWithoutWork).toBe(false);
      await asA.mutation(api.parentReports.requestDraft, { narrativeId: id });
    }
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(2);
  });

  test("each row says whether it has evidence, and the rows with it are exactly what draft all schedules", async () => {
    const { asA, scholarId, periodId } = await setupClasses();
    // A no-work elective class a teacher opened through the picker is that
    // class's row, with no evidence, so it isn't counted either.
    await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Robotics" });
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.recentOnly).toBe(false);
    expect(list.rows.map(({ subject, hasEvidence, autoDraft }) => ({ subject, hasEvidence, autoDraft }))).toEqual([
      { subject: "Art", hasEvidence: false, autoDraft: true },
      { subject: "Humanities", hasEvidence: true, autoDraft: true },
      { subject: "Math", hasEvidence: true, autoDraft: true },
      { subject: "Math Workshop", hasEvidence: false, autoDraft: true },
      { subject: "Photography", hasEvidence: true, autoDraft: true },
      { subject: "Robotics", hasEvidence: false, autoDraft: true },
      { subject: "Science", hasEvidence: false, autoDraft: true },
      { subject: "SEL", hasEvidence: true, autoDraft: true },
      // Nothing worked in two sessions with a message: nothing to list.
      { subject: ENRICHMENT_SUBJECT, hasEvidence: false, autoDraft: true },
    ]);
    const res = await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect(res.scheduled).toBe(list.rows.filter((r) => r.autoDraft && r.hasEvidence).length);
  });

  test("a refused draft by name opens no report; an accepted one opens and drafts it", async () => {
    const { t, asA, scholarId, periodId, rows } = await setupClasses();
    const err = await asA
      .mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: "Art" })
      .catch((x: unknown) => x);
    expect((err as ConvexError<string>).data).toBe(NO_CLASS_WORK_REFUSAL);
    expect(await rows()).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);

    const id = await asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: "Photography" });
    const after = await rows();
    expect(after.map((r) => r._id)).toEqual([id]);
    expect(after[0].draftRequestedAt).toBeTypeOf("number");
    // Asking again by name reuses the same report.
    await t.run((ctx) => ctx.db.patch(id, { draftRequestedAt: undefined }));
    expect(await asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: "photography" })).toBe(id);
    expect(await rows()).toHaveLength(1);
  });

  test("the math class with only practice fluency still drafts", async () => {
    const { t, asA, scholarId, periodId, units } = await setupClasses({ inHomeroom: true });
    // Remove the math unit's session: practice fluency is the only math work left.
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("sessions").collect()) if (s.unitId === units.math) await ctx.db.delete(s._id);
    });
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    expect((await asA.query(api.parentReports.evidence, { narrativeId: id }))!.classWithoutWork).toBe(false);
    await asA.mutation(api.parentReports.requestDraft, { narrativeId: id });
  });

  test("a draft landing on a shared report keeps what parents have", async () => {
    const { t, scholarId, periodId, teacherId } = await setupClasses();
    const requestedAt = Date.now();
    const id = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        scholarId, teacherId, periodId, unitIds: [], goalIds: [], subject: "Art", status: "shared",
        draftRequestedAt: requestedAt, sections: [{ key: "report", title: "Report", body: "Shared text." }],
      }),
    );
    await t.mutation(internal.parentReports.saveDraft, { narrativeId: id, requestedAt, body: "New draft." });
    const n = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(n.sections[0].body).toBe("Shared text.");
    expect(n.status).toBe("shared");
  });

  test("a shared Mathematics report is the Math class's report: no sibling, never touched", async () => {
    const { t, asA, scholarId, periodId, teacherId, rows } = await setupClasses();
    const shared = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        scholarId, teacherId, periodId, unitIds: [], goalIds: [], subject: "Mathematics", status: "shared",
        sharedAt: 1, sections: [{ key: "report", title: "Report", body: "Shared math." }],
      }),
    );
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    const math = list.rows.filter((r) => r.subject === "Math" || r.narrativeId === shared);
    expect(math).toEqual([{ subject: "Math", narrativeId: shared, autoDraft: true, hasEvidence: true, leftover: false }]);
    for (let i = 0; i < 2; i++) await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    const after = await rows();
    expect(after.filter((r) => r.subject === "Math" || r.subject === "Mathematics")).toHaveLength(1);
    const row = (await t.run((ctx) => ctx.db.get(shared)))!;
    expect(row.subject).toBe("Mathematics");
    expect(row.sections[0].body).toBe("Shared math.");
    expect(row.draftRequestedAt).toBeUndefined();
    // Opening "Math" opens the shared report, not a new one.
    expect(await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" })).toBe(shared);
  });

  test("an unshared Social Studies report is reused for Humanities, with its evidence and its name", async () => {
    const { t, asA, scholarId, periodId, teacherId, rows } = await setupClasses();
    const old = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        scholarId, teacherId, periodId, unitIds: [], goalIds: [], subject: "Social Studies", status: "draft",
        sections: [{ key: "report", title: "Report", body: "" }],
      }),
    );
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: old }))!;
    expect(e.groups.find((g) => g.key === "units")?.items).toEqual(["Voyaging"]);
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.filter((r) => r.narrativeId === old || r.subject === "Humanities")).toEqual([
      { subject: "Humanities", narrativeId: old, autoDraft: true, hasEvidence: true, leftover: false },
    ]);
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    const count = (await rows()).length;
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect((await rows()).length).toBe(count);
    const humanities = (await rows()).filter((r) => r.subject === "Humanities" || r.subject === "Social Studies");
    expect(humanities.map((r) => [r._id, r.subject])).toEqual([[old, "Humanities"]]);
  });

  test("a report name that is none of the scholar's classes stays listed and is never drafted by draft all", async () => {
    const { t, asA, scholarId, periodId, teacherId } = await setupClasses();
    const typed = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        scholarId, teacherId, periodId, unitIds: [], goalIds: [], subject: "Gardening", status: "draft",
        sections: [{ key: "report", title: "Report", body: "" }],
      }),
    );
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.at(-2)).toEqual({ subject: "Gardening", narrativeId: typed, autoDraft: false, hasEvidence: true, leftover: false });
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect((await t.run((ctx) => ctx.db.get(typed)))!.draftRequestedAt).toBeUndefined();
  });

  test("writing a report by hand creates the row and its text in one call", async () => {
    const { t, asA, scholarId, periodId, teacherId, rows } = await setupClasses();
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Art", body: "We painted murals." });
    const [row] = await rows();
    expect(row._id).toBe(id);
    expect(row.sections[0].body).toBe("We painted murals.");
    // A refused save leaves nothing: writing by hand never lands on a class
    // whose report parents already have, and creates no sibling for it.
    await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        scholarId, teacherId, periodId, unitIds: [], goalIds: [], subject: "Science", status: "shared",
        sharedAt: 1, sections: [{ key: "report", title: "Report", body: "Shared." }],
      }),
    );
    const before = (await rows()).length;
    const err = await asA
      .mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Science", body: "New text." })
      .catch((x: unknown) => x);
    expect((err as ConvexError<string>).data).toBe("This class already has a shared report.");
    expect((await rows()).length).toBe(before);
    expect((await rows()).find((r) => r.subject === "Science")!.sections[0].body).toBe("Shared.");
  });

  test("the add-report picker offers the scholar's own ordinary classes only", async () => {
    const { asA, scholarId, periodId } = await setupClasses();
    expect(await asA.query(api.parentReports.classesForScholarPeriod, { scholarId, periodId })).toEqual([
      "Art", "Humanities", "Math", "Math Workshop", "Photography", "Robotics", "Science",
    ]);
  });
});

describe("parent reports by class: one report per class", () => {
  /** A shared "Mathematics" report and a newer unshared "Math" one, both the Math class's. */
  async function sharedPlusSibling() {
    const s = await setupClasses();
    const base = { scholarId: s.scholarId, teacherId: s.teacherId, periodId: s.periodId, unitIds: [], goalIds: [] };
    const shared = await s.t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        ...base, subject: "Mathematics", status: "shared", sharedAt: 1,
        sections: [{ key: "report", title: "Report", body: "Shared math." }],
      }),
    );
    const sibling = await s.t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        ...base, subject: "Math", status: "draft", sections: [{ key: "report", title: "Report", body: "" }],
      }),
    );
    return { ...s, shared, sibling };
  }
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as ConvexError<string>).data);

  test("a class with a shared report refuses every way of drafting or writing a sibling", async () => {
    const { t, asA, scholarId, periodId, teacherId, shared, sibling, rows } = await sharedPlusSibling();
    const before = (await rows()).length;
    expect(await refusal(asA.mutation(api.parentReports.requestDraft, { narrativeId: sibling }))).toBe(
      "This class already has a shared report.",
    );
    expect(await refusal(asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: "Math" }))).toBe(
      "This class already has a shared report.",
    );
    expect(await refusal(asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math", body: "x" }))).toBe(
      "This class already has a shared report.",
    );
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    // The aide opens the shared report, and can't write the sibling.
    expect(
      await t.mutation(internal.courseNarratives.openInternal, { scholarId, teacherId, periodId, subject: "Math" }),
    ).toBe(shared);
    const bot = await t.mutation(internal.courseNarratives.setSectionInternal, { narrativeId: sibling, key: "report", body: "Bot text." });
    expect(bot).toEqual({ written: false, reason: "This class already has a shared report." });
    const after = await rows();
    // Draft all opened Humanities, Photography and SEL, and nothing for Math.
    expect(after.length).toBe(before + 3);
    const s = after.find((r) => r._id === sibling)!;
    expect([s.subject, s.draftRequestedAt, s.sections[0].body]).toEqual(["Math", undefined, ""]);
    const sh = after.find((r) => r._id === shared)!;
    expect([sh.subject, sh.status, sh.sections[0].body]).toEqual(["Mathematics", "shared", "Shared math."]);
    // The composer offers no draft on the sibling and says why.
    expect((await asA.query(api.parentReports.evidence, { narrativeId: sibling }))!.draftBlocked).toBe(
      "This class already has a shared report.",
    );
    // The page lists the shared one as Math's report and the sibling as a leftover.
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.find((r) => r.subject === "Math")!.narrativeId).toBe(shared);
    expect(list.rows.find((r) => r.narrativeId === sibling)!.autoDraft).toBe(false);
  });

  test("among unshared rows the one with text is the report; the other is never drafted or renamed", async () => {
    const { t, asA, scholarId, periodId, teacherId } = await setupClasses();
    const base = { scholarId, teacherId, periodId, unitIds: [], goalIds: [], status: "draft" as const };
    const written = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", { ...base, subject: "Social Studies", sections: [{ key: "report", title: "Report", body: "Started." }] }),
    );
    const empty = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", { ...base, subject: "Humanities ", sections: [{ key: "report", title: "Report", body: "" }] }),
    );
    expect(await refusal(asA.mutation(api.parentReports.requestDraft, { narrativeId: empty }))).toBe(
      "This class already has another report. Draft or edit that one instead.",
    );
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    const e = (await t.run((ctx) => ctx.db.get(empty)))!;
    expect(e.subject).toBe("Humanities ");
    expect(e.draftRequestedAt).toBeUndefined();
    // The written one is the slot's report: saving it gives it the class's name.
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: written, key: "report", body: "Started, more." });
    expect((await t.run((ctx) => ctx.db.get(written)))!.subject).toBe("Humanities");
    // The aide writes only to the slot's report.
    const bot = await t.mutation(internal.courseNarratives.setSectionInternal, { narrativeId: empty, key: "report", body: "Bot." });
    expect(bot.written).toBe(false);
  });

  test("a connection tagged with a class's name doesn't give that empty class work", async () => {
    const { t, asA, scholarId, periodId, units } = await setupClasses();
    await t.run(async (ctx) => {
      const mathSession = (await ctx.db.query("sessions").collect()).find((s) => s.unitId === units.math)!;
      await ctx.db.insert("crossDomainConnections", {
        scholarId, sessionId: mathSession._id, domains: ["art", "math"], conceptLabels: ["symmetry"],
        description: "Saw symmetry in a painting", studentInitiated: true,
      });
    });
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.find((r) => r.subject === "Art")!.hasEvidence).toBe(false);
    const art = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Art" });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: art }))!;
    expect(e.groups.flatMap((g) => g.items).join("\n")).not.toMatch(/symmetry/);
    const math = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Math" });
    const m = (await asA.query(api.parentReports.evidence, { narrativeId: math }))!;
    expect(m.groups.find((g) => g.key === "connections")!.items.join("\n")).toMatch(/symmetry/);
  });

  test("a second report of a class with a shared one can be typed in but is never shared", async () => {
    const { t, asA, scholarId, periodId, sibling, shared } = await sharedPlusSibling();
    // Typing into it still saves, so nothing a teacher writes is lost.
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: sibling, key: "report", body: "Typed anyway." });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: sibling, done: true });
    expect(await refusal(asA.mutation(api.courseNarratives.share, { narrativeId: sibling }))).toBe(
      "This class already has a report. Share that one, or delete it first.",
    );
    const roster = await asA.query(api.courseNarratives.listForPeriod, { periodId });
    expect(roster.find((r) => r._id === sibling)!.leftover).toBe(true);
    expect(roster.find((r) => r._id === shared)!.leftover).toBe(false);
    expect(await asA.mutation(api.courseNarratives.sharePeriod, { periodId })).toEqual({ shared: 0, held: 0 });
    expect((await t.run((ctx) => ctx.db.get(sibling)))!.status).toBe("final");
    const page = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(page.rows.find((r) => r.narrativeId === sibling)!.leftover).toBe(true);

    // Two reports shared before this change: the older is the class's report,
    // the newer is still listed as a second one (the page tells the teacher
    // parents see both) and stays shared, untouched.
    await t.run((ctx) => ctx.db.patch(sibling, { status: "shared", sharedAt: 2 }));
    const again = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(again.rows.find((r) => r.subject === "Math")!.narrativeId).toBe(shared);
    expect(again.rows.find((r) => r.narrativeId === sibling)!.leftover).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(sibling)))!.status).toBe("shared");
  });

  test("of two unshared reports with text only the older one shares, even after the newer is edited", async () => {
    const { t, asA, scholarId, periodId, teacherId } = await setupClasses();
    const base = { scholarId, teacherId, periodId, unitIds: [], goalIds: [], status: "final" as const };
    const older = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", { ...base, subject: "Social Studies", sections: [{ key: "report", title: "Report", body: "First." }] }),
    );
    const newer = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", { ...base, subject: "Humanities", sections: [{ key: "report", title: "Report", body: "Second." }] }),
    );
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: newer, key: "report", body: "Second, edited." });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: newer, done: true });
    expect(await refusal(asA.mutation(api.courseNarratives.share, { narrativeId: newer }))).toBe(
      "This class already has a report. Share that one, or delete it first.",
    );
    expect(await asA.mutation(api.courseNarratives.sharePeriod, { periodId })).toEqual({ shared: 1, held: 0 });
    const [o, n] = await t.run((ctx) => Promise.all([ctx.db.get(older), ctx.db.get(newer)]));
    expect([o!.status, n!.status]).toEqual(["shared", "final"]);
    // The shared one stays the class's report; the newer one still can't share.
    expect(await refusal(asA.mutation(api.courseNarratives.share, { narrativeId: newer }))).toBe(
      "This class already has a report. Share that one, or delete it first.",
    );
  });

  test("evidence with no session lands in the one class its domain fits, and nowhere when several or none fit", async () => {
    const { t, asA, scholarId, periodId } = await setupClasses();
    await t.run(async (ctx) => {
      const obs = (summary: string, domain: string) =>
        ctx.db.insert("masteryObservations", {
          scholarId, conceptLabel: summary, domain, observedAt: Date.now() - DAY,
          evidenceType: "explanation", evidenceSummary: summary, isSuperseded: false,
          transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
        });
      await obs("Mapped trade routes from a game", "history");
      await obs("Mixed paint and light", "science & art");
    });
    const text = async (subject: string) => {
      const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject });
      return (await asA.query(api.parentReports.evidence, { narrativeId: id }))!.groups.flatMap((g) => g.items).join("\n");
    };
    expect(await text("Humanities")).toMatch(/trade routes/);
    for (const subject of ["Science", "Art", "Math"]) expect(await text(subject)).not.toMatch(/trade routes|paint and light/);
    // Evidence placed this way counts as work: Science, Art stay empty.
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.find((r) => r.subject === "Art")!.hasEvidence).toBe(false);
  });

  test("the aide finds a report by any spelling of its class", async () => {
    const { t, asA, scholarId, periodId } = await setupClasses();
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities", body: "Text." });
    const found = await t.query(internal.courseNarratives.getForBot, { scholarId, periodId, subject: "Social Studies" });
    expect(found.map((r) => r._id)).toEqual([id]);
  });
});

describe("parent reports by class: each scholar's own classes", () => {
  /** Group A teaches "Humanities", group B "Social Studies"; one scholar in each. */
  async function twoGroups() {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, scholarsPerSchool: 2, parentsPerSchool: 0 });
    const [a] = world.schools;
    const [x, y] = a.scholars.map((s) => s.id);
    const teacherId = a.teacher.id;
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026", startsAt: now - 30 * DAY, endsAt: now + 10 * DAY, status: "writing", institutionId: a.id,
      });
      for (const [scholarId, subject] of [[x, "Humanities"], [y, "Social Studies"]] as const) {
        const groupId = await ctx.db.insert("scholarGroups", { institutionId: a.id, teacherId, name: subject, scholarIds: [scholarId] });
        await ctx.db.insert("classes", {
          institutionId: a.id, periodId, groupId, subject, subjectKey: subject.toLowerCase(), meetings: [],
        });
      }
      const units: Id<"units">[] = [];
      for (const [title, subject] of [["Voyaging", "Social Studies"], ["Myths", "Humanities"], ["Castles", "History"]])
        units.push(await ctx.db.insert("units", { teacherId, title, subject, isActive: true }));
      for (const scholarId of [x, y])
        for (const unitId of units) await ctx.db.insert("sessions", { userId: scholarId, unitId, title: "s", isArchived: false });
      return { periodId, units };
    });
    return { t, asA: await world.as.staffOf(a), x, y, ...ids };
  }

  test("a unit files under the scholar's own class of that meaning, in both directions", async () => {
    const { t, asA, x, y, periodId, units } = await twoGroups();
    for (const [scholarId, own] of [[x, "Humanities"], [y, "Social Studies"]] as const) {
      const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
      expect(list.rows.map((r) => r.subject)).toEqual([own, "SEL", ENRICHMENT_SUBJECT]);
      const unitIds = await t.run((ctx) => deriveUnitIds(ctx, scholarId, periodId, own));
      expect(unitIds.map(String).sort()).toEqual(units.map(String).sort());
    }
  });
});

describe("parent reports by class: what counts as work, and the read cap", () => {
  test("a session begun before the term but worked in it gives its class evidence", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, scholarsPerSchool: 1, parentsPerSchool: 0 });
    const [a] = world.schools;
    const scholarId = a.scholars[0].id;
    const { periodId, sessionId } = await t.run(async (ctx) => {
      const now = Date.now();
      // The term starts tomorrow, so the session below was begun before it.
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Spring 2027", startsAt: now + DAY, endsAt: now + 60 * DAY, status: "open", institutionId: a.id,
      });
      const groupId = await ctx.db.insert("scholarGroups", { institutionId: a.id, teacherId: a.teacher.id, name: "Geckos", scholarIds: [scholarId] });
      await ctx.db.insert("classes", { institutionId: a.id, periodId, groupId, subject: "Science", subjectKey: "science", meetings: [] });
      const unitId = await ctx.db.insert("units", { teacherId: a.teacher.id, title: "Rocks", subject: "Science", isActive: true });
      const sessionId = await ctx.db.insert("sessions", { userId: scholarId, unitId, title: "s", isArchived: false });
      return { periodId, sessionId };
    });
    const asA = await world.as.staffOf(a);
    const science = async () =>
      (await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rows.find((r) => r.subject === "Science")!;
    expect((await science()).hasEvidence).toBe(false);
    await t.run((ctx) =>
      ctx.db.insert("masteryObservations", {
        scholarId, conceptLabel: "Layers", domain: "earth science", observedAt: Date.now() + 2 * DAY, sessionId,
        evidenceType: "explanation", evidenceSummary: "Explained rock layers", isSuperseded: false,
        transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
      }),
    );
    expect((await science()).hasEvidence).toBe(true);
    await asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: "Science" });
  });

  test("past the session cap the newest work is kept and the page is told", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, scholarsPerSchool: 1, parentsPerSchool: 0 });
    const [a] = world.schools;
    const scholarId = a.scholars[0].id;
    const { periodId, newest } = await t.run(async (ctx) => {
      const now = Date.now();
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026", startsAt: now - 30 * DAY, endsAt: now + 10 * DAY, status: "writing", institutionId: a.id,
      });
      const old = await ctx.db.insert("units", { teacherId: a.teacher.id, title: "Old", subject: "Geology", isActive: true });
      await ctx.db.insert("sessions", { userId: scholarId, unitId: old, title: "first", isArchived: false });
      for (let i = 0; i < MAX_TERM_SESSIONS; i++)
        await ctx.db.insert("sessions", { userId: scholarId, title: `chat ${i}`, isArchived: false });
      const newest = await ctx.db.insert("units", { teacherId: a.teacher.id, title: "New", subject: "Botany", isActive: true });
      await ctx.db.insert("sessions", { userId: scholarId, unitId: newest, title: "last", isArchived: false });
      return { periodId, newest };
    });
    const asA = await world.as.staffOf(a);
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.recentOnly).toBe(true);
    // No classes on record: the old grouping by unit subject.
    expect(list.rows.map((r) => r.subject)).toEqual(["Botany", "SEL", ENRICHMENT_SUBJECT]);
    expect(await t.run((ctx) => deriveUnitIds(ctx, scholarId, periodId, "Botany"))).toEqual([newest]);
  });
});

describe("enrichment and not-included classes (pure)", () => {
  const cls = (subject: string, opts: { kind?: "enrichment"; includedInReports?: boolean } = {}) => ({
    subject,
    subjectKey: subjectKey(subject),
    ...opts,
  });
  const index = [
    cls("Science"),
    cls("Friday Projects", { kind: "enrichment" }),
    cls("Robotics", { includedInReports: false }),
  ];

  test("a class not included in reports sends its work nowhere; the enrichment block sends it to the row", () => {
    expect(reportBucketForUnit({ subject: "Robotics" }, index)).toBe(NOT_REPORTED_SUBJECT);
    expect(reportBucketForUnit({ subject: "Friday Projects" }, index)).toBe(ENRICHMENT_SUBJECT);
    expect(classForReportSubject("Robotics", index)).toBeNull();
    expect(classForReportSubject("Friday Projects", index)).toBeNull();
    expect(mathReportClass([cls("Math", { includedInReports: false })])).toBeNull();
  });

  test("an ordinary class that fits wins over a not-included one", () => {
    const fitsBoth = [cls("Science"), cls("Science Lab", { includedInReports: false })];
    expect(reportBucketForUnit({ subject: "Science" }, fitsBoth)).toBe("Science");
  });

  test("a name is left out only when every row for it is", () => {
    expect(reportBucketForUnit({ subject: "Robotics" }, [cls("Robotics", { includedInReports: false }), cls("Robotics")])).toBe(
      "Robotics",
    );
    expect(
      reportBucketForUnit({ subject: "Robotics" }, [
        cls("Robotics", { includedInReports: false }),
        cls("Robotics", { includedInReports: false }),
      ]),
    ).toBe(NOT_REPORTED_SUBJECT);
  });

  test("a class can never be bucketed under the not-reported subject by name", () => {
    expect(reportBucketForUnit({ subject: NOT_REPORTED_SUBJECT }, [cls(NOT_REPORTED_SUBJECT)])).toBe(ENRICHMENT_SUBJECT);
  });

  test("creating a report for a class with no report of its own is refused in plain words", () => {
    expect(hiddenClassRefusal("robotics", index)).toBe("Robotics is not included in reports.");
    expect(hiddenClassRefusal("Friday Projects", index)).toBe(
      "Friday Projects has no report of its own. Its work goes in Enrichment and projects.",
    );
    expect(hiddenClassRefusal("Science", index)).toBeNull();
    expect(reportTitle(ENRICHMENT_SUBJECT)).toBe(ENRICHMENT_TITLE);
    expect(isEnrichmentSubject("enrichment and projects")).toBe(true);
  });
});

/**
 * The "Enrichment and projects" row (TRA-723), on top of `setupClasses`:
 * Physical Education (homeroom) and Photography (elective) are not included in
 * reports; Makerspace is the enrichment block. `work` adds sessions in which
 * the scholar wrote a message. Listed: Circuits (Makerspace), My dice game
 * (their own project), Free exploration (no subject), Old kites (turned off,
 * not archived), Arcade app (two live sessions beside one a teacher put away),
 * Paper lanterns (offline work on two days), Bird feeder (one offline piece
 * and one chat), Block builder (one chat and one app play). Left out: Relay
 * races (PE), Pinhole cameras (Photography), another school's unit, another
 * scholar's project, SEL work, Paper boats (one live session), Clouds (no
 * scholar message in its second session), Sundial (offline work on one day
 * only), and the one-session units from the setup.
 */
async function setupEnrichment(opts: { parents?: boolean } = {}) {
  const env = await setupClasses({ parents: opts.parents });
  const { t, b, scholarId, teacherId, periodId, units } = env;
  await t.run(async (ctx) => {
    const homeroom = (await ctx.db.query("scholarGroups").collect()).find((g) => g.name === "Geckos")!;
    await ctx.db.insert("classes", {
      institutionId: homeroom.institutionId!, periodId, groupId: homeroom._id, subject: "Physical Education",
      subjectKey: "physical education", meetings: [], includedInReports: false,
    });
    for (const c of await ctx.db.query("classes").collect())
      if (c.subject === "Photography") await ctx.db.patch(c._id, { includedInReports: false });
    const unit = (title: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("units", { teacherId, title, isActive: true, ...extra });
    const work = async (unitId: Id<"units">, n = 2, session: Record<string, unknown> = {}, role: "user" | "assistant" = "user") => {
      for (let i = 0; i < n; i++) {
        const sessionId = await ctx.db.insert("sessions", { userId: scholarId, unitId, title: "w", isArchived: false, ...session });
        await ctx.db.insert("messages", { sessionId, role, content: "hi", flagged: false });
      }
    };
    for (const u of [units.makerspace, units.scholarMade, units.noSubject]) await work(u);
    await work(await unit("Relay races", { subject: "Physical Education" }));
    await work(units.photography);
    await work(units.otherSchool);
    await work(await unit("Their own comic", { authorScholarId: b.scholars[0].id }));
    await work(await unit("Feelings journal", { subject: "SEL" }));
    // Turned off is not archived: still listed.
    await work(await unit("Old kites", { isActive: false }));
    const arcade = await unit("Arcade app");
    await work(arcade);
    await work(arcade, 1, { isArchived: true, teacherArchivedAt: Date.now() });
    const boats = await unit("Paper boats");
    await work(boats, 1);
    await work(boats, 1, { isArchived: true });
    const clouds = await unit("Clouds");
    await work(clouds, 1);
    await work(clouds, 1, {}, "assistant");
    // Work with no typed message: completions (offline or app work).
    const day = 24 * 3_600_000;
    const complete = async (title: string, at: number[], session?: Id<"sessions">) => {
      const unitId = await unit(title);
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      const activityId = await ctx.db.insert("activities", { lessonId, title: "A", kind: "offline", order: 0 });
      for (const t0 of at)
        await ctx.db.insert("activityCompletions", { scholarId, activityId, unitId, completedAt: t0, ...(session ? { sessionId: session } : {}) });
      return unitId;
    };
    const now = Date.now();
    await complete("Paper lanterns", [now - 3 * day, now - 2 * day]); // two days of offline work: listed
    await complete("Sundial", [now - 3 * day, now - 3 * day + 1000]); // one day only: left out
    const feeder = await complete("Bird feeder", [now - 2 * day]); // one offline piece + one chat: listed
    await work(feeder, 1);
    // A session with an app play and no typed message counts.
    const blocks = await unit("Block builder");
    await work(blocks, 1);
    const played = await ctx.db.insert("sessions", { userId: scholarId, unitId: blocks, title: "w", isArchived: false });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId: played, title: "Blocks", content: "<canvas></canvas>", lastEditedBy: "ai", type: "code", language: "html",
    });
    await ctx.db.insert("appPlaySessions", {
      userId: scholarId, sessionId: played, artifactId, surface: "native", startedAt: now, lastActiveAt: now, resumes: 0,
    });
  });
  return env;
}

// Arcade app keeps two live sessions beside the one a teacher put away.
const LISTED = [
  "- Arcade app", "- Bird feeder", "- Block builder", "- Circuits", "- Free exploration", "- My dice game", "- Old kites",
  "- Paper lanterns",
];
const listLines = (body: string) => body.split("\n").filter(Boolean).sort();
const enrichmentRow = async (t: Awaited<ReturnType<typeof setupClasses>>["t"], periodId: Id<"reportingPeriods">) =>
  (await t.run((ctx) => ctx.db.query("courseNarratives").collect())).find(
    (r) => r.periodId === periodId && r.subject === ENRICHMENT_SUBJECT,
  );

describe("enrichment and projects row", () => {
  test("classes with no report of their own get no row, aren't offered, and are refused on every create path", async () => {
    const { t, asA, scholarId, teacherId, periodId } = await setupEnrichment();
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.map((r) => r.subject)).toEqual([
      "Art", "Humanities", "Math", "Math Workshop", "Science", "SEL", ENRICHMENT_SUBJECT,
    ]);
    expect(list.rows.at(-1)).toMatchObject({ hasEvidence: true, autoDraft: true, narrativeId: null });
    const picker = await asA.query(api.parentReports.classesForScholarPeriod, { scholarId, periodId });
    for (const name of ["Physical Education", "Photography", "Makerspace"]) expect(picker).not.toContain(name);
    const refused = async (p: Promise<unknown>) => ((await p.catch((x: unknown) => x)) as ConvexError<string>).data;
    expect(await refused(asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Physical Education" }))).toBe(
      "Physical Education is not included in reports.",
    );
    expect(await refused(asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Makerspace", body: "x" }))).toBe(
      "Makerspace has no report of its own. Its work goes in Enrichment and projects.",
    );
    expect(
      await refused(asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: "Photography" })),
    ).toBe("Photography is not included in reports.");
    expect(
      await refused(
        t.mutation(internal.courseNarratives.openInternal, { scholarId, teacherId, periodId, subject: "Photography" }),
      ),
    ).toBe("Photography is not included in reports.");
    expect(await t.run((ctx) => ctx.db.query("courseNarratives").collect())).toHaveLength(1); // last spring's only
  });

  test("drafting lists the titles at once, then the drafter rewrites each line for parents", async () => {
    const { t, asA, scholarId, periodId } = await setupEnrichment();
    const id = await asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: ENRICHMENT_SUBJECT });
    const row = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(row.subject).toBe(ENRICHMENT_SUBJECT);
    expect(row.status).toBe("draft");
    expect(listLines(row.sections[0].body)).toEqual(LISTED);
    // Opening it by its title finds the same row.
    expect(await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Enrichment and projects" })).toBe(id);

    // One drafter job for the row; it is given the items in list order.
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toHaveLength(1);
    const job = jobs[0].args[0] as { narrativeId: Id<"courseNarratives">; requestedAt: number };
    expect(job.narrativeId).toBe(id);
    const gathered = (await t.query(internal.parentReports.evidenceForDraft, { narrativeId: id }))!;
    if (gathered.kind !== "enrichment") throw new Error("expected the enrichment list");
    expect(gathered.items.map((i) => `- ${i.title}`).sort()).toEqual(LISTED);
    // Each item carries what is inside it: its lessons, the scholar's session
    // titles, and whether the scholar built it.
    const dice = gathered.items.find((i) => i.title === "My dice game")!;
    expect(dice.scholarMade).toBe(true);
    expect(dice.sessionTitles).toEqual(["scholarMade", "w"]);
    expect(gathered.items.find((i) => i.title === "Circuits")?.scholarMade).toBe(false);
    const request = buildEnrichmentListRequest([
      { title: "Responsibility", description: "This is a app", scholarMade: true, lessonTitles: ["Designing a code"], sessionTitles: ["Code hunt"] },
    ]);
    expect(request).toBe(
      "1. Title: Responsibility (a project the child built)\n   Description: This is a app\n   Lessons: Designing a code\n   The child's sessions: Code hunt",
    );

    // The request's own numbering is accepted as list lines.
    expect(parseEnrichmentList("1. First thing\n2) Second thing.", 2)).toBe("- First thing\n- Second thing");
    // A reply with the wrong number of lines keeps the titles and says so.
    model.replies = [reply("- Only one line")];
    await t.action(internal.parentReportActions.draft, job);
    let after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(listLines(after.sections[0].body)).toEqual(LISTED);
    expect(after.draftError).toMatch(/unit titles/);

    // One line per item replaces the titles, cleaned to plain lines.
    const requestedAt = Date.now();
    await t.run((ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
    model.replies = [reply(LISTED.map((_, n) => `- **Project ${n + 1}** [about it].`).join("\n"))];
    await t.action(internal.parentReportActions.draft, { narrativeId: id, requestedAt });
    after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(listLines(after.sections[0].body)).toEqual(LISTED.map((_, n) => `- Project ${n + 1} (about it)`));
    expect(after.draftError).toBeUndefined();
  });

  test("draft all lists the row by title and queues its rewrite last", async () => {
    const { t, asA, scholarId, periodId } = await setupEnrichment();
    const res = await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    const row = (await enrichmentRow(t, periodId))!;
    expect(listLines(row.sections[0].body)).toEqual(LISTED);
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const queued = jobs.flatMap((j) => {
      const a = j.args[0] as { narrativeId: string; next: { narrativeId: string }[] };
      return [a.narrativeId, ...a.next.map((q) => q.narrativeId)];
    });
    expect(queued.at(-1)).toBe(row._id);
    expect(res).toEqual({ scheduled: queued.length - 1, filled: 1 });
  });

  test("an edited row is shared as edited, the family sees exactly that last in the term, and it is never redrafted", async () => {
    const { t, world, a, b, asA, scholarId, teacherId, periodId } = await setupEnrichment({ parents: true });
    const asParent = await world.as.parent(a.parents[0]);
    const art = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        scholarId, teacherId, periodId, unitIds: [], goalIds: [], subject: "Art", status: "final",
        sections: [{ key: "report", title: "Report", body: "We painted murals." }],
      }),
    );
    await asA.mutation(api.courseNarratives.share, { narrativeId: art });
    const id = await asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: ENRICHMENT_SUBJECT });
    // Not shared yet: the family doesn't see it.
    expect((await asParent.query(api.parents.childSharedNarratives, { scholarId })).course.map((n) => n.subject)).not.toContain(
      ENRICHMENT_TITLE,
    );
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "- Circuits\n- Free exploration" });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: id, done: true });
    await asA.mutation(api.courseNarratives.share, { narrativeId: id });
    const course = (await asParent.query(api.parents.childSharedNarratives, { scholarId })).course;
    expect(course.map((n) => n.subject)).toEqual(["Art", ENRICHMENT_TITLE, "Math Workshop"]);
    expect(course[1].sections).toEqual([{ key: "report", title: "Report", body: "- Circuits\n- Free exploration" }]);
    // Shared: never redrafted, by hand or by draft all.
    await expect(asA.mutation(api.parentReports.requestDraft, { narrativeId: id })).rejects.toThrow(/published/);
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect((await t.run((ctx) => ctx.db.get(id)))!.sections[0].body).toBe("- Circuits\n- Free exploration");
    // Another school's parent can't read this child at all.
    await expect(world.as.parent(b.parents[0]).then((p) => p.query(api.parents.childSharedNarratives, { scholarId }))).rejects.toThrow();
  });

  test("redrafting an unshared row regenerates the list and returns it to draft", async () => {
    const { t, asA, scholarId, periodId } = await setupEnrichment();
    const id = await asA.mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: ENRICHMENT_SUBJECT });
    await asA.mutation(api.courseNarratives.saveSection, { narrativeId: id, key: "report", body: "- Trimmed" });
    await asA.mutation(api.courseNarratives.setDone, { narrativeId: id, done: true });
    expect(await asA.mutation(api.parentReports.requestDraft, { narrativeId: id })).toBe(id);
    const row = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(listLines(row.sections[0].body)).toEqual(LISTED);
    expect(row.status).toBe("draft");
  });

  test("with nothing to list the row reads as no work, draft all skips it, and drafting it is refused", async () => {
    const { t, asA, scholarId, periodId } = await setupClasses();
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.at(-1)).toMatchObject({ subject: ENRICHMENT_SUBJECT, hasEvidence: false });
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect(await enrichmentRow(t, periodId)).toBeUndefined();
    const err = await asA
      .mutation(api.parentReports.requestDraft, { scholarId, periodId, subject: ENRICHMENT_SUBJECT })
      .catch((x: unknown) => x);
    expect((err as ConvexError<string>).data).toBe(NO_ENRICHMENT_REFUSAL);
    expect(await enrichmentRow(t, periodId)).toBeUndefined();
  });

  test("a report already shared for a now not-included class stays with the family; a draft stays hand-added", async () => {
    const { t, world, a, asA, scholarId, teacherId, periodId } = await setupClasses({ parents: true });
    const base = { scholarId, teacherId, periodId, unitIds: [], goalIds: [] };
    const shared = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        ...base, subject: "Photography", status: "shared", sharedAt: 1,
        sections: [{ key: "report", title: "Report", body: "Shared photography." }],
      }),
    );
    const draft = await t.run((ctx) =>
      ctx.db.insert("courseNarratives", {
        ...base, subject: "Robotics", status: "draft", sections: [{ key: "report", title: "Report", body: "" }],
      }),
    );
    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("classes").collect())
        if (c.subject === "Photography" || c.subject === "Robotics") await ctx.db.patch(c._id, { includedInReports: false });
    });
    const asParent = await world.as.parent(a.parents[0]);
    const family = await asParent.query(api.parents.childSharedNarratives, { scholarId });
    expect(family.course.map((n) => [n.subject, n.sections[0].body])).toContainEqual(["Photography", "Shared photography."]);
    const rows = (await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId })).rows;
    expect(rows.filter((r) => r.subject === "Photography" || r.subject === "Robotics")).toEqual([
      { subject: "Photography", narrativeId: shared, autoDraft: false, hasEvidence: true, leftover: false },
      { subject: "Robotics", narrativeId: draft, autoDraft: false, hasEvidence: true, leftover: false },
    ]);
    await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect((await t.run((ctx) => ctx.db.get(shared)))!.sections[0].body).toBe("Shared photography.");
    expect((await t.run((ctx) => ctx.db.get(draft)))!.draftRequestedAt).toBeUndefined();
  });
});

/**
 * Paper work counts for its class by the same rule as everything else
 * (TRA-723): a scanned page's unit's bucket, even when the scholar never
 * opened that unit in a session; else the domains observed on the page.
 */
async function setupPaper() {
  const env = await setupClasses();
  const { t, scholarId, teacherId } = env;
  const page = async (title: string, opts: { unitSubject?: string; domain?: string | string[]; misconception?: string }) =>
    t.run(async (ctx) => {
      let activityId: Id<"activities"> | undefined;
      if (opts.unitSubject !== undefined) {
        const unitId = await ctx.db.insert("units", { teacherId, title: `${title} unit`, subject: opts.unitSubject, isActive: true });
        const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
        activityId = await ctx.db.insert("activities", { lessonId, title, kind: "offline", order: 0 });
      }
      const id = await ctx.db.insert("portfolioItems", {
        source: "upload", matchStatus: "confirmed", processingStatus: "ready", scholarId, title,
        aiCaption: `${title} on paper`, ...(activityId ? { activityId } : {}),
      });
      const observe = (domain: string, evidenceType: "explanation" | "misconception_signal") =>
        ctx.db.insert("masteryObservations", {
          scholarId, portfolioItemId: id, conceptLabel: title, domain, observedAt: Date.now(),
          evidenceType, evidenceSummary: `Did ${title}`, isSuperseded: false,
          transcriptExcerpt: "", masteryLevel: 3, confidenceScore: 0.8, attemptContext: "session", studentInitiated: false,
        });
      for (const d of opts.domain === undefined ? [] : [opts.domain].flat()) await observe(d, "explanation");
      if (opts.misconception) await observe(opts.misconception, "misconception_signal");
      return id;
    });
  return { ...env, page };
}

describe("paper work counts for its class", () => {
  const paperText = async (asA: Awaited<ReturnType<typeof setupClasses>>["asA"], scholarId: Id<"users">, periodId: Id<"reportingPeriods">, subject: string) => {
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject });
    const e = (await asA.query(api.parentReports.evidence, { narrativeId: id }))!;
    return { e, text: (e.groups.find((g) => g.key === "paperWork")?.items ?? []).join("\n") };
  };

  test("a class whose only work is scanned paper has work, is drafted, and its evidence holds the pieces", async () => {
    const { t, asA, scholarId, periodId, page } = await setupPaper();
    await page("Owl pellet diagram", { unitSubject: "Science" });
    // An elective class with only paper still gets its row.
    await page("Gear sketch", { unitSubject: "Robotics" });
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    const row = (s: string) => list.rows.find((r) => r.subject === s);
    expect(row("Science")).toMatchObject({ hasEvidence: true, autoDraft: true });
    expect(row("Robotics")).toMatchObject({ hasEvidence: true, autoDraft: true });
    expect(row("Art")).toMatchObject({ hasEvidence: false });
    const res = await asA.mutation(api.parentReports.draftAllForScholar, { scholarId, periodId });
    expect(res.scheduled).toBe(list.rows.filter((r) => r.autoDraft && r.hasEvidence && !r.subject.startsWith("__")).length);
    const science = (await t.run((ctx) => ctx.db.query("courseNarratives").collect())).find(
      (r) => r.periodId === periodId && r.subject === "Science",
    )!;
    expect(science.draftRequestedAt).toBeTypeOf("number");
    const { e, text } = await paperText(asA, scholarId, periodId, "Science");
    expect(e.classWithoutWork).toBe(false);
    expect(text).toMatch(/Owl pellet diagram/);
    expect(text).not.toMatch(/Gear sketch/);
  });

  test("a page with no unit whose subject fits two classes is in neither", async () => {
    const { asA, scholarId, periodId, page } = await setupPaper();
    await page("Color wheel", { domain: "Science & Art" });
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    for (const s of ["Science", "Art"]) {
      expect(list.rows.find((r) => r.subject === s)).toMatchObject({ hasEvidence: false });
      expect((await paperText(asA, scholarId, periodId, s)).text).toBe("");
    }
  });

  test("a page with no unit whose subject fits one class counts for it", async () => {
    const { asA, scholarId, periodId, page } = await setupPaper();
    await page("Leaf rubbing", { domain: "Science" });
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.find((r) => r.subject === "Science")).toMatchObject({ hasEvidence: true });
    expect((await paperText(asA, scholarId, periodId, "Science")).text).toMatch(/Leaf rubbing/);
  });

  test("paper for a class not included in reports goes nowhere", async () => {
    const { t, asA, scholarId, periodId, page } = await setupPaper();
    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("classes").collect())
        if (c.subject === "Robotics") await ctx.db.patch(c._id, { includedInReports: false });
    });
    await page("Gear sketch", { unitSubject: "Robotics" });
    await page("Motor notes", { domain: "Robotics" });
    const list = await asA.query(api.parentReports.subjectsForScholarPeriod, { scholarId, periodId });
    expect(list.rows.map((r) => r.subject)).not.toContain("Robotics");
    for (const s of ["Science", "Art", "Math", "Humanities"])
      expect((await paperText(asA, scholarId, periodId, s)).text).not.toMatch(/Gear sketch|Motor notes/);
  });

  test("a page with no unit counts for a class only when all its skills agree on it", async () => {
    const { t, asA, scholarId, periodId, page } = await setupPaper();
    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("classes").collect())
        if (c.subject === "Robotics") await ctx.db.patch(c._id, { includedInReports: false });
    });
    // Both skills in Science, plus a misconception note about Art: Science.
    await page("Leaf rubbing", { domain: ["Science", "Science"], misconception: "Art" });
    // Skills in two classes: no class.
    await page("Bridge model", { domain: ["Science", "Art"] });
    // One skill in a class not included in reports: nowhere, not Science.
    await page("Motor and magnets", { domain: ["Robotics", "Science"] });
    const science = (await paperText(asA, scholarId, periodId, "Science")).text;
    expect(science).toMatch(/Leaf rubbing/);
    expect(science).not.toMatch(/Bridge model|Motor and magnets/);
    expect((await paperText(asA, scholarId, periodId, "Art")).text).toBe("");
  });

  test("misconception notes alone don't place a page", async () => {
    const { asA, scholarId, periodId, page } = await setupPaper();
    await page("Scribbles", { misconception: "Science" });
    for (const s of ["Science", "Art", "Math", "Humanities"])
      expect((await paperText(asA, scholarId, periodId, s)).text).not.toMatch(/Scribbles/);
  });
});

describe("parent reports — reading a scholar's own turns in a unit", () => {
  /** A Humanities report whose one unit has a session of mixed message rows. */
  async function setupReading() {
    const env = await setupClasses();
    const { t, asA, scholarId, periodId, units, teacherId } = env;
    await t.run(async (ctx) => {
      const session = (await ctx.db.query("sessions").collect()).find((s) => s.unitId === units.humanities)!;
      const msg = (role: "user" | "assistant" | "system" | "tool", content: string, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("messages", { sessionId: session._id, role, content, flagged: false, ...extra });
      await msg("user", "<start>");
      await msg("system", "SYSTEM ROW: not for the reader");
      await msg("assistant", "Why do you think the canoe needed an outrigger?");
      await msg("user", "Because without it the canoe would tip over in big waves");
      await msg("tool", "TOOL ROW: not for the reader");
      await msg("user", "STAFF ROW: typed by a teacher", { byStaff: true });
      await msg("user", "APP ROW: an app asking", { inputModality: "app" });
      await msg("user", "READ ALOUD ROW", { readAloudOf: "Read this line" });
      await msg("assistant", "How would you test that idea?");
      await msg("user", "I would build two small boats and push them in the tub");
      await msg("assistant", "What did the stars tell navigators?");
      await msg("user", "The stars rise in the same place so you can steer by them");
      await msg("user", "I think I want to draw a star compass next");
      // A teacher's test drive in the same unit never reaches the reader.
      const drive = await ctx.db.insert("sessions", {
        userId: teacherId, unitId: units.humanities, title: "drive", isArchived: false, isTestDrive: true,
      });
      await ctx.db.insert("messages", { sessionId: drive, role: "user", content: "TEST DRIVE ROW", flagged: false });
      // Lesson and activity design text for "what the unit asked".
      const lessonId = await ctx.db.insert("lessons", { unitId: units.humanities, title: "Wayfinding", order: 0 });
      await ctx.db.insert("activities", {
        lessonId, title: "Star compass", kind: "online", order: 0, systemPrompt: "TUTOR PROMPT: never shown",
        description: "TEACHER NOTES: never shown", scholarDescription: "Make your own star compass",
      });
    });
    const id = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "Humanities" });
    return { ...env, id };
  }

  test("a class report reads its own units; the reader refuses a unit outside it and sees only the scholar's and the AI's turns", async () => {
    const { t, asA, scholarId, periodId, units, id } = await setupReading();
    const gathered = (await t.query(internal.parentReports.evidenceForDraft, { narrativeId: id }))!;
    expect(gathered.kind).toBe("report");
    if (gathered.kind !== "report") return;
    expect(gathered.readingUnitIds).toEqual([units.humanities]);

    // A unit from another class (Math) is not this report's: refused.
    expect(await t.query(internal.parentReports.unitReadingInput, { narrativeId: id, unitId: units.math })).toBeNull();

    const input = (await t.query(internal.parentReports.unitReadingInput, { narrativeId: id, unitId: units.humanities }))!;
    expect(input.unitTitle).toBe("Voyaging");
    const turns = input.sessions.flatMap((s) => s.turns);
    expect(turns.filter((x) => x.role === "scholar").map((x) => x.text)).toEqual([
      "Because without it the canoe would tip over in big waves",
      "I would build two small boats and push them in the tub",
      "The stars rise in the same place so you can steer by them",
      "I think I want to draw a star compass next",
    ]);
    expect(turns.filter((x) => x.role === "ai")).toHaveLength(3);
    expect(JSON.stringify(input)).not.toMatch(/SYSTEM ROW|TOOL ROW|STAFF ROW|APP ROW|READ ALOUD ROW|TEST DRIVE ROW|<start>/);
    // What the unit asked: design text, never the tutor prompt or teacher notes.
    expect(input.unitAsked).toMatch(/Wayfinding/);
    expect(input.unitAsked).toMatch(/Make your own star compass/);
    expect(input.unitAsked).not.toMatch(/TUTOR PROMPT|TEACHER NOTES/);

    // SEL reads no units.
    const sel = await asA.mutation(api.courseNarratives.open, { scholarId, periodId, subject: "SEL" });
    const selGathered = (await t.query(internal.parentReports.evidenceForDraft, { narrativeId: sel }))!;
    expect(selGathered.kind === "report" && selGathered.readingUnitIds).toEqual([]);
    expect(await t.query(internal.parentReports.unitReadingInput, { narrativeId: sel, unitId: units.humanities })).toBeNull();
  });

  test("verified notes reach the draft; an invented quote doesn't; a failed reading still drafts", async () => {
    const { t, id } = await setupReading();
    const run = async () => {
      const requestedAt = Date.now();
      await t.run(async (ctx) => ctx.db.patch(id, { draftRequestedAt: requestedAt }));
      model.requests = [];
      await t.action(internal.parentReportActions.draft, { narrativeId: id, requestedAt });
      return (await t.run(async (ctx) => ctx.db.get(id)))!;
    };
    const notes = {
      notes: [
        {
          kind: "habit",
          note: "Tests an idea by building something.",
          moments: [
            { date: "Jan 1", turn: 1, quote: "the canoe would tip over" },
            { date: "Jan 1", turn: 2, quote: "build two small boats" },
          ],
        },
        {
          kind: "change",
          note: "An invented change.",
          moments: [
            { date: "Jan 1", turn: 1, quote: "INVENTED WORDS the child never said" },
            { date: "Jan 1", turn: 3, quote: "steer by them" },
          ],
        },
      ],
    };
    model.replies = [reply("```json\n" + JSON.stringify(notes) + "\n```"), reply("Ada steered by the stars.")];
    let n = await run();
    expect(model.requests).toHaveLength(2);
    const draftPrompt = String(model.requests[1].messages[0].content);
    expect(draftPrompt).toMatch(/build two small boats/);
    expect(draftPrompt).not.toMatch(/INVENTED WORDS|An invented change/);
    expect(n.sections[0].body).toBe("Ada steered by the stars.");

    // The reader's reply is cut off: no notes, and the draft still lands.
    model.replies = [reply('{"notes": [', "max_tokens"), reply("Ada built boats.")];
    n = await run();
    expect(model.requests).toHaveLength(2);
    expect(n.draftError).toBeUndefined();
    expect(n.sections[0].body).toBe("Ada built boats.");
  });
});
