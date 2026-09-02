import { internalMutation, internalQuery, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Diagnostic: per-scholar evidence counts + how much falls inside the demo
 * reporting window. Run: `npx convex run seed/assessmentDemo:diagnoseEvidence`
 */
export const diagnoseEvidence = internalQuery({
  args: {},
  handler: async (ctx) => {
    const periods = await ctx.db.query("reportingPeriods").collect();
    const demo = periods.find((p) => p.label === "Fall 2026 (demo)");
    const win = demo ? { s: demo.startsAt, e: demo.endsAt } : null;
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.gte("username", "a"))
      .collect();
    const rows: Record<string, unknown>[] = [];
    for (const u of scholars) {
      if (!u.username) continue;
      const mastery = await ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar_current", (q) =>
          q.eq("scholarId", u._id).eq("isSuperseded", false),
        )
        .collect();
      const signals = await ctx.db
        .query("sessionSignals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", u._id))
        .collect();
      const conns = await ctx.db
        .query("crossDomainConnections")
        .withIndex("by_scholar", (q) => q.eq("scholarId", u._id))
        .collect();
      const total = mastery.length + signals.length + conns.length;
      if (total === 0) continue;
      const inWin = win
        ? mastery.filter((m) => m.observedAt >= win.s && m.observedAt <= win.e).length +
          signals.filter((x) => x._creationTime >= win.s && x._creationTime <= win.e).length +
          conns.filter((x) => x._creationTime >= win.s && x._creationTime <= win.e).length
        : 0;
      rows.push({
        username: u.username,
        name: u.name,
        mastery: mastery.length,
        signals: signals.length,
        conns: conns.length,
        inWindow: inWin,
        total,
      });
    }
    rows.sort((a, b) => (b.total as number) - (a.total as number));
    return { window: win, scholars: rows };
  },
});

/**
 * DEV-ONLY demo seed for the Narrative Assessment (PCM) & Goals feature
 * (review/assessment-and-goals-plan.html). RE-RUNNABLE: deletes prior demo data
 * first, then reseeds HONESTLY:
 *   - Kai Nakamura (test-scholar-001) gets RICH, PCM-tagged evidence across all
 *     four dimensions + anecdotes + counter-evidence + goals — so the evidence
 *     binder is the star.
 *   - The DRAFT narrative's teacher-written sections start EMPTY (the design
 *     leads with teacher observation — the AI never pre-writes child-specific
 *     prose); only the child-NEUTRAL context paragraph is pre-drafted. The AI's
 *     rating suggestion is pre-computed but hidden until the teacher commits
 *     (anti-anchoring).
 *   - A shared narrative for a parent-linked child (parent portal).
 * Run: `npx convex run seed/assessmentDemo:seedAssessmentDemo`
 */
/**
 * Seed a DEMO scholar session with rich, PCM-tagged evidence (the binder's
 * whole point). Shared by every demo scholar so their reports have real
 * evidence to show — content is parameterized per scholar.
 */
type DemoSessionEvidence = {
  scholarId: Id<"users">;
  teacherId: Id<"users">;
  unit: Doc<"units"> | undefined;
  now: number;
  DAY: number;
  sessionTitle: string;
  mastery: {
    conceptLabel: string; domain: string; masteryLevel: number; observedAt: number;
    studentInitiated?: boolean; evidenceSummary?: string; evidenceType?: string;
    pcmDimension?: "core" | "connections" | "practice" | "identity";
  }[];
  connections: { domains: string[]; description: string; studentInitiated: boolean }[];
  signals: { signalType: string; intensity: string; description: string; pcmDimension: "practice" | "identity" }[];
  observations: { type: "praise" | "concern"; weight: "minor" | "major"; note: string }[];
};

