// Pure unit tests for the shared scholar-detail read toolset
// (lib/scholarReadTools). No convex-test / SSE needed: the factory is a
// pure builder, so we drive it with a stub ctx and a spy emit. This is
// what guarantees /curriculum-stream and the Curriculum Bot expose the
// SAME set — assert the names + schemas here once.

import { describe, expect, test, vi } from "vitest";
import {
  makeListScholarGroupsTool,
  makeScholarReadTools,
  resolveScholarByName,
} from "../lib/scholarReadTools";
import { readScholarMastery, redactScholarPractice } from "../lib/scholarReads";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

const EXPECTED_NAMES = [
  "list_scholars",
  "get_scholar_dossier",
  "get_scholar_mastery",
  "get_scholar_signals",
  "get_scholar_seeds",
  "get_scholar_observations",
  "get_scholar_sessions",
  "get_session_transcript",
  "get_scholar_web_activity",
  "get_scholar_practice",
  "get_scholar_math_checkin",
  "get_scholar_documents",
  "get_scholar_work_samples",
  "get_school_calendar",
];

const SCHOLAR_ROWS = [
  {
    id: "u_kai",
    name: "Kai Nakamura",
    readingLevel: "3rd",
    dateOfBirth: "2018-04-03",
    currentAge: 8,
    currentAgeAsOf: "2026-08-10",
  },
  {
    id: "u_lani",
    name: "Lani Kealoha",
    readingLevel: "4th",
    dateOfBirth: null,
    currentAge: null,
    currentAgeAsOf: "2026-08-10",
  },
];
// listScholarsInternal's return shape: the read layer filters + counts.
const SCHOLARS = { scholars: SCHOLAR_ROWS, extendedEducationOmitted: 0 };

// Minimal ActionCtx stub — only runQuery is exercised, and only when a
// tool's run() is invoked. Cast through unknown because we deliberately
// implement just the slice the tools touch.
function stubCtx(runQuery: ReturnType<typeof vi.fn>): ActionCtx {
  return { runQuery } as unknown as ActionCtx;
}

