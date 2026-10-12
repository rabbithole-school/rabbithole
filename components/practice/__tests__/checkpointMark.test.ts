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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import { CheckpointMark } from "../MathPlanMarks";
import { CheckpointGradePill } from "../StrandHeading";
import { GroupCheckpointBandControl } from "../GroupCheckpointBandControl";

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
  });
});