async function seedDemoSession(ctx: MutationCtx, e: DemoSessionEvidence): Promise<Id<"sessions">> {
  const sessionId = await ctx.db.insert("sessions", {
    userId: e.scholarId,
    unitId: e.unit?._id,
    title: e.sessionTitle,
    isArchived: false,
  });
  for (const o of e.mastery) {
    await ctx.db.insert("masteryObservations", {
      scholarId: e.scholarId, sessionId,
      conceptLabel: o.conceptLabel, domain: o.domain, observedAt: o.observedAt,
      transcriptExcerpt: "", masteryLevel: o.masteryLevel, confidenceScore: 0.8,
      evidenceSummary: o.evidenceSummary ?? "",
      evidenceType: o.evidenceType ?? "direct_demonstration",
      attemptContext: "conversation", studentInitiated: o.studentInitiated ?? false,
      isSuperseded: false, pcmDimension: o.pcmDimension,
    });
  }
  for (const c of e.connections) {
    await ctx.db.insert("crossDomainConnections", {
      scholarId: e.scholarId, sessionId, domains: c.domains, conceptLabels: [],
      description: c.description, studentInitiated: c.studentInitiated, pcmDimension: "connections",
    });
  }
  for (const s of e.signals) {
    await ctx.db.insert("sessionSignals", {
      scholarId: e.scholarId, sessionId, signalType: s.signalType,
      intensity: s.intensity, description: s.description, pcmDimension: s.pcmDimension,
    });
  }
  const granuleKeys = [
    ...(e.unit?.essentialQuestions ?? []).map((q) => q.key),
    ...(e.unit?.enduringUnderstandings ?? []).map((q) => q.key),
  ].slice(0, 2);
  if (e.unit) {
    for (const granuleKey of granuleKeys) {
      await ctx.db.insert("granuleEvidence", {
        scholarId: e.scholarId, unitId: e.unit._id, granuleKey, sessionId,
        observedAt: e.now - 15 * e.DAY, outcome: "demonstrated", transcriptExcerpt: "",
        evidenceSummary: "Demonstrated the understanding at exit (baseline: only probed).",
        bloomLevel: "analyze",
      });
    }
  }
  for (const o of e.observations) {
    await ctx.db.insert("observations", {
      teacherId: e.teacherId, scholarId: e.scholarId, sessionId,
      type: o.type, weight: o.weight, note: o.note,
    });
  }
  return sessionId;
}