describe("makeScholarReadTools", () => {
  test("exposes exactly the scholar-read tools, in order", async () => {
    const tools = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "teacher");
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
  });

  test("name-keyed tools require scholarName; list_scholars takes none", async () => {
    const tools = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "teacher");
    for (const t of tools) {
      const required = (t as unknown as { input_schema: { required: string[] } })
        .input_schema.required;
      if (t.name === "list_scholars") {
        expect(required).toEqual([]);
      } else {
        expect(required).toEqual(["scholarName"]);
      }
    }
  });

  test("staff with a resolved institution can read its calendar without a scholar", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      schoolName: "Moli School",
      schoolSlug: "moli",
      timeZone: "Pacific/Honolulu",
      today: "2026-08-13",
      upcoming: [
        {
          id: "closure-1",
          startDayKey: "2026-09-07",
          endDayKey: "2026-09-07",
          label: "Labor Day",
          kind: "holiday",
        },
      ],
    });
    const institutionId = "institution-1" as Id<"institutions">;
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      () => {},
      "teacher",
      undefined,
      "",
      "Moli School",
      institutionId,
    );
    const calendar = tools.find(
      (tool) => tool.name === "get_school_calendar",
    )!;

    expect(
      (calendar as unknown as { input_schema: { required?: string[] } })
        .input_schema.required ?? [],
    ).toEqual([]);
    await expect(
      (
        calendar as unknown as {
          run: (input: Record<string, never>) => Promise<string>;
        }
      ).run({}),
    ).resolves.toContain("Labor Day");
    expect(runQuery).toHaveBeenCalledWith(
      internal.academicCalendar.getInstitutionCalendar,
      { institutionId },
    );
  });

  test("get_scholar_dossier includes source documents when the dossier is empty", async () => {
    const docs = [
      {
        title: "IQ Report 2024",
        kind: "assessment",
        processingStatus: "ready",
        summary: "Strong verbal and visual reasoning.",
        keyFindings: ["Benefits from open-ended conceptual work"],
      },
    ];
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(SCHOLARS) // listScholarsInternal (via resolveScholar)
      .mockResolvedValueOnce("No dossier data available yet.")
      .mockResolvedValueOnce(docs);
    const emit = vi.fn();

    const tools = await makeScholarReadTools(stubCtx(runQuery), emit, "teacher");
    const dossierTool = tools.find((t) => t.name === "get_scholar_dossier")!;

    const result = await dossierTool.run({ scholarName: "kai" });

    expect(result).toContain("Kai Nakamura");
    expect(result).toContain("No dossier data available yet.");
    expect(result).toContain("IQ Report 2024");
    expect(result).toContain("open-ended conceptual work");
    expect(result).toContain('"dateOfBirth":"2018-04-03"');
    expect(result).toContain('"currentAge":8');
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "get_scholar_dossier",
        result: "Loaded Kai Nakamura's profile and 1 source document(s) (1 ready)",
      },
    });
  });

  test("get_scholar_documents resolves the scholar, returns docs, and reports ready count", async () => {
    const docs = [
      { title: "IQ Report 2024", kind: "assessment", processingStatus: "ready", summary: "WISC-V: FSIQ 131, very superior.", keyFindings: ["Strong verbal reasoning (VCI 140)"] },
      { title: "Parent note", kind: "parent_email", processingStatus: "extracting", summary: null, keyFindings: [] },
    ];
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(SCHOLARS) // listScholarsInternal (resolveScholar)
      .mockResolvedValueOnce(docs); // aiListForScholar
    const emit = vi.fn();

    const tools = await makeScholarReadTools(stubCtx(runQuery), emit, "teacher");
    const docsTool = tools.find((t) => t.name === "get_scholar_documents")!;

    const result = await docsTool.run({ scholarName: "kai" });

    expect(result).toContain("IQ Report 2024");
    expect(result).toContain("WISC-V");
    expect(emit).toHaveBeenCalledWith({
      toolComplete: { name: "get_scholar_documents", result: "Loaded 2 document(s) for Kai Nakamura (1 ready)" },
    });
  });

  test("get_scholar_dossier returns a not-found message for an unknown name (no second query, no emit)", async () => {
    const runQuery = vi.fn().mockResolvedValueOnce(SCHOLARS);
    const emit = vi.fn();

    const tools = await makeScholarReadTools(stubCtx(runQuery), emit, "teacher");
    const dossierTool = tools.find((t) => t.name === "get_scholar_dossier")!;

    const result = await dossierTool.run({ scholarName: "nobody" });

    expect(result).toContain("No scholar found");
    expect(runQuery).toHaveBeenCalledTimes(1); // only the lookup, not the dossier fetch
    expect(emit).not.toHaveBeenCalled();
  });

  test("get_scholar_web_activity exposes the guarded time semantics unchanged", async () => {
    const webActivity = {
      currentTimeLocal: "Aug 26, 2026, 9:17 AM HST",
      timeZone: "Pacific/Honolulu",
      todayDayKey: "2026-08-26",
      interpretation:
        "activeNow requires a fresh capture heartbeat; webviewOpenMinutes is not proof of practice.",
      sessions: [
        {
          status: "stale_unfinalized",
          activeNow: false,
          dayRelation: "yesterday",
          webviewOpenMinutes: 146,
        },
      ],
    };
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(SCHOLARS)
      .mockResolvedValueOnce(webActivity);
    const emit = vi.fn();
    const tools = await makeScholarReadTools(stubCtx(runQuery), emit, "teacher");
    const tool = tools.find((candidate) => candidate.name === "get_scholar_web_activity")!;

    const rawResult = await tool.run({ scholarName: "kai" });
    if (typeof rawResult !== "string") {
      throw new Error("Expected get_scholar_web_activity to return JSON text");
    }
    const result = JSON.parse(rawResult) as {
      scholar: string;
      webActivity: typeof webActivity;
    };
    const description = (
      tool as unknown as { description: string }
    ).description;

    expect(description).toContain("Only activeNow:true means current activity");
    expect(description).toContain(
      "webviewOpenMinutes is wall-clock open duration",
    );
    expect(result).toEqual({ scholar: "Kai Nakamura", webActivity });
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "get_scholar_web_activity",
        result: "Loaded 1 web session(s) for Kai Nakamura",
      },
    });
  });
});

