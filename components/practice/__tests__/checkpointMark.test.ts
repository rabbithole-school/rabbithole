/**
 * One checkpoint mark, everywhere. The matrix cells corner themselves with
 * `CheckpointCorner`; every checkpoint surface that is NOT a cell — the count
 * legend, the grade pill, the group/scholar band actions, the compact "this is
 * the checkpoint" labels — renders the same tile as `CheckpointMark`.
 *
 * These tests exist because the drift they catch is invisible in review: a bare
 * `<FlagCheckered>`, an outline-weight flag, or a unicode flag character all
 * LOOK like a checkpoint mark and all read as a second vocabulary next to the
 * yellow corner the cells actually carry.
 *
 * Rendered in jsdom for the claims about output, read from source for the
 * claims about absence (a rendered test cannot prove a glyph is gone from a
 * branch it did not take).
 */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import {
  CHECKPOINT_CORNER_STYLE,
  CheckpointMark,
} from "../MathPlanMarks";
import { CheckpointGradePill } from "../StrandHeading";
import { GroupCheckpointBandControl } from "../GroupCheckpointBandControl";

// Resolved from the repo root: under jsdom `import.meta.url` is rewritten to a
// browser-ish base that node:fs cannot open.
const read = (name: string) =>
  readFileSync(join(process.cwd(), "components/practice", name), "utf8");

/** Every Math Skills surface that states the checkpoint signal. `MathPlanMarks`
 *  is deliberately absent — it is the one file allowed to draw the glyph. */
const CHECKPOINT_SURFACES = [
  "MathSkillsMasteryView.tsx",
  "StrandHeading.tsx",
  "GroupCheckpointBandControl.tsx",
  "CheckpointBandControl.tsx",
  "CheckpointBandGrid.tsx",
  "ConfirmGroupCheckpointDialog.tsx",
  "EditMathPlanDialog.tsx",
  "MathPlanRailSection.tsx",
] as const;

/** Waving/outline/pennant flags and the checkered-flag emoji. Any of these
 *  standing in for the checkpoint is the drift this file guards. */
