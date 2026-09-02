/**
 * The modal's checkpoint picker, at three altitudes: the pure "where does a
 * freshly chosen domain land" helper, the grid's structural contract asserted
 * from source (what it may NOT contain — a second selected ring, a re-derived
 * grade, a mode it predicts), and the grid rendered for real (radiogroup, one
 * tab stop, inert holes, slashed out-of-scope chips, a held band the catalogue
 * has lost).
 */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import { CheckpointBandGrid, firstSelectableBand } from "../CheckpointBandGrid";
import type { BandChoice } from "../CheckpointBandGrid";
import type {
  CheckpointCatalogDomain,
  PracticeScope,
} from "../mathPlanProjection";

// `import.meta.url` is not a file URL under the jsdom environment, so resolve
// from the repo root vitest already runs in.
const read = (name: string) =>
  readFileSync(join(process.cwd(), "components", "practice", name), "utf8");

const grid = read("CheckpointBandGrid.tsx");
const editor = read("EditMathPlanDialog.tsx");

const FRACTIONS: CheckpointCatalogDomain = {
  domain: "fractions",
  label: "Fractions",
  grades: ["4", "5"],
  strands: [
    { strand: "equivalence", label: "Equivalence", grades: ["4"] },
    { strand: "operations", label: "Operations", grades: ["5"] },
  ],
};

describe("firstSelectableBand", () => {
  it("prefers the whole-domain band when the whole domain is in scope", () => {
    expect(firstSelectableBand(FRACTIONS, { kind: "open" })).toEqual({
      grade: "4",
    });
  });

  it("falls through to the first strand a limited scope actually admits", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "fractions", strands: ["operations"] }],
    };
    expect(firstSelectableBand(FRACTIONS, scope)).toEqual({
      strand: "operations",
      grade: "5",
    });
  });

  it("returns null when the scope admits nothing in the domain", () => {
    const scope: PracticeScope = {
      kind: "limited",
      domains: [{ domain: "geometry" }],
    };
    expect(firstSelectableBand(FRACTIONS, scope)).toBeNull();
  });
});