describe("makeScholarReadTools — role filtering (ACL-scoped aide)", () => {
  test("staff WITH the school:operations grant (the retired registrar role's successor) gets ONLY the non-sensitive roster lookup", async () => {
    const tools = await makeScholarReadTools(
      stubCtx(vi.fn()),
      () => {},
      "staff",
      undefined,
      "",
      undefined,
      undefined,
      true,
    );
    expect(tools.map((t) => t.name)).toEqual(["list_scholars"]);
  });

  test("base staff (no capability grant) gets NO scholar tools", async () => {
    const tools = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "staff");
    expect(tools.map((t) => t.name)).toEqual([]);
  });

  test("teacher/admin get the full set", async () => {
    const asTeacher = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "teacher");
    expect(asTeacher.map((t) => t.name)).toEqual(EXPECTED_NAMES);
    const asAdmin = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "platform_admin");
    expect(asAdmin.map((t) => t.name)).toEqual(EXPECTED_NAMES);
  });

  test("no role fails CLOSED — every stream passes the caller's real role", async () => {
    // The policy (lib/scholarReadPolicy, shared with the OAuth MCP
    // connector) default-denies unknown roles. The old "no role → full
    // set" fallthrough was a fail-open default; all call sites
    // (aideTools, unitDesignerTools, parent chat) pass a real role.
    const tools = await makeScholarReadTools(stubCtx(vi.fn()), () => {});
    expect(tools).toEqual([]);
  });

  test("parent gets ONLY tier-1 tools (mastery/signals/seeds/practice + the public school calendar) — no roster, dossier, docs, observations, sessions", async () => {
    const tools = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "parent");
    expect(tools.map((t) => t.name)).toEqual([
      "get_scholar_mastery",
      "get_scholar_signals",
      "get_scholar_seeds",
      "get_scholar_practice",
      "get_school_calendar",
    ]);
  });
});

describe("get_scholar_math_checkin — lens scoping", () => {
  test("refuses a scholar outside the caller's lens without reading their check-in", async () => {
    // The stub roster deliberately CONTAINS Lani: this proves the refusal comes
    // from the lens set, not from her being absent from the roster query.
    const runQuery = vi.fn().mockResolvedValueOnce(SCHOLARS);
    const emit = vi.fn();
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      emit,
      "teacher",
      new Set(["u_kai" as Id<"users">]),
      "",
      "Moli School",
    );
    const checkInTool = tools.find((t) => t.name === "get_scholar_math_checkin")!;

    const result = await checkInTool.run({ scholarName: "lani" });

    expect(result).toContain("Moli School");
    expect(result).not.toContain("probesAnswered");
    // Only the roster lookup ran — the check-in read was never reached, so an
    // out-of-lens name can't be turned into scholar data.
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  test("reads the check-in for a scholar INSIDE the lens", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(SCHOLARS)
      .mockResolvedValueOnce({
        mapProgress: "partial",
        map: { mappedCount: 1, eligibleCount: 3, allMapped: false, gradeOnFile: true },
        totals: { probesAnswered: 4, domainsStarted: 2, sittingAnswered: 4, sittingBudget: 30, paused: false },
        domains: [],
        currentProbe: null,
        probes: [],
      });
    const emit = vi.fn();
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      emit,
      "teacher",
      new Set(["u_kai" as Id<"users">]),
    );
    const checkInTool = tools.find((t) => t.name === "get_scholar_math_checkin")!;

    const result = await checkInTool.run({ scholarName: "kai" });

    expect(result).toContain('"mapProgress":"partial"');
    expect(runQuery).toHaveBeenNthCalledWith(
      2,
      internal.curriculumAssistant.getScholarMathCheckIn,
      { scholarId: "u_kai" },
    );
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "get_scholar_math_checkin",
        result: "Loaded Kai Nakamura's Math Check-In (map partial, 4 answered probes)",
      },
    });
  });

  test("a parent never receives the check-in transcript tool at all", async () => {
    const tools = await makeScholarReadTools(stubCtx(vi.fn()), () => {}, "parent");
    expect(tools.map((t) => t.name)).not.toContain("get_scholar_math_checkin");
  });

  test("a failed check-in read reports a backend error, never 'no scholar found'", async () => {
    // The tool exists because the aide used to report a live check-in as
    // absent. A query failure for an already-resolved scholar must therefore
    // surface as an operational error — reusing the not-found message would
    // recreate exactly that lie.
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(SCHOLARS)
      .mockRejectedValueOnce(new Error("deployment shape mismatch"));
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      vi.fn(),
      "teacher",
      new Set(["u_kai" as Id<"users">]),
    );
    const checkInTool = tools.find((t) => t.name === "get_scholar_math_checkin")!;

    const result = await checkInTool.run({ scholarName: "kai" });

    expect(result).toContain("could not be loaded");
    expect(result).toContain("NOT a missing check-in");
    expect(result).not.toContain("No scholar found");
  });
});

