import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bandForNode,
  bandProgressLabel,
  cellReadoutWithMarks,
  checkpointBandState,
  checkpointDomainChoices,
  checkpointLabel,
  checkpointSourceLabel,
  domainCellMarks,
  domainCheckState,
  draftProblem,
  joinReadout,
  keepCheckpointInScope,
  markPhrases,
  nextScopeUndo,
  practiceScopeSummary,
  scopeAllowsCheckpoint,
  skillCellMarks,
  toggleDraftDomain,
  toggleDraftStrand,
  widenScopeToAdmit,
  type MathPlanDraft,
  type MathPlanRow,
  type PracticeScope,
} from "./mathPlanProjection";

const OPEN: PracticeScope = { kind: "open" };

function row(overrides: Partial<MathPlanRow> = {}): MathPlanRow {
  return {
    scholarId: "s1",
    practiceScope: OPEN,
    scopeSource: "math_plan",
    checkpoint: null,
    conflict: false,
    mode: "toward",
    bandSolid: 0,
    bandTotal: 0,
    ...overrides,
  };
}

const labels = {
  domainLabel: (domain: string) => `Domain ${domain}`,
  strandLabel: (strand: string) => `Strand ${strand}`,
};

describe("domainCellMarks", () => {
  it("marks nothing for an open plan with no checkpoint", () => {
    expect(domainCellMarks(row(), "fractions")).toEqual({
      outOfScope: false,
      checkpoint: null,
    });
  });

  it("slashes whole-domain cells a limited plan does not include", () => {
    const plan = row({
      practiceScope: { kind: "limited", domains: [{ domain: "fractions" }] },
    });
    expect(domainCellMarks(plan, "fractions").outOfScope).toBe(false);
    expect(domainCellMarks(plan, "geometry").outOfScope).toBe(true);
  });

  it("counts a strand-restricted domain as in scope at domain altitude", () => {
    const plan = row({
      practiceScope: {
        kind: "limited",
        domains: [{ domain: "fractions", strands: ["compare"] }],
      },
    });
    expect(domainCellMarks(plan, "fractions").outOfScope).toBe(false);
  });

  it("corners only the checkpoint's own domain, in its derived mode", () => {
    const plan = row({
      mode: "deeper",
      checkpoint: {
        domain: "fractions",
        grade: "5",
        source: "teacher",
      },
    });
    expect(domainCellMarks(plan, "fractions").checkpoint).toBe("deeper");
    expect(domainCellMarks(plan, "geometry").checkpoint).toBeNull();
  });

  it("keeps BOTH marks on a conflict and drops the mode reading", () => {
    const plan = row({
      practiceScope: { kind: "limited", domains: [{ domain: "geometry" }] },
      conflict: true,
      mode: "toward",
      checkpoint: { domain: "fractions", grade: "5", source: "group" },
    });
    expect(domainCellMarks(plan, "fractions")).toEqual({
      outOfScope: true,
      checkpoint: "conflict",
    });
  });

  it("marks nothing when the scholar has no row yet", () => {
    expect(domainCellMarks(undefined, "fractions")).toEqual({
      outOfScope: false,
      checkpoint: null,
    });
  });
});