export const seedAssessmentDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const log: string[] = [];
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const byName = async (username: string): Promise<Doc<"users"> | null> =>
      await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .first();

    const teacher = await byName("test-teacher-001");
    const kai = await byName("test-scholar-001");
    const oliver = await byName("oliver_stone");
    if (!teacher || !kai) {
      throw new Error("Seed expects test-teacher-001 + test-scholar-001 (run pnpm db:seed:rich).");
    }
    const demoScholars = [kai._id, oliver?._id].filter(Boolean) as Id<"users">[];

    await resetDemo(ctx, demoScholars);

    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026 (demo)",
      startsAt: now - 90 * DAY,
      endsAt: now + 60 * DAY,
      narrativesDueAt: now + 30 * DAY,
      status: "writing",
      institutionId: kai.institutionId ?? undefined,
    });

    const units = await ctx.db
      .query("units")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();
    const unit =
      units.find((u) => (u.subject ?? "").toLowerCase().includes("science")) ??
      units.find((u) => /aquaponic|space|autorotation/i.test(u.title)) ??
      units[0];
    const unitIds: Id<"units">[] = unit ? [unit._id] : [];
    const subject = unit?.subject || "Science";

    await seedDemoSession(ctx, {
      scholarId: kai._id, teacherId: teacher._id, unit, now, DAY,
      sessionTitle: "DEMO:: Aquaponics investigation",
      mastery: [
        { conceptLabel: "Resilient systems thinking", domain: "Science", masteryLevel: 4, studentInitiated: true, observedAt: now - 40 * DAY, evidenceSummary: "Explained how a feedback loop keeps the tank stable when one variable spikes.", pcmDimension: "core" },
        { conceptLabel: "Nitrogen cycle", domain: "Biology", masteryLevel: 3, observedAt: now - 25 * DAY, evidenceSummary: "Traced ammonia → nitrite → nitrate in her own words.", pcmDimension: "core" },
        { conceptLabel: "Engineering trade-offs", domain: "Engineering", masteryLevel: 4, studentInitiated: true, observedAt: now - 10 * DAY, evidenceSummary: "Weighed flow-rate against filtration when redesigning the pump.", pcmDimension: "core" },
        { conceptLabel: "Believes heavier objects always sink faster regardless of shape", domain: "Physics", masteryLevel: 1, observedAt: now - 30 * DAY, evidenceSummary: "Held that a heavier hull must sink faster — didn't yet account for displacement.", evidenceType: "misconception_signal", pcmDimension: "core" },
      ],
      connections: [
        { domains: ["Biology", "History"], description: "Linked the nitrogen cycle to Hawaiian ahupuaʻa land divisions — 'it's the same loop, just with people in it.'", studentInitiated: true },
        { domains: ["Physics", "Engineering"], description: "Connected water pressure at depth to the hull-design choices.", studentInitiated: false },
        { domains: ["Mathematics", "Science"], description: "Recognized exponential growth in the algae-bloom data.", studentInitiated: true },
      ],
      signals: [
        { signalType: "productive_struggle", intensity: "high", description: "Re-ran the pH series after spotting her own sampling error — unprompted.", pcmDimension: "practice" },
        { signalType: "metacognition", intensity: "moderate", description: "Named exactly where her reasoning had broken down.", pcmDimension: "practice" },
        { signalType: "self_direction", intensity: "high", description: "Chose the harder research question when offered an easier one.", pcmDimension: "identity" },
        { signalType: "intellectual_intensity", intensity: "high", description: "Kept pulling the reef-microbe thread on her own time.", pcmDimension: "identity" },
      ],
      observations: [
        { type: "praise", weight: "major", note: "Presented her bridge redesign to the whole pod unprompted and took critique gracefully — big step for her." },
        { type: "praise", weight: "minor", note: "Organized the loose-parts shelf without being asked." },
        { type: "concern", weight: "minor", note: "Left the long model build to the last two days — pacing on multi-week work is the growing edge." },
      ],
    });
    log.push("Seeded rich PCM-tagged evidence for Kai (test-scholar-001).");

    // ── Goals + check-ins ──
    const addGoal = async (
      scholarId: Id<"users">, title: string,
      kind: "academic" | "personal" | "habit" | "hobby",
      status: "active" | "proposed",
      checkins: { note: string; authorType: "scholar" | "teacher" | "observer" }[] = [],
    ) => {
      const goalId = await ctx.db.insert("scholarGoals", {
        scholarId, title, kind, origin: "goalWeek",
        createdBy: status === "proposed" ? scholarId : teacher._id,
        status, feedsTutor: status === "active",
      });
      for (const c of checkins)
        await ctx.db.insert("goalCheckins", {
          goalId, scholarId, authorType: c.authorType,
          authorId: c.authorType === "teacher" ? teacher._id : scholarId, note: c.note,
        });
      return goalId;
    };
    const g1 = await addGoal(kai._id, "Ask my own research question and chase it", "academic", "active", [
      { note: "Started my reef-microbes quest.", authorType: "scholar" },
      { note: "Framed a testable pH question without prompting.", authorType: "observer" },
    ]);
    await addGoal(kai._id, "Stick with hard problems before asking for help", "habit", "active", [
      { note: "Stayed with the fraction-wall puzzle for 20 minutes.", authorType: "observer" },
    ]);
    await addGoal(kai._id, "Read a whole chapter book this term", "personal", "proposed");

    // ── Whole Child observations ──
    const wc = (category: "execFunction" | "socialEmotional" | "collaboration" | "passions", note: string) =>
      ctx.db.insert("observations", {
        scholarId: kai._id,
        teacherId: teacher._id,
        category,
        note,
        type: "note",
      });
    await wc("execFunction", "Now self-starts morning work without a prompt (3 weeks running).");
    await wc("execFunction", "Long-term project pacing still needs scaffolding — left the model build to the last two days.");
    await wc("collaboration", "Led the tide-pool cleanup crew without being asked.");
    await wc("socialEmotional", "Handled a critique of her bridge design gracefully.");

    // ── DRAFT narrative: teacher sections EMPTY; only the child-neutral context
    //    paragraph is pre-filled. Ratings unset (teacher assigns them). No AI.
    await ctx.db.insert("courseNarratives", {
      scholarId: kai._id, teacherId: teacher._id, periodId, subject, unitIds,
      sections: [
        { key: "context", title: "Context — what we studied", body: `During this period, students investigated sustainability and resilience through ${unit?.title ?? "an inquiry unit"} — asking how a system stays stable under stress, and modeling the nitrogen cycle, flow, and feedback that keep it balanced.` },
        { key: "progress", title: "Progress & accomplishments", body: "" },
        { key: "dim_core", title: "Core", body: "" },
        { key: "dim_connections", title: "Connections", body: "" },
        { key: "dim_practice", title: "Practice", body: "" },
        { key: "dim_identity", title: "Identity", body: "" },
        { key: "goals", title: "Goals for Continued Growth", body: "" },
      ],
      goalIds: [g1], status: "draft",
    });
    log.push(`Created a DRAFT ${subject} narrative for Kai — teacher sections EMPTY, context pre-filled, ratings unset.`);

    await ctx.db.insert("wholeChildNarratives", {
      scholarId: kai._id, periodId, advisorId: teacher._id,
      sections: [
        { key: "execFunction", title: "Executive Function & Learning Habits", body: "Grown markedly in day-to-day independence; multi-week projects are the next frontier — we'll scaffold checkpoints rather than deadlines." },
        { key: "socialEmotional", title: "Social-Emotional Growth", body: "" },
        { key: "collaboration", title: "Collaboration, Character & Community", body: "" },
        { key: "passions", title: "Passion Projects, Quests & Extended Learning", body: "" },
        { key: "goals", title: "Goals for Continued Growth", body: "" },
      ],
      goalIds: [], status: "draft",
    });

    if (oliver) {
      // Demo parity with Kai: a real session + PCM-tagged evidence so oliver's
      // report/binder isn't empty (themed to his solar-oven passion project).
      await seedDemoSession(ctx, {
        scholarId: oliver._id, teacherId: teacher._id, unit, now, DAY,
        sessionTitle: "DEMO:: Solar oven build",
        mastery: [
          { conceptLabel: "Heat transfer & insulation", domain: "Science", masteryLevel: 4, studentInitiated: true, observedAt: now - 35 * DAY, evidenceSummary: "Explained why a dark interior plus reflective flaps traps more heat.", pcmDimension: "core" },
          { conceptLabel: "Angle of incidence & reflection", domain: "Physics", masteryLevel: 3, observedAt: now - 20 * DAY, evidenceSummary: "Tuned the reflector angle to aim more sunlight into the box.", pcmDimension: "core" },
          { conceptLabel: "Iterative design", domain: "Engineering", masteryLevel: 5, studentInitiated: true, observedAt: now - 8 * DAY, evidenceSummary: "Rebuilt the seal after v1 leaked heat — v2 ran 30°C hotter.", pcmDimension: "practice" },
        ],
        connections: [
          { domains: ["Physics", "Engineering"], description: "Tied the reflector geometry to how the oven actually heats — 'the math is the design.'", studentInitiated: true },
          { domains: ["Science", "Mathematics"], description: "Charted temperature vs. time and spotted where it plateaued.", studentInitiated: false },
        ],
        signals: [
          { signalType: "self_direction", intensity: "high", description: "Kept iterating the build on his own time between sessions.", pcmDimension: "identity" },
          { signalType: "productive_struggle", intensity: "moderate", description: "Stuck with the heat-loss problem instead of asking for the answer.", pcmDimension: "practice" },
          { signalType: "intellectual_intensity", intensity: "high", description: "Wanted to know exactly why v1 failed before touching v2.", pcmDimension: "identity" },
        ],
        observations: [
          { type: "praise", weight: "major", note: "Presented his v2 solar oven to the pod and explained the fix that got it hotter." },
          { type: "concern", weight: "minor", note: "Jumped to building before sketching a plan — we'll nudge toward an earlier design pass." },
        ],
      });
      const oliverGoal = await addGoal(oliver._id, "Build my own solar oven", "hobby", "active", [
        { note: "Sketched the reflector angles.", authorType: "scholar" },
      ]);
      await ctx.db.insert("courseNarratives", {
        scholarId: oliver._id, teacherId: teacher._id, periodId, subject, unitIds,
        sections: [
          { key: "context", title: "Context — what we studied", body: `This period the class explored ${unit?.title ?? "resilient systems"} — big ideas about how systems stay stable under stress.` },
          { key: "progress", title: "Progress & accomplishments", body: "Oliver asked sharp cause-and-effect questions and built a working model that survived the stress test on his second iteration." },
          { key: "dim_identity", title: "Identity", body: "He's begun describing himself as 'someone who figures out how things work' — a real shift this term." },
          { key: "goals", title: "Goals for Continued Growth", body: "Keep chasing the questions he raises himself, and give multi-week builds an earlier start." },
        ],
        pcmRatings: { core: 4, connections: 4, practice: 5, identity: 5 }, courseRating: 4,
        ratingsCommittedAt: now, goalIds: [oliverGoal], status: "shared", sharedAt: now,
      });
      log.push("Created a SHARED narrative + a session with PCM-tagged evidence for oliver_stone (parent: avery).");
    }

    return { ok: true, periodId, log };
  },
});