describe("redactScholarPractice (role-tiered granularity boundary)", () => {
  const full = {
    checkIn: {
      mapProgress: "partial" as const,
      map: {
        mappedCount: 1,
        eligibleCount: 3,
        allMapped: false,
        gradeOnFile: true,
      },
      probesAnsweredToday: 4,
      responsesToday: { correct: 3, incorrect: 1, unknown: 0 },
      domainsToday: [
        {
          domain: "d",
          label: "D",
          status: "in_flight" as const,
          probesAnsweredToday: 4,
          lastProbeAt: 5,
        },
      ],
      heldProbeDomain: "d",
      lastProbeAt: 5,
    },
    strandPlacement: [],
    frontier: [{ nodeKey: "add_within_5", label: "Add within 5", domain: "d" }],
    dueForReview: [
      { nodeKey: "sub_within_5", label: "Subtract within 5", domain: "d" },
    ],
    recentlyCrossed: [
      { nodeKey: "count_to_10", label: "Count to 10", domain: "d", crossedAt: 2 },
    ],
    observerFlaggedMisconceptions: [
      {
        label: "carrying",
        domain: "d",
        observedAt: 1,
        observationId: "obs1" as unknown as import("../_generated/dataModel").Id<"masteryObservations">,
        evidenceSummary: "sensitive",
        transcriptExcerpt: "sensitive quote",
        misconceptionNote: null,
      },
    ],
    counts: {
      frontierCount: 1,
      dueCount: 1,
      recentlyCrossedCount: 1,
      openMisconceptionCount: 1,
      totalPracticedSkills: 1,
    },
  };

  test("teacher/admin keep the full data — misconceptions, backlog, everything", () => {
    const r = redactScholarPractice(full, "teacher");
    expect(r.observerFlaggedMisconceptions).toHaveLength(1);
    expect(r.counts.openMisconceptionCount).toBe(1);
    expect(r.dueForReview).toHaveLength(1);
    expect(r.counts.dueCount).toBe(1);
  });

  test("scholar gets NO misconceptions and NO count, but KEEPS due-for-review (their own actionable question)", () => {
    const r = redactScholarPractice(full, "scholar");
    expect(r.observerFlaggedMisconceptions).toEqual([]);
    expect(r.counts.openMisconceptionCount).toBeUndefined();
    expect(r.dueForReview).toHaveLength(1);
    expect(r.counts.dueCount).toBe(1);
    // the growth signal is untouched
    expect(r.frontier).toHaveLength(1);
  });

  test("only teacher/admin see the check-in's right/wrong split; a parent loses the glance entirely", () => {
    // Teacher/admin: the full glance, scores included.
    expect(redactScholarPractice(full, "teacher").checkIn?.responsesToday).toEqual({
      correct: 3,
      incorrect: 1,
      unknown: 0,
    });
    // Scholar: keeps map progress and how many probes they answered, loses the
    // right/wrong split — a check-in is a map, and an aggregate is still a score.
    const asScholar = redactScholarPractice(full, "scholar").checkIn;
    expect(asScholar?.responsesToday).toBeNull();
    expect(asScholar?.mapProgress).toBe("partial");
    expect(asScholar?.probesAnsweredToday).toBe(4);
    // Parent: no day-level check-in state at all.
    expect(redactScholarPractice(full, "parent").checkIn).toBeNull();
  });

  test("parent additionally loses the spaced-review backlog — growth signal (frontier, recent crossings) preserved for enrichment", () => {
    const r = redactScholarPractice(full, "parent");
    expect(r.observerFlaggedMisconceptions).toEqual([]);
    expect(r.counts.openMisconceptionCount).toBeUndefined();
    expect(r.dueForReview).toEqual([]);
    expect(r.counts.dueCount).toBeUndefined();
    // the forward-looking signal that fuels at-home enrichment stays
    expect(r.frontier).toHaveLength(1);
    expect(r.recentlyCrossed).toHaveLength(1);
    expect(r.counts.frontierCount).toBe(1);
  });
});