describe("skillCellMarks", () => {
  const compare = { strand: "compare", grade: "5" };
  const add = { strand: "add", grade: "5" };
  const compareG4 = { strand: "compare", grade: "4" };

  it("slashes every skill in a strand the plan leaves out", () => {
    const plan = row({
      practiceScope: {
        kind: "limited",
        domains: [{ domain: "fractions", strands: ["compare"] }],
      },
    });
    expect(skillCellMarks(plan, "fractions", compare).outOfScope).toBe(false);
    expect(skillCellMarks(plan, "fractions", add).outOfScope).toBe(true);
  });

  it("slashes every skill of a domain that is out of scope entirely", () => {
    const plan = row({
      practiceScope: { kind: "limited", domains: [{ domain: "geometry" }] },
    });
    expect(skillCellMarks(plan, "fractions", compare).outOfScope).toBe(true);
  });

  it("corners every target-grade skill for a whole-domain checkpoint", () => {
    const plan = row({
      checkpoint: { domain: "fractions", grade: "5", source: "teacher" },
    });
    expect(skillCellMarks(plan, "fractions", compare).checkpoint).toBe("toward");
    expect(skillCellMarks(plan, "fractions", add).checkpoint).toBe("toward");
    expect(skillCellMarks(plan, "fractions", compareG4).checkpoint).toBeNull();
  });

  it("keeps the flag visible, in its suspended reading, when the plan conflicts", () => {
    const plan = row({
      conflict: true,
      checkpoint: {
        domain: "fractions",
        strand: "compare",
        grade: "5",
        source: "teacher",
      },
      practiceScope: { kind: "limited", domains: [{ domain: "geometry" }] },
    });
    // BOTH marks stay: scope is the runtime boundary, so the checkpoint is
    // suspended rather than silently unmarked.
    expect(skillCellMarks(plan, "fractions", compare)).toEqual({
      outOfScope: true,
      checkpoint: "conflict",
    });
  });

  it("narrows the corner to one strand for a strand checkpoint", () => {
    const plan = row({
      checkpoint: {
        domain: "fractions",
        strand: "compare",
        grade: "5",
        source: "group",
        groupName: "Group A",
      },
    });

    expect(skillCellMarks(plan, "fractions", compare).checkpoint).toBe("toward");
    expect(skillCellMarks(plan, "fractions", add).checkpoint).toBeNull();
  });
});