const UNICODE_FLAGS = /[\u2691\u2690\u{1F6A9}\u{1F3C1}\u{1F3F4}\u{1F3F3}]/u;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  await act(async () => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, { value: system, children: node }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const marks = (state = "toward") =>
  document.querySelectorAll(`[data-testid="checkpoint-mark-${state}"]`);

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

describe("the canonical checkpoint mark", () => {
  it("is the cell corner's own tile — same palette, same glyph, same round", () => {
    const source = read("MathPlanMarks.tsx");
    // Both placements read the ONE palette and the ONE geometry, so a mini mark
    // cannot drift off the corner it is supposed to be.
    expect(source).toContain("const CHECKPOINT_TILE_ROUND");
    expect(source).toContain("const CHECKPOINT_GLYPH_RATIO");
    expect(
      (source.match(/borderBottomRightRadius=\{CHECKPOINT_TILE_ROUND\}/g) ?? [])
        .length,
    ).toBe(2);
    expect(
      (source.match(/Math\.round\(size \* CHECKPOINT_GLYPH_RATIO\)/g) ?? [])
        .length,
    ).toBe(2);
    expect(CHECKPOINT_CORNER_STYLE.toward).toEqual({
      bg: "#fbe7a2",
      color: "#7a5b12",
    });
  });

  it("defaults to the canonical yellow rather than asking every caller", async () => {
    await render(createElement(CheckpointMark));
    expect(marks("toward")).toHaveLength(1);
  });

  it("is decorative by default and named only when asked", async () => {
    await render(createElement(CheckpointMark));
    expect(marks()[0].getAttribute("aria-hidden")).toBe("true");
    expect(marks()[0].getAttribute("aria-label")).toBeNull();

    await render(createElement(CheckpointMark, { label: "Checkpoint" }));
    expect(marks()[0].getAttribute("aria-label")).toBe("Checkpoint");
    expect(marks()[0].getAttribute("role")).toBe("img");
    expect(marks()[0].getAttribute("aria-hidden")).toBeNull();
  });

  it("stays a small signal — no badge, no wash, no ring", () => {
    const source = read("MathPlanMarks.tsx");
    const mark = source.slice(
      source.indexOf("export function CheckpointMark("),
      source.indexOf("export const CHECKPOINT_BAND_CHIP_SIZE"),
    );
    expect(mark).not.toMatch(/borderWidth|boxShadow|outline/);
    expect(mark).toMatch(/size = 13/);
  });
});

describe("no checkpoint surface draws its own flag", () => {
  it.each(CHECKPOINT_SURFACES)("%s uses the shared mark, not a glyph", (file) => {
    const source = read(file);
    expect(source).not.toContain("FlagCheckered");
    expect(source).not.toMatch(UNICODE_FLAGS);
    // …and no second flag icon smuggled in under another name.
    expect(source).not.toMatch(/\bFlagBanner\b|\bFlagPennant\b|\b<Flag\b/);
  });
});

describe("the count legend", () => {
  const view = read("MathSkillsMasteryView.tsx");
  const rollup = view.slice(
    view.indexOf("{checkpointModeRollup && ("),
    view.indexOf("<Input"),
  );

  it("matches each count to the corresponding cell-corner mode color", () => {
    expect(rollup).toContain('<CheckpointMark state="toward" size={12} />');
    expect(rollup).toContain('<CheckpointMark state="deeper" size={12} />');
    expect(rollup).toContain("working toward");
    expect(rollup).toContain("going deeper");
  });

  it("keeps the counts visible and next to their words", () => {
    expect(rollup).toContain("{checkpointModeRollup.toward} working toward");
    expect(rollup).toContain("{checkpointModeRollup.deeper} going deeper");
  });

  it("announces the row once, not once per count", () => {
    // One sr-only lead-in names the signal; the marks themselves are decorative
    // (no `label`), so a reader hears "1 working toward · 0 going deeper" once.
    expect(
      (rollup.match(/<VisuallyHidden>/g) ?? []),
    ).toHaveLength(1);
    expect(rollup).toContain("<VisuallyHidden>Checkpoint standing:</VisuallyHidden>");
    expect(rollup).not.toMatch(/CheckpointMark[^/]*label=/);
    expect(rollup).not.toContain("aria-label");
  });
});

describe("the grade-range pill", () => {
  const pill = (overrides: Record<string, unknown> = {}) =>
    createElement(CheckpointGradePill, {
      nodes: [{ grade: "4" }, { grade: "5" }, { grade: "6" }],
      altitude: "strand",
      currentGrade: null,
      canSet: true,
      disabledHint: "Pick a group first.",
      onSetGrade: () => {},
      onClear: () => {},
      ...overrides,
    } as never);

  it("wears the canonical mark instead of a gray outline flag", async () => {
    await render(pill());
    expect(marks("toward")).toHaveLength(1);
    expect(document.body.textContent).toContain("Grades 4–6");
  });

  it("keeps its compact outline pill chrome and its accessible name", async () => {
    await render(pill());
    const trigger = document.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toContain(
      "Set the current checkpoint in this strand",
    );
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("carries the same mark when this row IS the checkpoint", async () => {
    await render(pill({ currentGrade: "5" }));
    expect(marks("toward")).toHaveLength(1);
    expect(document.querySelector("button")!.getAttribute("aria-label")).toContain(
      "Current checkpoint: Grade 5",
    );
  });

  it("shows no mark at all when no checkpoint can be set here", async () => {
    await render(pill({ canSet: false }));
    expect(marks("toward")).toHaveLength(0);
    expect(document.body.textContent).toContain("Grades 4–6");
  });
});

describe("the group checkpoint control", () => {
  const control = (overrides: Record<string, unknown> = {}) =>
    createElement(GroupCheckpointBandControl, {
      groupName: "Angle crew",
      memberTotal: 4,
      band: { domain: "geometry-measurement", grade: "7", strand: "angle" },
      bandLabel: "Angle · grade 7",
      bandSkillCount: 5,
      currentLabel: null,
      isCurrent: false,
      onRequest: () => {},
      ...overrides,
    } as never);

  it("marks the action with the cells' own mark", async () => {
    await render(control());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="group-checkpoint-band-action"]',
    )!;
    expect(action.querySelectorAll('[data-testid="checkpoint-mark-toward"]')).toHaveLength(1);
    expect(action.textContent).toContain("Set checkpoint for 4 scholars");
  });

  it("marks the current-checkpoint pill the same way", async () => {
    await render(control({ isCurrent: true, currentLabel: "Angle · grade 7" }));
    const currentPill = document.querySelector(
      '[data-testid="group-checkpoint-current-pill"]',
    )!;
    expect(
      currentPill.querySelectorAll('[data-testid="checkpoint-mark-toward"]'),
    ).toHaveLength(1);
    expect(currentPill.textContent).toContain("Group checkpoint");
  });

  it("still routes through the confirmation rather than writing", async () => {
    // The mark swap is cosmetic: the action must keep saying it opens a guard,
    // and keep raising a request instead of mutating.
    await render(control());
    const action = document.querySelector<HTMLButtonElement>(
      '[data-testid="group-checkpoint-band-action"]',
    )!;
    expect(action.getAttribute("aria-label")).toContain("Opens a confirmation.");
    expect(read("GroupCheckpointBandControl.tsx")).not.toContain("useMutation");
  });
});