/** Delete prior demo data so the seed is re-runnable. */
async function resetDemo(
  ctx: MutationCtx,
  demoScholars: Id<"users">[],
): Promise<void> {
  for (const scholarId of demoScholars) {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholarId))
      .collect();
    const demoSessionIds = new Set(
      sessions.filter((s: Doc<"sessions">) => s.title.startsWith("DEMO::")).map((s: Doc<"sessions">) => s._id),
    );
    for (const tbl of ["masteryObservations", "sessionSignals", "crossDomainConnections", "observations"] as const) {
      const rows = await ctx.db
        .query(tbl)
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect();
      for (const r of rows) if (r.sessionId && demoSessionIds.has(r.sessionId)) await ctx.db.delete(r._id);
    }
    // granuleEvidence has no by_scholar index — delete via by_session.
    for (const sid of demoSessionIds) {
      const grows = await ctx.db
        .query("granuleEvidence")
        .withIndex("by_session", (q) => q.eq("sessionId", sid))
        .collect();
      for (const r of grows) await ctx.db.delete(r._id);
    }
    for (const sid of demoSessionIds) await ctx.db.delete(sid);

    const goals = await ctx.db
      .query("scholarGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    for (const g of goals) {
      const cks = await ctx.db
        .query("goalCheckins")
        .withIndex("by_goal", (q) => q.eq("goalId", g._id))
        .collect();
      for (const c of cks) await ctx.db.delete(c._id);
      await ctx.db.delete(g._id);
    }
  }

  const periods = await ctx.db.query("reportingPeriods").collect();
  for (const p of periods.filter((p: Doc<"reportingPeriods">) => p.label === "Fall 2026 (demo)")) {
    for (const tbl of ["courseNarratives", "wholeChildNarratives"] as const) {
      const rows = await ctx.db
        .query(tbl)
        .withIndex("by_period", (q) => q.eq("periodId", p._id))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    const categoryObservations = await ctx.db.query("observations").collect();
    for (const row of categoryObservations) {
      if (
        row.category !== undefined &&
        demoScholars.includes(row.scholarId) &&
        row._creationTime >= p.startsAt &&
        row._creationTime <= p.endsAt
      ) {
        await ctx.db.delete(row._id);
      }
    }
    await ctx.db.delete(p._id);
  }
}