describe("checkpoint-band projection", () => {
  const unstranded = { strand: null, grade: "5" };
  const compare = { strand: "compare", grade: "5" };
  const add = { strand: "add", grade: "5" };
  const compareG4 = { strand: "compare", grade: "4" };
  const ungraded = { strand: "compare", grade: null };

  it("builds a band exactly when its node is graded", () => {
    expect(bandForNode("fractions", unstranded)).toEqual({
      domain: "fractions",
      grade: "5",
    });
    expect(bandForNode("fractions", compare)).toEqual({
      domain: "fractions",
      strand: "compare",
      grade: "5",
    });
    expect(bandForNode("fractions", ungraded)).toBeNull();
  });

  it("covers every state in precedence order", () => {
    expect(checkpointBandState(undefined, "fractions", compare)).toBeNull();
    expect(
      checkpointBandState(row({ conflict: true }), "fractions", ungraded),
    ).toEqual({ kind: "no-grade" });
    expect(
      checkpointBandState(row({ conflict: true }), "fractions", compare),
    ).toEqual({ kind: "blocked", reason: "conflict" });
    expect(
      checkpointBandState(
        row({ practiceScope: { kind: "limited", domains: [] } }),
        "fractions",
        compare,
      ),
    ).toEqual({ kind: "blocked", reason: "empty-limited-scope" });
    expect(checkpointBandState(row(), "fractions", compare)).toEqual({
      kind: "settable",
      checkpoint: { domain: "fractions", strand: "compare", grade: "5" },
    });
    expect(
      checkpointBandState(
        row({
          checkpoint: { domain: "geometry", grade: "5", source: "teacher" },
        }),
        "fractions",
        compare,
      ),
    ).toEqual({
      kind: "elsewhere",
      inherited: false,
      checkpoint: { domain: "geometry", grade: "5" },
    });
  });

  it("widens on the BAND's own axis, and reports what the scope excludes", () => {
    const domainOut: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "geometry" }],
    };
    // A strand band admits ONE strand even when the whole domain is unserved —
    // that is exactly what `widenScopeToAdmit` writes, so it is what the caller
    // may name.
    expect(
      checkpointBandState(row({ practiceScope: domainOut }), "fractions", compare),
    ).toEqual({
      kind: "out-of-scope",
      checkpoint: { domain: "fractions", strand: "compare", grade: "5" },
      widen: "strand",
      excluded: "domain",
    });
    expect(
      widenScopeToAdmit(domainOut, { domain: "fractions", strand: "compare" }),
    ).toEqual({
      kind: "limited",
      domains: [{ domain: "geometry" }, { domain: "fractions", strands: ["compare"] }],
    });

    expect(
      checkpointBandState(
        row({
          practiceScope: {
            kind: "limited",
            domains: [{ domain: "fractions", strands: ["add"] }],
          },
        }),
        "fractions",
        compare,
      ),
    ).toEqual({
      kind: "out-of-scope",
      checkpoint: { domain: "fractions", strand: "compare", grade: "5" },
      widen: "strand",
      excluded: "strand",
    });

    // Only a WHOLE-DOMAIN band widens the whole domain.
    expect(
      checkpointBandState(
        row({ practiceScope: domainOut }),
        "fractions",
        unstranded,
      ),
    ).toEqual({
      kind: "out-of-scope",
      checkpoint: { domain: "fractions", grade: "5" },
      widen: "domain",
      excluded: "domain",
    });
    expect(widenScopeToAdmit(domainOut, { domain: "fractions" })).toEqual({
      kind: "limited",
      domains: [{ domain: "geometry" }, { domain: "fractions" }],
    });
  });

  it("passes the stored mode through and distinguishes inherited checkpoints", () => {
    expect(
      checkpointBandState(
        row({
          mode: "deeper",
          checkpoint: {
            domain: "fractions",
            strand: "compare",
            grade: "5",
            source: "teacher",
          },
        }),
        "fractions",
        compare,
      ),
    ).toEqual({
      kind: "current",
      checkpoint: { domain: "fractions", strand: "compare", grade: "5" },
      mode: "deeper",
    });
    expect(
      checkpointBandState(
        row({
          mode: "toward",
          checkpoint: {
            domain: "fractions",
            strand: "compare",
            grade: "5",
            source: "group",
          },
        }),
        "fractions",
        compare,
      ),
    ).toEqual({
      kind: "inherited-current",
      checkpoint: { domain: "fractions", strand: "compare", grade: "5" },
      mode: "toward",
    });
  });

  it("round-trips: setting the band a node names flags that node and its siblings", () => {
    for (const node of [compare, unstranded]) {
      const band = bandForNode("fractions", node)!;
      const plan = row({ checkpoint: { ...band, source: "teacher" as const } });

      // The node that NAMED the band reads as the current checkpoint…
      expect(checkpointBandState(plan, "fractions", node)).toMatchObject({
        kind: "current",
        checkpoint: band,
      });
      // …and wears the flag, as does every sibling the band actually covers.
      expect(skillCellMarks(plan, "fractions", node).checkpoint).toBe("toward");
      expect(skillCellMarks(plan, "fractions", add).checkpoint).toBe(
        band.strand === undefined ? "toward" : null,
      );
      // Never a different grade, and never another domain.
      expect(skillCellMarks(plan, "fractions", compareG4).checkpoint).toBeNull();
      expect(skillCellMarks(plan, "geometry", node).checkpoint).toBeNull();
    }
  });

  it("keeps the cell mark and the band state consistent: a marked cell is in the band, the naming cell owns it", () => {
    const plans = [
      row(),
      row({ conflict: true }),
      row({ practiceScope: { kind: "limited", domains: [] } }),
      row({
        practiceScope: { kind: "limited", domains: [{ domain: "geometry" }] },
      }),
      row({
        checkpoint: {
          domain: "fractions",
          strand: "compare",
          grade: "5",
          source: "teacher",
        },
      }),
      row({
        checkpoint: {
          domain: "fractions",
          strand: "compare",
          grade: "5",
          source: "group",
        },
      }),
      row({ checkpoint: { domain: "fractions", grade: "5", source: "teacher" } }),
      row({ checkpoint: { domain: "geometry", grade: "5", source: "teacher" } }),
    ];
    for (const plan of plans) {
      for (const node of [compare, add, unstranded, compareG4, ungraded]) {
        const state = checkpointBandState(plan, "fractions", node);
        const marked = skillCellMarks(plan, "fractions", node).checkpoint !== null;
        // "This band IS the checkpoint" implies the cell is marked; the
        // converse does not hold, because a whole-domain checkpoint marks
        // strands whose OWN band is narrower than it.
        if (state?.kind === "current" || state?.kind === "inherited-current") {
          expect(marked).toBe(true);
        }
        if (marked) {
          expect(plan.checkpoint?.domain).toBe("fractions");
          expect(plan.checkpoint?.grade).toBe(node.grade);
        }
      }
    }
  });
});