describe("CheckpointBandGrid", () => {
  it("is a radiogroup of chips with ONE roving tab stop", () => {
    expect(grid).toContain('role="radiogroup"');
    expect(grid).toContain('role="radio"');
    expect(grid).toContain("aria-checked={chosen}");
    expect(grid).toContain("tabIndex={tabStop === key ? 0 : -1}");
  });

  it("drives the grid with arrows, Home/End and Enter/Space, skipping what cannot be chosen", () => {
    for (const key of [
      "ArrowRight",
      "ArrowLeft",
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      "Enter",
    ]) {
      expect(grid).toContain(`case "${key}"`);
    }
    // The step loop only ever lands on an enabled chip.
    expect(grid).toMatch(/if \(enabledAt\(r, c\)\) return focusCell\(r, c\)/);
  });

  it("draws a hole as an inert dash, not a disabled radio", () => {
    expect(grid).toMatch(/if \(!band\) \{[\s\S]*?aria-hidden[\s\S]*?—/);
    expect(grid).toContain('data-testid="checkpoint-band-empty"');
  });

  it("slashes an out-of-scope band in place rather than hiding it", () => {
    expect(grid).toContain("outOfScope={disabled}");
    expect(grid).toContain("disabled={disabled}");
    expect(grid).toContain('title={disabled ? "Out of practice scope"');
  });

  it("marks the chosen band with the corner flag alone — no second ring", () => {
    expect(grid).toContain("corner={chosen ? corner : null}");
    expect(grid).not.toContain("selectableSurface");
    expect(grid).not.toMatch(/borderColor=\{chosen/);
  });

  it("scrolls horizontally with the strand labels pinned", () => {
    expect(grid).toContain('overflowX="auto"');
    expect(grid).toMatch(/position="sticky"\s+left=\{0\}/);
    // The chip itself never shrinks or wraps — it is a fixed cell footprint.
    expect(read("MathPlanMarks.tsx")).toMatch(
      /w=\{`\$\{dims\.w\}px`\}[\s\S]*?flex="0 0 auto"/,
    );
  });

  it("keeps a held band on the board when the catalogue has lost its strand or grade", () => {
    // The visual form of the workaround the retired selects needed: a stored
    // target the graph no longer lists still renders, so the picker meant to
    // repair it cannot silently hide it.
    expect(grid).toMatch(/rows\.some\(\(row\) => row\.strand === held\.strand\)/);
    expect(grid).toMatch(/held && !domain\.grades\.includes\(held\.grade\)/);
    expect(grid).toMatch(/if \(!row\.grades\.includes\(grade\) && !sameBand\(value, band\)\) return null;/);
  });

  it("refuses legibly when a domain carries no graded skill at all", () => {
    expect(grid).toMatch(/if \(grades\.length === 0\)/);
    expect(grid).toContain('data-testid="checkpoint-band-grid-empty"');
  });

  it("states the band in one gesture, so nothing has to re-derive a grade", () => {
    // One selection carries the strand AND the grade, so there is no second
    // control left to re-pick one after the other changed — and exactly two
    // gestures reach it: the click and the keyboard.
    expect((grid.match(/onSelect\(band\)/g) ?? []).length).toBe(2);
    expect(grid).not.toMatch(/onSelectStrand|onSelectGrade|setGrade\(|setStrand\(/);
  });
});

describe("the editor after the swap", () => {
  it("never lends a saved band's mode to an unsaved one", () => {
    // The corner may carry the plan's own reading ONLY for the stored target;
    // any other draft band gets the unresolved default the sentence explains.
    expect(editor).toMatch(
      /corner=\{[\s\S]*?sameTarget\(draft\.checkpoint, data\.checkpoint\)[\s\S]*?plan\?\.conflict[\s\S]*?: "toward"[\s\S]*?\}/,
    );
  });

  it("keeps the domain select — including its No checkpoint option", () => {
    expect(editor).toContain('"aria-label": "Checkpoint domain"');
    expect(editor).toContain('<option value="">No checkpoint</option>');
    expect(editor).toContain("checkpointDomainChoices");
  });

  it("has no strand or grade select, and no repair logic to keep them in step", () => {
    expect(editor).not.toContain('"Checkpoint strand"');
    expect(editor).not.toContain('"Checkpoint grade"');
    expect(editor).not.toContain("checkpointStrandChoices");
    expect(editor).not.toContain("checkpointGradeChoices");
    expect((editor.match(/<FieldSelect/g) ?? []).length).toBe(1);
    expect(editor).toContain("<CheckpointBandGrid");
    expect(editor).toContain("firstSelectableBand(");
  });

  it("still saves both controls in one atomic call, blocked while invalid", () => {
    expect((editor.match(/await save\(/g) ?? []).length).toBe(1);
    expect(editor).toContain("disabled={!draft || !!problem || saving}");
    // The conflict banner keeps all three named exits.
    expect(editor).toContain("Keep it in scope");
    expect(editor).toContain("Move checkpoint");
    expect(editor).toContain("Clear checkpoint");
  });

  it("keeps mode derived, and says so for an unsaved target", () => {
    expect(editor).toMatch(/Mode is derived from band fluency/);
    expect(editor).toMatch(
      /Mode is derived from band fluency — it resolves\s*\n?\s*once this target is saved/,
    );
    expect(editor).not.toMatch(/setMode/);
  });
});

describe("the grid, rendered", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  async function render(props: {
    scope: PracticeScope;
    value: BandChoice | null;
    onSelect?: (band: BandChoice) => void;
  }) {
    await act(async () => {
      root!.render(
        // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
        createElement(ChakraProvider, {
          value: system,
          children: createElement(CheckpointBandGrid, {
            domain: FRACTIONS,
            corner: "toward",
            onSelect: () => {},
            ...props,
          }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  const chips = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ];

  it("draws one chip per band the catalogue holds, and an inert dash for a hole", async () => {
    await render({ scope: { kind: "open" }, value: { grade: "4" } });
    // Any strand × G4, G5 · Equivalence × G4 · Operations × G5.
    expect(chips().map((chip) => chip.getAttribute("data-testid"))).toEqual([
      "checkpoint-band-chip-__any-4",
      "checkpoint-band-chip-__any-5",
      "checkpoint-band-chip-equivalence-4",
      "checkpoint-band-chip-operations-5",
    ]);
    expect(
      document.querySelectorAll('[data-testid="checkpoint-band-empty"]'),
    ).toHaveLength(2);
    // The corner flag alone says which one, and only the chosen chip wears it.
    expect(
      document.querySelectorAll('[data-testid^="math-plan-corner-"]'),
    ).toHaveLength(1);
    expect(
      chips().filter((chip) => chip.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
  });

  it("slashes and disables what the draft scope excludes, and keeps the tab stop on something choosable", async () => {
    await render({
      scope: {
        kind: "limited",
        domains: [{ domain: "fractions", strands: ["operations"] }],
      },
      value: { strand: "equivalence", grade: "4" },
    });
    const held = document.querySelector<HTMLButtonElement>(
      '[data-testid="checkpoint-band-chip-equivalence-4"]',
    )!;
    // The held band is out of scope: still there, still checked, unselectable.
    expect(held.disabled).toBe(true);
    expect(held.getAttribute("aria-checked")).toBe("true");
    expect(held.getAttribute("title")).toBe("Out of practice scope");
    expect(held.querySelector('[data-testid="math-plan-slash"]')).toBeTruthy();
    // …so the one tab stop falls on the band a teacher could actually choose.
    const stops = chips().filter((chip) => chip.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("data-testid")).toBe(
      "checkpoint-band-chip-operations-5",
    );
  });

  it("keeps a held band the catalogue no longer lists on the board", async () => {
    await render({
      scope: { kind: "open" },
      value: { strand: "retired-strand", grade: "9" },
    });
    const held = document.querySelector<HTMLButtonElement>(
      '[data-testid="checkpoint-band-chip-retired-strand-9"]',
    )!;
    expect(held, "the stored target must not vanish from its own picker").toBeTruthy();
    expect(held.getAttribute("aria-checked")).toBe("true");
    // Its grade earns a column, so the row reads against a real axis.
    expect(document.body.textContent).toContain("G9");
  });

  it("arrows past disabled and empty cells, and selects with Space", async () => {
    const picked: BandChoice[] = [];
    await render({
      scope: {
        kind: "limited",
        domains: [{ domain: "fractions", strands: ["equivalence", "operations"] }],
      },
      value: { strand: "equivalence", grade: "4" },
      onSelect: (band) => picked.push(band),
    });
    // "Any strand" is out of scope (a strand-limited domain), and Equivalence
    // has no G5 — so ArrowDown from Equivalence × G4 must land on Operations ×
    // G5 only via its own row; ArrowDown walks the column and finds nothing.
    const start = document.querySelector<HTMLButtonElement>(
      '[data-testid="checkpoint-band-chip-equivalence-4"]',
    )!;
    await act(async () => {
      start.focus();
      start.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Any strand × G4 is disabled, so focus does not move to it.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "checkpoint-band-chip-equivalence-4",
    );

    await act(async () => {
      start.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(picked).toEqual([{ strand: "equivalence", grade: "4" }]);
  });
});