describe("makeListScholarGroupsTool", () => {
  test("passes the active scholar lens into the group read", async () => {
    const runQuery = vi.fn().mockResolvedValue([]);
    const allowed = new Set(["u_kai" as Id<"users">]);
    const tool = await makeListScholarGroupsTool(
      stubCtx(runQuery),
      vi.fn(),
      allowed,
    );

    await tool.run({});

    expect(runQuery).toHaveBeenCalledWith(
      internal.curriculumAssistant.listScholarGroupsInternal,
      { includeProgramGuests: false, allowedScholarIds: ["u_kai"] },
    );
  });
});

describe("readScholarMastery (misconception tier boundary)", () => {
  // Stub ctx: readScholarMastery only touches
  // ctx.db.query(...).withIndex(...).collect(), so return the seeded rows.
  function masteryCtx(rows: Array<Record<string, unknown>>): QueryCtx {
    return {
      db: {
        query: () => ({
          withIndex: () => ({ collect: async () => rows }),
        }),
      },
    } as unknown as QueryCtx;
  }

  const scholarId = "u_kai" as unknown as Id<"users">;
  const normal = {
    scholarId,
    domain: "math",
    conceptLabel: "Fractions",
    masteryLevel: 3,
    evidenceSummary: "solid on halves and quarters",
    evidenceType: "direct_demonstration",
    isSuperseded: false,
  };
  const misconception = {
    scholarId,
    domain: "math",
    conceptLabel: "Carrying",
    masteryLevel: 1,
    evidenceSummary: "SENSITIVE misconception evidence text",
    evidenceType: "misconception_signal",
    isSuperseded: false,
  };

  test("teacher/admin see BOTH the normal and the misconception observation", async () => {
    const byDomain = await readScholarMastery(
      masteryCtx([normal, misconception]),
      scholarId,
      "teacher",
    );
    expect(byDomain.math).toHaveLength(2);
    const concepts = byDomain.math.map((o) => o.concept);
    expect(concepts).toContain("Fractions");
    expect(concepts).toContain("Carrying");
    // the sensitive misconception evidence is present for teachers
    expect(byDomain.math.map((o) => o.evidence)).toContain(
      "SENSITIVE misconception evidence text",
    );
  });

  test("scholar sees ONLY the normal observation — misconception stripped, shape unchanged", async () => {
    const byDomain = await readScholarMastery(
      masteryCtx([normal, misconception]),
      scholarId,
      "scholar",
    );
    expect(byDomain.math).toHaveLength(1);
    expect(byDomain.math[0]).toEqual({
      concept: "Fractions",
      level: 3,
      evidence: "solid on halves and quarters",
    });
    // no misconception concept or evidence leaks through
    expect(byDomain.math.map((o) => o.concept)).not.toContain("Carrying");
    expect(JSON.stringify(byDomain)).not.toContain("SENSITIVE");
  });

  test("parent (Tier-1) also sees ONLY the normal observation", async () => {
    const byDomain = await readScholarMastery(
      masteryCtx([normal, misconception]),
      scholarId,
      "parent",
    );
    expect(byDomain.math).toHaveLength(1);
    expect(byDomain.math[0].concept).toBe("Fractions");
    expect(JSON.stringify(byDomain)).not.toContain("SENSITIVE");
  });
});