it("never corners a different domain's skills", () => {
  const plan = row({
    checkpoint: { domain: "geometry", grade: "5", source: "teacher" },
  });
  expect(skillCellMarks(plan, "fractions", { strand: "compare", grade: "5" }).checkpoint).toBeNull();
});

describe("readouts", () => {
  it("does not double terminators when joining fragments", () => {
    expect(joinReadout("Ada · fluent.", "checkpoint, working toward")).toBe(
      "Ada · fluent. checkpoint, working toward",
    );
    expect(joinReadout("Ada", null, undefined, "  ")).toBe("Ada");
  });

  it("states both marks in words, never colour alone", () => {
    expect(markPhrases({ outOfScope: true, checkpoint: "deeper" })).toEqual([
      "out of practice scope",
      "checkpoint, going deeper",
    ]);
    expect(markPhrases({ outOfScope: true, checkpoint: "conflict" })).toEqual([
      "out of practice scope",
      "checkpoint suspended, needs attention",
    ]);
  });

  it("appends the control's own action last", () => {
    expect(
      cellReadoutWithMarks(
        "Ada · grade 4.2",
        { outOfScope: true, checkpoint: null },
        "Show detail",
      ),
    ).toBe("Ada · grade 4.2. out of practice scope. Show detail");
  });
});

describe("plan summaries", () => {
  it("names the exact included domains and strands, never a count", () => {
    const summary = practiceScopeSummary(
      {
        kind: "limited",
        domains: [
          { domain: "fractions", strands: ["compare"] },
          { domain: "geometry" },
        ],
      },
      labels,
    );
    expect(summary).toEqual({
      kind: "limited",
      entries: [
        {
          domain: "fractions",
          label: "Domain fractions",
          strandLabels: ["Strand compare"],
        },
        { domain: "geometry", label: "Domain geometry", strandLabels: null },
      ],
    });
  });

  it("labels the checkpoint and its source", () => {
    expect(
      checkpointLabel({ domain: "fractions", strand: "compare", grade: "5" }, labels),
    ).toBe("Domain fractions · Strand compare · grade 5");
    expect(
      checkpointSourceLabel({
        domain: "fractions",
        grade: "5",
        source: "group",
        groupName: "Rockets",
      }),
    ).toBe("Math group Rockets");
    expect(
      checkpointSourceLabel({ domain: "fractions", grade: "5", source: "teacher" }),
    ).toBe("Scholar override");
  });

  it("reports band progress honestly when the band is empty", () => {
    expect(bandProgressLabel(row({ bandSolid: 0, bandTotal: 0 }))).toBe(
      "No skills in this band yet",
    );
    expect(bandProgressLabel(row({ bandSolid: 1, bandTotal: 1 }))).toBe(
      "1 of 1 skill in the band is fluent",
    );
    expect(bandProgressLabel(row({ bandSolid: 3, bandTotal: 9 }))).toBe(
      "3 of 9 skills in the band are fluent",
    );
  });
});

