/**
 * The scholar column heading's checkpoint mark.
 *
 * A matrix column is one visual system: the cells wear the checkpoint as a
 * filled top-left corner tile, so the heading above them wears the SAME tile in
 * the SAME corner — not a circular badge centred under the name, which was a
 * second vocabulary for a signal the column already had a canonical rendering
 * for, and which had to grow the header row by 12px to make room for itself.
 *
 * These tests are rendered rather than grepped because the properties that
 * matter here are compositional: the corner has to be out of flow (so the
 * centred avatar/name/level stack cannot move), decorative and pointer-inert
 * (so the heading stays exactly one click target), and the heading's own name
 * has to keep saying the checkpoint in words (so the mark is never colour
 * alone). Source reads are kept only for the claims about ABSENCE — a rendered
 * test cannot prove a badge is gone from a branch it did not take.
 */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import { CHECKPOINT_CORNER_STYLE } from "../MathPlanMarks";
import { ScholarColumnHeader } from "../MathSkillsMasteryView";

const read = (name: string) =>
  readFileSync(join(process.cwd(), "components/practice", name), "utf8");

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

const SCHOLAR = { id: "u1", name: "Ada Lovelace", image: null };

function header(overrides: Record<string, unknown> = {}) {
  return createElement(ScholarColumnHeader, {
    scholar: SCHOLAR,
    selected: false,
    title: "Ada Lovelace across Fractions",
    testId: "mastery-scholar-header-u1",
    onSelect: () => {},
    ...overrides,
  } as never);
}

const heading = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="mastery-scholar-header-u1"]',
  )!;

const corner = (state = "toward") =>
  document.querySelector<HTMLElement>(
    `[data-testid="math-plan-corner-${state}"]`,
  );

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

describe("the heading's checkpoint mark", () => {
  it("is the cells' own corner tile, in the cells' own corner", async () => {
    await render(header({ checkpoint: "toward" }));
    const mark = corner()!;
    expect(mark).not.toBeNull();
    expect(heading().contains(mark)).toBe(true);

    const style = getComputedStyle(mark);
    expect(style.position).toBe("absolute");
    expect(style.top).toBe("0px");
    expect(style.left).toBe("0px");
    // The canonical yellow fill, straight from the one palette the cells read.
    expect(style.backgroundColor).toBe("rgb(251, 231, 162)");
    expect(CHECKPOINT_CORNER_STYLE.toward.bg).toBe("#fbe7a2");
  });

  it("takes the mode hue the marked cells below it take", async () => {
    for (const state of ["toward", "deeper", "conflict"] as const) {
      await render(header({ checkpoint: state }));
      expect(getComputedStyle(corner(state)!).backgroundColor).toBe(
        hexToRgb(CHECKPOINT_CORNER_STYLE[state].bg),
      );
    }
  });

  it("follows the heading's rounded corner instead of cutting across it", () => {
    // `borderTopLeftRadius: inherit` is what lets ONE corner component sit
    // flush in a flush matrix cell AND inside the heading's rounded card.
    const marks = read("MathPlanMarks.tsx");
    expect(marks).toContain('borderTopLeftRadius="inherit"');
  });

  it("is out of flow — the centred stack is byte-identical with and without it", async () => {
    await render(header());
    const without = inFlowStack(heading());

    await render(header({ checkpoint: "toward" }));
    const withMark = inFlowStack(heading());

    expect(withMark).toEqual(without);
    // …and the heading itself grew no line to seat it.
    expect(getComputedStyle(corner()!).position).toBe("absolute");
  });

  it("draws nothing at all for a heading with no checkpoint", async () => {
    await render(header());
    expect(corner("toward")).toBeNull();
    expect(corner("deeper")).toBeNull();
    expect(corner("conflict")).toBeNull();
  });
});