describe("allowedScholarIds scoping (the parent chokepoint)", () => {
  test("a parent's tool cannot resolve a child outside their guardianship set", async () => {
    // listScholarsInternal returns ALL scholars, but the parent is scoped to
    // only u_kai — so resolving "lani" (a real scholar, not theirs) fails.
    const runQuery = vi.fn().mockResolvedValue(SCHOLARS);
    const emit = vi.fn();
    const allowed = new Set(["u_kai"]) as Set<never>;
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      emit,
      "parent",
      allowed,
    );
    const masteryTool = tools.find((t) => t.name === "get_scholar_mastery")!;

    const otherKid = await masteryTool.run({ scholarName: "lani" });
    expect(otherKid).toContain("No scholar found");
    expect(emit).not.toHaveBeenCalled(); // never reached the data query

    // Their own child resolves fine.
    runQuery.mockResolvedValueOnce(SCHOLARS).mockResolvedValueOnce({});
    const ownKid = await masteryTool.run({ scholarName: "kai" });
    expect(ownKid).toContain("Kai Nakamura");
  });

  test("resolveScholarByName filters to allowedScholarIds", async () => {
    const ctx = stubCtx(vi.fn().mockResolvedValue(SCHOLARS));
    const allowed = new Set(["u_kai"]) as Set<never>;
    expect((await resolveScholarByName(ctx, "kai", allowed))?.id).toBe("u_kai");
    // Lani is a real scholar but not in the allowed set → no match.
    expect(await resolveScholarByName(ctx, "lani", allowed)).toBeNull();
  });
});