describe("editor draft", () => {
  it("refuses an empty limited scope", () => {
    expect(
      draftProblem({ scope: { kind: "limited", domains: [] }, checkpoint: null }),
    ).toEqual({ kind: "emptyScope" });
    expect(
      draftProblem({
        scope: { kind: "limited", domains: [{ domain: "fractions", strands: [] }] },
        checkpoint: null,
      }),
    ).toEqual({ kind: "emptyScope" });
  });

  it("blocks a checkpoint the draft scope would exclude", () => {
    expect(
      draftProblem({
        scope: { kind: "limited", domains: [{ domain: "geometry" }] },
        checkpoint: { domain: "fractions", grade: "5" },
      }),
    ).toEqual({ kind: "checkpointOutOfScope", domain: "fractions" });
  });

  it("requires the WHOLE domain for a whole-domain checkpoint", () => {
    const partial: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "fractions", strands: ["compare"] }],
    };
    expect(scopeAllowsCheckpoint(partial, { domain: "fractions" })).toBe(false);
    expect(
      scopeAllowsCheckpoint(partial, { domain: "fractions", strand: "compare" }),
    ).toBe(true);
    expect(
      scopeAllowsCheckpoint(partial, { domain: "fractions", strand: "add" }),
    ).toBe(false);
  });

  it("reads a domain as three-state", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [
        { domain: "fractions" },
        { domain: "geometry", strands: ["angles"] },
      ],
    };
    expect(domainCheckState(scope, "fractions")).toBe("checked");
    expect(domainCheckState(scope, "geometry")).toBe("indeterminate");
    expect(domainCheckState(scope, "measurement")).toBe("unchecked");
    expect(domainCheckState(OPEN, "measurement")).toBe("checked");
  });

  it("checking a whole domain clears its strand restriction", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "fractions", strands: ["compare"] }],
    };
    expect(toggleDraftDomain(scope, "fractions", true)).toEqual({
      kind: "limited",
      domains: [{ domain: "fractions" }],
    });
    expect(toggleDraftDomain(scope, "fractions", false)).toEqual({
      kind: "limited",
      domains: [],
    });
  });

  it("unchecking one strand demotes a whole domain to its remaining strands", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "fractions" }],
    };
    expect(
      toggleDraftStrand(scope, "fractions", "add", false, ["compare", "add"]),
    ).toEqual({
      kind: "limited",
      domains: [{ domain: "fractions", strands: ["compare"] }],
    });
  });

  it("re-checking the last strand promotes the domain back to whole", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "fractions", strands: ["compare"] }],
    };
    expect(
      toggleDraftStrand(scope, "fractions", "add", true, ["compare", "add"]),
    ).toEqual({ kind: "limited", domains: [{ domain: "fractions" }] });
  });

  it("drops the domain when its last strand is unchecked", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [
        { domain: "fractions", strands: ["compare"] },
        { domain: "geometry" },
      ],
    };
    expect(
      toggleDraftStrand(scope, "fractions", "compare", false, [
        "compare",
        "add",
      ]),
    ).toEqual({ kind: "limited", domains: [{ domain: "geometry" }] });
  });
});

// ── Marks, rail, and editor wiring ────────────────────────────────────────────
// The repo's vitest project only collects `*.test.ts`, so React output is
// asserted against source text (the same idiom as `MathSkillsMasteryView.test.ts`).
const here = __dirname;
const marksSource = readFileSync(join(here, "MathPlanMarks.tsx"), "utf8");
const railSource = readFileSync(join(here, "MathPlanRailSection.tsx"), "utf8");
const editorSource = readFileSync(join(here, "EditMathPlanDialog.tsx"), "utf8");

