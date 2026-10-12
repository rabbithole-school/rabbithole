import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./MathSkillsMasteryView.tsx", import.meta.url)),
  "utf8",
);

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

  it("opens the dedicated Fast math family view", () => {
    expect(source).toContain("FAST_MATH_DOMAIN");
    const start = source.indexOf("Fast math — the ONE row");
    const end = source.indexOf("Across-all-math summary row", start);
    const row = source.slice(start, end);
    expect(row).toContain("onSelectDomain(FAST_MATH_DOMAIN)");
    expect(row).not.toContain("onOpenReport(scholar.id)");
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