describe("institution-lens scoping (the staff aide)", () => {
  // The staff aide reuses the SAME allowedScholarIds chokepoint as the parent
  // path, but additionally passes a `lensLabel` so the roster is scoped, the
  // fail-closed message is lens-aware, and the model can cite the school.
  const ROSTER = {
    scholars: [
      { id: "u_kai", name: "Kai Nakamura", username: "kai", readingLevel: "3rd", sessionCount: 2, observationCount: 1 },
      { id: "u_lani", name: "Lani Kealoha", username: "lani", readingLevel: "4th", sessionCount: 0, observationCount: 0 },
    ],
    extendedEducationOmitted: 0,
  };
  const LENS = "Moli School";

  test("scoped list_scholars excludes out-of-lens scholars and surfaces the active lens", async () => {
    // The lens set is handed DOWN to listScholarsInternal (so the read layer
    // scopes before filtering/counting guests); the mock plays that read
    // layer, returning the already-scoped roster.
    const SCOPED = {
      scholars: ROSTER.scholars.filter((s) => s.id === "u_kai"),
      extendedEducationOmitted: 0,
    };
    const runQuery = vi.fn().mockResolvedValue(SCOPED);
    const emit = vi.fn();
    const allowed = new Set(["u_kai"]) as Set<never>;
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      emit,
      "teacher",
      allowed,
      "",
      LENS,
    );
    const listTool = tools.find((t) => t.name === "list_scholars")! as unknown as {
      run: (input: Record<string, unknown>) => Promise<string>;
      description: string;
    };

    const raw = await listTool.run({});
    const parsed = JSON.parse(raw) as {
      activeInstitutionLens: string;
      scholars: { name: string }[];
    };
    expect(parsed.activeInstitutionLens).toBe(LENS);
    expect(parsed.scholars.map((s) => s.name)).toEqual(["Kai Nakamura"]);
    expect(raw).not.toContain("Lani Kealoha");
    // The lens set rode down into the internal query (with the enrolled-only
    // default stated explicitly).
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      includeProgramGuests: false,
      allowedScholarIds: ["u_kai"],
    });
    expect(emit).toHaveBeenCalledWith({
      toolComplete: { name: "list_scholars", result: "Found 1 scholars" },
    });

    // The description also tells the model the results are lens-scoped.
    expect(listTool.description).toContain(LENS);
  });

  test("named lookup of an out-of-lens scholar fails CLOSED with a lens-aware message", async () => {
    const runQuery = vi.fn().mockResolvedValue(ROSTER);
    const emit = vi.fn();
    const allowed = new Set(["u_kai"]) as Set<never>;
    const tools = await makeScholarReadTools(
      stubCtx(runQuery),
      emit,
      "teacher",
      allowed,
      "",
      LENS,
    );
    const namedTools = [
      tools.find((t) => t.name === "get_scholar_mastery")!,
      tools.find((t) => t.name === "get_scholar_practice")!,
    ];

    // Lani is a real scholar but outside the lens → not resolvable, and the
    // message names the lens + how to widen it (not "doesn't exist").
    for (const tool of namedTools) {
      const other = await tool.run({ scholarName: "lani" });
      expect(other).toContain(LENS);
      expect(other).toContain("institution view");
      expect(other).toContain("?inst=");
      expect(other).not.toContain("No scholar found matching");
    }
    expect(emit).not.toHaveBeenCalled(); // never reached the data query

    // A scholar inside the lens still resolves normally.
    runQuery.mockResolvedValueOnce(ROSTER).mockResolvedValueOnce({});
    const own = await namedTools[0].run({ scholarName: "kai" });
    expect(own).toContain("Kai Nakamura");
  });

  test("no lens (undefined allowedScholarIds/lensLabel) is byte-identical to today", async () => {
    const runQuery = vi.fn().mockResolvedValue(ROSTER);
    const emit = vi.fn();
    // No allowedScholarIds and no lensLabel — the MCP/legacy unscoped path.
    const tools = await makeScholarReadTools(stubCtx(runQuery), emit, "teacher");
    const listTool = tools.find((t) => t.name === "list_scholars")! as unknown as {
      run: (input: Record<string, unknown>) => Promise<string>;
    };
    const masteryTool = tools.find((t) => t.name === "get_scholar_mastery")!;

    // Roster is the bare array (unchanged shape), every scholar included.
    const raw = await listTool.run({});
    const parsed = JSON.parse(raw) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as { name: string }[]).map((s) => s.name)).toEqual([
      "Kai Nakamura",
      "Lani Kealoha",
    ]);

    // Unknown name → the generic, non-lens message.
    const miss = await masteryTool.run({ scholarName: "nobody" });
    expect(miss).toBe('No scholar found matching "nobody".');
  });
});

describe("resolveScholarByName", () => {
  test("case-insensitive partial match", async () => {
    const ctx = stubCtx(vi.fn().mockResolvedValue(SCHOLARS));
    expect((await resolveScholarByName(ctx, "LANI"))?.id).toBe("u_lani");
    expect((await resolveScholarByName(ctx, "naka"))?.id).toBe("u_kai");
  });

  test("returns null when nothing matches", async () => {
    const ctx = stubCtx(vi.fn().mockResolvedValue(SCHOLARS));
    expect(await resolveScholarByName(ctx, "zzz")).toBeNull();
  });

  test("refuses an empty/whitespace name instead of matching the first scholar", async () => {
    const ctx = stubCtx(vi.fn().mockResolvedValue(SCHOLARS));
    expect(await resolveScholarByName(ctx, "")).toBeNull();
    expect(await resolveScholarByName(ctx, "   ")).toBeNull();
  });
});