describe("MathPlanMarks", () => {
  it("draws the slash as a 0.5px hairline from top-right to bottom-left", () => {
    expect(marksSource).toMatch(/strokeWidth="0\.5"/);
    expect(marksSource).toMatch(/x1="100%"\s+y1="0"\s+x2="0"\s+y2="100%"/);
  });

  it("masks a centre keep-out so the slash cannot read as a mastery arc", () => {
    expect(marksSource).toMatch(/<mask id=\{maskId\}>/);
    expect(marksSource).toMatch(/circle cx="50%" cy="50%" r=\{keepOutD \/ 2\}/);
    expect(marksSource).toMatch(/SLASH_KEEP_OUT_D = 38/);
  });

  it("carries the same checkered flag in every checkpoint mark", () => {
    const flags = marksSource.match(/<FlagCheckered/g) ?? [];
    expect(flags.length).toBeGreaterThanOrEqual(3);
    expect(marksSource).not.toMatch(/🏁/);
  });

  it("flushes the corner to the cell's top-left at ~15px", () => {
    expect(marksSource).toMatch(/size = 15/);
    expect(marksSource).toMatch(/top=\{0\}\s+left=\{0\}/);
  });

  it("exports the corner's tile as the one off-cell checkpoint mark", () => {
    // Off-cell surfaces (legend, pills, actions) must have a mark to reuse, or
    // they reach for a bare flag glyph — see `__tests__/checkpointMark.test.ts`.
    expect(marksSource).toContain("export function CheckpointMark(");
    expect(marksSource).toMatch(/state = "toward"/);
  });

  it("gives a suspended checkpoint its own state instead of a mode hue", () => {
    expect(marksSource).toMatch(/conflict: \{ bg: "#fbdcdc", color: "#9b2c2c" \}/);
  });
});

describe("MathPlanRailSection", () => {
  it("shows both authored controls behind one click target", () => {
    expect(railSource).toContain("Practice scope");
    expect(railSource).toContain("Checkpoint");
    expect(railSource).toContain('aria-label="View or edit math plan"');
  });

  it("has no disclosure left to get out of step with the editor", () => {
    expect(railSource).not.toContain("Collapsible");
    expect(railSource).not.toContain("math-plan-disclosure");
    expect(railSource).not.toContain("useState");
  });

  it("keeps the All-domains card a summary — no prose, no source tag, no list", () => {
    // Body only — the file's own header comment describes the design.
    const body = railSource.slice(railSource.indexOf("import "));
    expect(body).not.toContain("Authored");
    expect(body).not.toContain("Every domain and strand");
    expect(body).not.toContain("Anything unchecked");
    expect(body).not.toContain("checkpointSourceLabel");
    expect(body).not.toContain("bandProgressLabel");
    expect(body).not.toContain("scope.entries.map");
    // Counted, not named — the domain names live one click away in the editor.
    expect(body).toMatch(/Limited · \$\{scope\.entries\.length\}/);
  });

  it("states needs-attention in the summary, with no second repair action", () => {
    expect(railSource).toContain("Needs attention");
    // A conflicted checkpoint reads as suspended rather than wearing a mode.
    expect(railSource).toContain("suspended={plan.conflict}");
    // The editor IS the repair — a nested repair button would both duplicate
    // the section's own gesture and put a button inside a button.
    expect(railSource).not.toContain("Fix the Math plan");
    expect(railSource).not.toContain("math-plan-repair");
    expect(
      (railSource.match(/as="button"|<chakra\.button/g) ?? []).length,
    ).toBe(1);
  });

  it("adds no mastery, mapping, placement, or focus-next vocabulary", () => {
    // Body only — the file's own header comment names what it deliberately omits.
    const body = railSource.slice(railSource.indexOf("import "));
    expect(body).not.toMatch(/Focus next|Placement|Provisional|Excluded/i);
  });
});

