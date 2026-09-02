import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./MathSkillsMasteryView.tsx", import.meta.url)),
  "utf8",
);

describe("MathSkillsMasteryView scholar header geometry", () => {
  it("keeps ONE header height, whatever the cohort's checkpoint standing", () => {
    // The checkpoint rides the heading as a non-flow corner, so nothing about
    // it can resize the sticky header row — and the strand rows stick to that
    // same single constant, so the two can never disagree.
    expect(source).not.toContain("SCHOLAR_HEADER_H_WITH_CHECKPOINT_MODE");
    expect(source).not.toMatch(/h=\{\s*checkpointModeRollup/);
    expect(source).not.toMatch(/top=\{\s*checkpointModeRollup/);
    expect(source).toContain("h={SCHOLAR_HEADER_H}");
    expect(source).toContain("top={SCHOLAR_HEADER_H}");
    expect(source).not.toContain('"94px"');
  });
});

describe("the Math plan in the matrix", () => {
  it("reads both authored controls for EVERY visible scholar, not just a scoped group", () => {
    expect(source).toContain("api.mathPlans.forScholars");
    expect(source).toMatch(
      /api\.mathPlans\.forScholars,[\s\S]*?scholarIds: queryScholars\.map\(\(scholar\) => scholar\.id as Id<"users">\)/,
    );
    // The old group-gated mode query is gone, along with the whole per-skill
    // nodeKey checkpoint pathway it belonged to.
    expect(source).not.toContain("checkpointModesForScope");
    expect(source).not.toContain("checkpointFlagsForScope");
    expect(source).not.toContain("setScholarCheckpointOverride");
    expect(source).not.toContain("clearScholarCheckpointOverride");
    expect(source).not.toContain("CheckpointFlag");
    // A checkpoint is a band, never one skill — no nodeKey reaches a checkpoint call.
    expect(source).not.toContain("handleToggleCheckpoint");
    expect(source).not.toContain("checkpointNodeKey");
  });

  it("projects the two marks through the one shared projection module", () => {
    expect(source).toContain('from "@/components/practice/mathPlanProjection"');
    expect(source).toContain("domainCellMarks(");
    expect(source).toContain("skillCellMarks(");
    expect(source).toMatch(/<CheckpointCorner state=\{planMarks\.checkpoint\} \/>/);
    expect(source).toMatch(/<OutOfScopeSlash \/>/);
  });

  it("keeps the slash clear of the mastery dial at skill altitude only", () => {
    expect(source).toMatch(/keepOutD=\{mark \? SLASH_KEEP_OUT_D : 0\}/);
  });

  it("states both marks in the cell's accessible name without doubling punctuation", () => {
    // Four cells, plus the scholar column heading — which speaks its checkpoint
    // through the SAME joiner, so a column and its cells say it in one wording.
    expect((source.match(/cellReadoutWithMarks\(/g) ?? []).length).toBe(5);
    expect(source).not.toMatch(/\$\{visual\.readout\}\.\$\{/);
  });

  it("routes per-scholar checkpoint authoring through the panel control and the editor, group setting through the pill", () => {
    expect(source).toContain("groupCheckpointEditable");
    expect(source).toMatch(
      /const groupCheckpointEditable =\s*!!checkpointGroupId && !effectiveScholarId;/,
    );
    expect(source).toContain("CHECKPOINT_SCHOLAR_HINT");
    expect(source).toContain("<EditMathPlanDialog");
    expect(source).toContain("<MathPlanRailSection");
    // The per-cell control owns its own write, so the view itself still holds
    // no per-scholar checkpoint mutation of any kind.
    expect(source).toContain("<CheckpointBandControl");
    expect(source).not.toContain("mathPlans.saveForScholar");
  });

  it("counts a suspended checkpoint as needing attention, never as a mode", () => {
    expect(source).toMatch(/if \(row\.conflict\) needsAttention \+= 1;/);
  });

  // The rendered click path — scholar drawer → the math plan section → a live
  // editor — is covered in `__tests__/mathPlanEditorFromDrawer.test.ts`. These
  // two hold for the branches that test cannot reach (Map view's node drawer),
  // where the same two mistakes are equally available.
  it("mounts the ONE editor in every branch that hands the rail an onEdit", () => {
    const mounts = [...source.matchAll(/\{editMathPlanDialog\}/g)].map(
      (match) => match.index,
    );
    // One element, shared by both branches — not two copies free to drift.
    expect(source.match(/<EditMathPlanDialog/g) ?? []).toHaveLength(1);
    expect(mounts).toHaveLength(2);
    // …and each branch mounts it AFTER the rail it wires an onEdit into, so a
    // branch can never render the button without the surface it opens.
    const allDomainsRail = source.indexOf("mathPlan={renderMathPlanFor(");
    const defaultBranchRail = source.indexOf("mathPlanFor={renderMathPlanFor}");
    expect(allDomainsRail).toBeGreaterThan(-1);
    expect(allDomainsRail).toBeLessThan(mounts[0]!);
    expect(mounts[0]!).toBeLessThan(defaultBranchRail);
    expect(defaultBranchRail).toBeLessThan(mounts[1]!);
  });

  it("suspends every drawer that can host the rail while the editor is open", () => {
    // A modal drawer holds the focus trap and marks everything below it inert,
    // so the editor — portalled as the drawer's sibling — must never open
    // underneath one. Split on the drawers rather than counting them: the rule
    // is "whichever drawers host the rail", so a new drawer must either carry
    // the guard or provably host no rail.
    const drawers = source
      .split("<Drawer.Root")
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf("</Drawer.Root>")));
    expect(drawers.length).toBeGreaterThan(0);
    const hostsRail = (chunk: string) =>
      /mathPlanFor=|allDomainsDetailBody/.test(chunk);
    const railDrawers = drawers.filter(hostsRail);
    // The all-domains scholar drawer and the Map node drawer.
    expect(railDrawers).toHaveLength(2);
    for (const chunk of railDrawers) {
      const openProp = chunk.slice(0, chunk.indexOf("onOpenChange="));
      expect(openProp).toContain("!editPlanScholarId");
    }
    // Fast math's drawer hosts no plan rail, so it needs no guard — but it must
    // stay that way for that to remain true.
    const fastMathDrawer = drawers.find((chunk) =>
      chunk.includes("fastMathDetailBody"),
    );
    expect(fastMathDrawer).toBeDefined();
    expect(hostsRail(fastMathDrawer!)).toBe(false);
  });

  it("keeps the plan compact everywhere except All domains × scholar", () => {
    // The plan is the SUBJECT at all-domains scholar focus and CONTEXT below
    // it, so the default is the one-line summary and exactly one call site
    // opts into the fuller one. Both are the same single click target.
    expect(source).toContain("options?: { compact?: boolean }");
    expect(source).toContain("compact={options?.compact ?? true}");
    expect(source.match(/compact: false/g) ?? []).toHaveLength(1);
    // …and that one opt-out is the all-domains scholar panel.
    expect(source).toMatch(
      /<AllDomainsScholarDetail[\s\S]*?compact: false[\s\S]*?\/>/,
    );
  });
});

describe("the All-domains scholar-only focus", () => {
  it("records WHICH surface selected the scholar, so only that one highlights", () => {
    // The column heading and the "Across all math" cell open the same panel.
    // Without a source on the selection, `domain: null` matches both and a
    // click on either lights up both.
    expect(source).toContain("type AllDomainsFocusSource");
    expect(source).toMatch(/source: AllDomainsFocusSource;/);
    expect(source).toMatch(
      /handleSelectAllDomainsScholar = \(\s*scholarId: string,\s*source: Exclude<AllDomainsFocusSource, null>,/,
    );
    // Toggling off requires the SAME source, so clicking the other surface
    // moves the highlight instead of clearing the selection.
    expect(source).toMatch(/current\.source === source\s*\?\s*null/);
    // Each surface tests its own source.
    expect(source).toContain('allDomainsFocus?.source === "header"');
    expect(source).toContain('allDomainsFocus?.source === "summary"');
    expect(source).toContain('handleSelectAllDomainsScholar(scholar.id, "header")');
    expect(source).toContain('handleSelectAllDomainsScholar(scholar.id, "summary")');
    // A domain (or Fast math) focus has exactly one surface, so it carries none.
    expect((source.match(/source: null/g) ?? []).length).toBe(3);
  });

  it("keeps the source while stepping scholars, so the highlight does not jump surfaces", () => {
    expect(source).toMatch(/source: current\?\.source \?\? "header"/);
  });
});

describe("the all-domains Fast math row", () => {
  it("renders one bounded cohort query, not a per-scholar fanout", () => {
    expect(source).toMatch(/fastMathForScholars/);
    expect(source).toMatch(
      /scholarIds:\s*queryScholars\.map\(\(scholar\)\s*=>\s*scholar\.id as Id<"users">\)/,
    );
    // Only fetched where the row renders.
    expect(source).toMatch(/rosterLoading \|\| !allDomains\s*\n?\s*\?\s*"skip"/);
  });

  it("sits beside the domain rows at the same cell pitch and label column", () => {
    const row = source.slice(source.indexOf('data-testid="mastery-fastmath-row"'));
    expect(source).toContain('data-testid="mastery-fastmath-row"');
    expect(source).toContain("mastery-fastmath-cell-${scholar.id}");
    // The row shares the domain rows' grid template and 44px cell height.
    expect(row).toContain("h={MATRIX_CELL_H}");
  });

  it("draws NO grade-level wash — a per cent has no place on the age-relative scale", () => {
    const start = source.indexOf("Fast math — the ONE row");
    const end = source.indexOf("Across-all-math summary row", start);
    const row = source.slice(start, end);
    expect(row).not.toContain("matrixCellVisual");
    expect(row).not.toContain("masteryLevelTint");
    expect(row).not.toContain("visual.bg");
  });

  it("reuses the mastery palette for readiness rather than inventing a hue", () => {
    const start = source.indexOf("Fast math — the ONE row");
    const end = source.indexOf("Across-all-math summary row", start);
    const row = source.slice(start, end);
    expect(row).toContain("MASTERY_DOT_COLOR.overlearned");
    expect(row).toContain("MASTERY_DOT_COLOR.fluent");
  });

  it("opens the dedicated Fast math family view", () => {
    expect(source).toContain("FAST_MATH_DOMAIN");
    const start = source.indexOf("Fast math — the ONE row");
    const end = source.indexOf("Across-all-math summary row", start);
    const row = source.slice(start, end);
    expect(row).toContain("onSelectDomain(FAST_MATH_DOMAIN)");
    expect(row).not.toContain("onOpenReport(scholar.id)");
  });

  it("sits above the Across all math aggregate, which names the exclusion", () => {
    const fastMath = source.indexOf('data-testid="mastery-fastmath-row"');
    const aggregate = source.indexOf("Across all math", fastMath);
    expect(fastMath).toBeGreaterThan(-1);
    expect(aggregate).toBeGreaterThan(fastMath);
    expect(source).toContain("Every domain except Fast math");
  });
});

describe("the scholar column heading", () => {
  it("is ONE shared component, used by all three matrices", () => {
    expect(source.match(/function ScholarColumnHeader\(/g) ?? []).toHaveLength(1);
    // All domains, Fast math, single domain — no fourth bespoke heading.
    expect(source.match(/<ScholarColumnHeader/g) ?? []).toHaveLength(3);
    expect(source).toContain("testId={`mastery-scholar-header-${scholar.id}`}");
    expect(source).toContain("testId={`fast-math-scholar-header-${scholar.id}`}");
    // The heading's own avatar + name markup lives in the shared component
    // only, so a call site cannot re-roll a heading with different padding.
    expect(source.match(/<MasteryAvatar/g) ?? []).toHaveLength(1);
  });

  it("centres the heading in its row instead of pinning it to the bottom rule", () => {
    const headerRows = [...source.matchAll(/h=\{ALL_DOMAINS_HEADER_H\}/g)];
    // The all-domains and Fast math header rows.
    expect(headerRows).toHaveLength(2);
    for (const row of headerRows) {
      const props = source.slice(Math.max(0, row.index! - 500), row.index!);
      expect(props).toContain('alignItems="center"');
    }
    // The old off-centre geometry: bottom-aligned rows and a heading that
    // padded 6px below the name and nothing above the avatar.
    expect(source).not.toContain('alignItems="end"');
    expect(source).not.toContain('align="end"');
    expect(source).not.toContain('pb="6px"');
  });

  it("keeps the same footprint selected or not — only the ring's colour varies", () => {
    const start = source.indexOf("function ScholarColumnHeader(");
    const header = source.slice(start, source.indexOf("\n}\n", start));
    expect(header).toContain("px={1}");
    expect(header).toContain('py="2px"');
    expect(header).toContain("{...selectableSurface(selected)}");
    // No padding, gap, or size keyed off `selected` — that is what made the
    // violet rectangle sit off-kilter against its unselected neighbours.
    expect(header).not.toMatch(/(?:p[xytbl]?|gap|m[xytbl]?|[wh])=\{[^}]*selected/);
  });
});

describe("pointer affordance in the matrices", () => {
  it("states a pointer cursor on every hand-rolled click target", () => {
    // `Box as="button"` gets no cursor from Chakra's Button recipe, and the UA
    // default for <button> is an arrow — so each one has to say it. Inert
    // labels (`as={handler ? "button" : "div"}` with no handler) must not.
    const missing: string[] = [];
    for (const open of source.matchAll(/<(?:Box|Flex|HStack|Stack|Grid)\b/g)) {
      const rest = source.slice(open.index!);
      const end = rest.search(/\n\s*\/?>/);
      if (end < 0) continue;
      const props = rest.slice(0, end);
      const isButton = /as=\{?"button"|as=\{[^}]*"button"/.test(props);
      if (!isButton) continue;
      if (!/cursor[=:]|interactiveSurface/.test(props)) {
        missing.push(`line ${source.slice(0, open.index!).split("\n").length}`);
      }
    }
    expect(missing).toEqual([]);
    // The pointer is stated once, in the shared helper, wherever the target
    // is unconditionally interactive.
    expect(source).toContain("interactiveSurface");
    expect(source).toContain(
      'import { selectableSurface, interactiveSurface } from "@/components/practice/selectionStyle"',
    );
  });
});

describe("domain retention (matrix freshness tiers, spec §9-10.2)", () => {
  it("never adds a retention param to matrixCellVisual — the cell keeps ONLY the wash + number + Δ encoding", () => {
    // Founder ruling: freshness never touches the cell itself. The visual
    // function's own call sites must never widen to accept retention/due/
    // freshness inputs — that would put a second encoding on the cell.
    const calls = [...source.matchAll(/matrixCellVisual\(\{[\s\S]*?\}\)/g)].map(
      (m) => m[0],
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/retention|isDue|dueCount|freshness/i);
    }
  });

  it("reads the shared retention aggregate through the SAME cellReadoutWithMarks/joinReadout pipeline, not a new tooltip vocabulary", () => {
    expect(source).toContain(
      'import { retentionHoverClause } from "@/components/practice/domainRetentionCopy"',
    );
    expect(source).toContain("domainRetentionByScholar");
    expect(source).toMatch(
      /joinReadout\(\s*`\$\{scholar\.name\} · \$\{visual\.readout\}`,\s*retentionHoverClause\(retention, retentionNow\),\s*\)/,
    );
    // Still exactly the pre-existing 5 cellReadoutWithMarks call sites — the
    // retention clause rides INSIDE the existing base string, not a 6th call.
    expect((source.match(/cellReadoutWithMarks\(/g) ?? []).length).toBe(5);
  });

  it("surfaces Tier 2 through the shared DetailNoteStrip shell, right alongside the existing status strip — no new panel primitive", () => {
    expect(source).toContain(
      'import { DomainRetentionStrip } from "@/components/practice/DomainRetentionStrip"',
    );
    expect(source).toMatch(
      /\/\* Tier 2 freshness[\s\S]*?<DomainRetentionStrip retention=\{readout\?\.retention\} now=\{retentionNow\} \/>/,
    );
    // Rendered as its own sibling conditional, not fused into the
    // outOfScope/DomainMapStatusStrip ternary — that ternary's exact
    // "REPLACES the mapping strip" shape is a separate, pre-existing
    // invariant (see mathPlanScopeStrip.test.ts) this must not disturb.
    expect(source).toMatch(
      /\{!outOfScope && \(\s*<DomainRetentionStrip retention=\{readout\?\.retention\} now=\{retentionNow\} \/>\s*\)\}/,
    );
    const domainMapIndex = source.indexOf("<DomainMapStatusStrip");
    const retentionStripIndex = source.indexOf("{!outOfScope && (");
    expect(domainMapIndex).toBeGreaterThan(-1);
    expect(retentionStripIndex).toBeGreaterThan(domainMapIndex);
  });
});