describe("the heading stays exactly one control", () => {
  it("keeps the mark decorative and pointer-inert", async () => {
    await render(header({ checkpoint: "conflict" }));
    const mark = corner("conflict")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("aria-label")).toBeNull();
    expect(mark.getAttribute("role")).toBeNull();
    expect(getComputedStyle(mark).pointerEvents).toBe("none");
  });

  it("nests no second interactive target inside the button", async () => {
    await render(header({ checkpoint: "toward" }));
    expect(
      heading().querySelectorAll(
        'button, a, input, [role="button"], [role="img"], [tabindex]',
      ),
    ).toHaveLength(0);
  });

  it("keeps its click target, pressed state, and pointer cursor", async () => {
    const onSelect = vi.fn();
    await render(header({ checkpoint: "toward", onSelect }));
    const button = heading();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(getComputedStyle(button).cursor).toBe("pointer");

    await act(async () => button.click());
    expect(onSelect).toHaveBeenCalledTimes(1);

    await render(header({ checkpoint: "toward", selected: true, onSelect }));
    expect(heading().getAttribute("aria-pressed")).toBe("true");
  });

  it("says the checkpoint in words, in the name AND the hover", async () => {
    await render(header({ checkpoint: "deeper" }));
    const button = heading();
    expect(button.getAttribute("aria-label")).toBe(
      "Ada Lovelace across Fractions. checkpoint, going deeper",
    );
    expect(button.getAttribute("title")).toBe(
      button.getAttribute("aria-label"),
    );

    await render(header({ checkpoint: "conflict" }));
    expect(heading().getAttribute("aria-label")).toContain(
      "checkpoint suspended, needs attention",
    );
  });

  it("leaves an unmarked heading's readout exactly as it was", async () => {
    await render(header());
    expect(heading().getAttribute("title")).toBe(
      "Ada Lovelace across Fractions",
    );
    expect(heading().getAttribute("aria-label")).toBe(
      "Ada Lovelace across Fractions",
    );
  });
});

describe("every matrix mode shares the one heading", () => {
  const view = read("MathSkillsMasteryView.tsx");

  it("routes all three matrices through it, and marks only the one with state", () => {
    expect(view.match(/<ScholarColumnHeader/g) ?? []).toHaveLength(3);
    // Single-domain is the only matrix that reads a Math plan, so it is the
    // only one that can hand the heading a checkpoint. All domains and Fast
    // math pass none and therefore draw none — no invented state.
    expect(view.match(/checkpoint=\{scholarCheckpointState\(/g) ?? []).toHaveLength(
      1,
    );
    expect(view).toContain("scholarCheckpointState(\n                                planByScholar.get(scholar.id),\n                              )");
  });

  it("derives the mode from the ONE projection rule the cells use", () => {
    const projection = read("mathPlanProjection.ts");
    // Not a second `conflict ? … : mode` spelled out at the call site.
    expect(projection).toContain("export function scholarCheckpointState(");
    expect(projection).toMatch(
      /scholarCheckpointState\([\s\S]*?return cornerState\(plan, plan\.checkpoint !== null\);/,
    );
    expect(view).not.toMatch(/conflict\s*\?\s*"conflict"/);
  });
});

describe("the centred circular badge is gone", () => {
  it("leaves no chip component, import, or call site behind", () => {
    const view = read("MathSkillsMasteryView.tsx");
    const marks = read("MathPlanMarks.tsx");
    expect(marks).not.toContain("CheckpointModeChip");
    expect(view).not.toContain("CheckpointModeChip");
    // The badge's whole geometry: a 16px circle with a flag in it.
    expect(marks).not.toMatch(/borderRadius="full"[\s\S]{0,120}FlagCheckered/);
  });

  it("stops sizing the header row around a checkpoint line", () => {
    const view = read("MathSkillsMasteryView.tsx");
    // The +12px variant existed only to seat the badge; a non-flow corner needs
    // no room, so the header row and the strand sticky offset are one constant
    // again and cannot disagree.
    expect(view).not.toContain("SCHOLAR_HEADER_H_WITH_CHECKPOINT_MODE");
    expect(view).not.toMatch(/h=\{\s*checkpointModeRollup/);
    expect(view).not.toMatch(/top=\{\s*checkpointModeRollup/);
    expect(view).toContain("h={SCHOLAR_HEADER_H}");
    expect(view).toContain("top={SCHOLAR_HEADER_H}");
  });
});

/** The heading's visible, in-flow content: every descendant the corner must not
 *  be able to move. */
function inFlowStack(button: HTMLElement): string[] {
  return [...button.children]
    .filter((child) => getComputedStyle(child).position !== "absolute")
    .map((child) => `${child.tagName}:${child.textContent ?? ""}`);
}

function hexToRgb(hex: string): string {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) =>
    parseInt(value.slice(i, i + 2), 16),
  );
  return `rgb(${r}, ${g}, ${b})`;
}