describe("EditMathPlanDialog", () => {
  it("saves both controls through one atomic mutation", () => {
    expect(editorSource).toContain("api.mathPlans.saveForScholar");
    expect(editorSource).toMatch(/practiceScope: draft\.scope/);
    expect(editorSource).toMatch(/checkpoint: draft\.checkpoint/);
    expect((editorSource.match(/await save\(/g) ?? []).length).toBe(1);
  });

  it("blocks the save on an invalid draft instead of resolving it silently", () => {
    expect(editorSource).toContain("disabled={!draft || !!problem || saving}");
    expect(editorSource).toContain("Keep it in scope");
    expect(editorSource).toContain("Move checkpoint");
    expect(editorSource).toContain("Clear checkpoint");
  });

  it("keeps mode derived and read-only", () => {
    expect(editorSource).toMatch(/Mode is derived from band fluency/);
    expect(editorSource).not.toMatch(/onChange.*mode|setMode/);
  });

  it("explains that clearing an inherited checkpoint is scholar-only", () => {
    expect(editorSource).toMatch(
      /cleared for this scholar only — the group keeps its own/,
    );
    expect(editorSource).toContain("scholar override");
  });

  it("reports save failures rather than closing on error", () => {
    expect(editorSource).toContain('data-testid="math-plan-error"');
    expect(editorSource).toContain("Could not save the Math plan.");
  });

  it("derives the draft from the stored plan rather than syncing it in an effect", () => {
    expect(editorSource).not.toContain("useEffect");
    expect(editorSource).toMatch(/const draft = edit \?\? seeded;/);
  });

  it("offers only checkpoint targets the DRAFT scope allows", () => {
    const catalog = [
      {
        domain: "fractions",
        label: "Fractions",
        grades: ["4", "5"],
        strands: [
          { strand: "equivalence", label: "Equivalence", grades: ["4"] },
          { strand: "operations", label: "Operations", grades: ["5"] },
        ],
      },
      {
        domain: "algebra-1",
        label: "Algebra 1",
        grades: ["8"],
        strands: [{ strand: "linear", label: "Linear", grades: ["8"] }],
      },
    ];
    const draft: MathPlanDraft = {
      scope: { kind: "limited", domains: [{ domain: "algebra-1" }] },
      checkpoint: { domain: "algebra-1", grade: "8" },
    };

    const selectable = checkpointDomainChoices(draft, catalog)
      .filter((entry) => entry.value !== "" && !entry.outOfScope)
      .map((entry) => entry.value);
    expect(selectable).toEqual(["algebra-1"]);
  });

  it("keeps a conflicted checkpoint's DOMAIN visible and unselectable so the repair path can read it", () => {
    const catalog = [
      {
        domain: "fractions",
        label: "Fractions",
        grades: ["5"],
        strands: [{ strand: "operations", label: "Operations", grades: ["5"] }],
      },
      {
        domain: "algebra-1",
        label: "Algebra 1",
        grades: ["8"],
        strands: [{ strand: "linear", label: "Linear", grades: ["8"] }],
      },
    ];
    // The plan ARRIVED conflicted: the scope excludes its own checkpoint.
    const draft: MathPlanDraft = {
      scope: { kind: "limited", domains: [{ domain: "algebra-1" }] },
      checkpoint: { domain: "fractions", strand: "operations", grade: "5" },
    };

    const held = checkpointDomainChoices(draft, catalog).find(
      (entry) => entry.value === "fractions",
    );
    // Present, so the native <select> shows it instead of falling back to its
    // first option ("No checkpoint") and hiding the target being repaired.
    expect(held).toBeDefined();
    expect(held?.outOfScope).toBe(true);
    expect(held?.label).toContain("out of scope");
    // The held band ITSELF needs no such workaround any more: the band grid
    // draws it in place, slashed and unselectable (see the grid's own tests).
  });

  it("keeps the checkpoint in scope on the repair path, where there is no edit to undo", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "algebra-1" }],
    };
    const target = { domain: "fractions", strand: "operations" };

    // No undo point (the draft arrived broken) — widen instead of no-op.
    const widened = keepCheckpointInScope(scope, target, null);
    expect(scopeAllowsCheckpoint(widened, target)).toBe(true);

    // A second breaking edit must not clobber the undo point with a broken scope.
    const draft: MathPlanDraft = {
      scope: { kind: "limited", domains: [{ domain: "algebra-1" }] },
      checkpoint: { domain: "fractions", strand: "operations", grade: "5" },
    };
    const good: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "fractions" }],
    };
    expect(
      nextScopeUndo(draft, { kind: "limited", domains: [] }, good),
    ).toEqual(good);
  });
});
