/**
 * The checkpoint control, driven for real: each state's words, and the exact
 * payload it sends. Rendered in jsdom (react-dom/client + ChakraProvider, the
 * harness used by the other Math Skills tests) with Convex's `useMutation`
 * captured, because the claims here are about what a teacher reads and what
 * reaches the server — neither of which a source assertion can prove.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

const convex = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  reject: null as string | null,
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: () => undefined,
    useMutation: () => async (args: Record<string, unknown>) => {
      convex.calls.push(args);
      if (convex.reject) throw new Error(convex.reject);
      return undefined;
    },
  };
});

import { system } from "@/lib/theme";
import { CheckpointBandControl } from "../CheckpointBandControl";
import type { MathPlanRow, PracticeScope } from "../mathPlanProjection";

const OPEN: PracticeScope = { kind: "open" };

function plan(overrides: Partial<MathPlanRow> = {}): MathPlanRow {
  return {
    scholarId: "scholar-1",
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function props(overrides: Record<string, unknown> = {}) {
  return {
    scholarId: "scholar-1",
    scholarName: "Scholar A",
    plan: plan(),
    domain: "probability",
    domainLabel: "Probability",
    domainLabelFor: (domain: string) =>
      domain === "probability" ? "Probability" : "Fractions",
    node: { strand: "chance", grade: "7" },
    bandSkillCount: 4,
    domainStrands: ["chance", "compound", "center-spread"],
    onOpenPlan: () => {},
    ...overrides,
  };
}

async function render(overrides: Record<string, unknown> = {}) {
  await act(async () => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(CheckpointBandControl, props(overrides) as never),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function action() {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="checkpoint-band-action"]',
  );
}

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  convex.calls = [];
  convex.reject = null;
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

describe("the checkpoint control's states", () => {
  it("offers the band, its sibling count, and one set action", async () => {
    await render();
    const button = action()!;
    expect(button.textContent).toContain("Set checkpoint here");
    expect(button.getAttribute("aria-label")).toBe(
      "Set Scholar A\u2019s checkpoint to Chance · grade 7. 4 skills in this band. Setting it here flags all 4 for Scholar.",
    );
    const row = document.querySelector('[data-testid="checkpoint-band-control"]')!;
    expect(row.textContent).toContain("Chance · grade 7");
    expect(row.textContent).toContain("4 skills in this band");
    expect(document.querySelector('[data-testid="checkpoint-band-chip"]')).toBeTruthy();

    await press(button);
    expect(convex.calls).toEqual([
      {
        scholarId: "scholar-1",
        practiceScope: OPEN,
        checkpoint: { domain: "probability", grade: "7", strand: "chance" },
      },
    ]);
    // No undo for a plain set — the button IS the inverse.
    expect(document.querySelector('[data-testid="checkpoint-band-undo"]')).toBeNull();
  });

  it("names the band being left when it moves an existing checkpoint", async () => {
    await render({
      plan: plan({
        checkpoint: {
          domain: "probability",
          strand: "compound",
          grade: "7",
          source: "teacher",
        },
      }),
    });

    const button = action()!;
    expect(button.textContent).toContain("Move checkpoint here");
    const row = document.querySelector('[data-testid="checkpoint-band-control"]')!;
    // The panel is already scoped to Probability, so the band being left is
    // named strand · grade — the same shape as the band in view.
    expect(row.textContent).toContain(
      "Scholar has one checkpoint, so this moves it off Compound · grade 7.",
    );
  });

  it("does not offer stale undo after moving an inherited group checkpoint", async () => {
    await render({
      plan: plan({
        checkpoint: {
          domain: "fractions",
          strand: "equivalence",
          grade: "6",
          source: "group",
          groupName: "Rockets",
        },
      }),
    });

    await press(action()!);
    await render({
      plan: plan({
        checkpoint: {
          domain: "probability",
          strand: "chance",
          grade: "7",
          source: "teacher",
        },
      }),
    });

    expect(
      document.querySelector('[data-testid="checkpoint-band-undo"]'),
    ).toBeNull();
  });

  it("clears the scholar's own checkpoint, scope passed back byte-for-byte", async () => {
    // A limited scope with strands: the control is a read-modify-write of the
    // scope field, so it must hand back exactly what it was given.
    const limited: PracticeScope = {
      kind: "limited",
      domains: [
        { domain: "probability", strands: ["chance", "compound"] },
        { domain: "fractions" },
      ],
    };
    await render({
      plan: plan({
        mode: "deeper",
        practiceScope: limited,
        checkpoint: {
          domain: "probability",
          strand: "chance",
          grade: "7",
          source: "teacher",
        },
      }),
    });
    const row = document.querySelector('[data-testid="checkpoint-band-control"]')!;
    expect(action()!.textContent).toContain("Clear checkpoint");
    // The derived mode is stated in words, never colour alone.
    expect(row.textContent).toContain("Going deeper");
    expect(row.textContent).toContain(
      "Mode is derived from band fluency and cannot be set here.",
    );

    await press(action()!);
    expect(convex.calls).toEqual([
      { scholarId: "scholar-1", practiceScope: limited, checkpoint: null },
    ]);
  });

  it("says whose checkpoint it clears when the band is inherited from a group", async () => {
    await render({
      plan: plan({
        checkpoint: {
          domain: "probability",
          strand: "chance",
          grade: "7",
          source: "group",
          groupName: "Rockets",
        },
      }),
    });
    expect(action()!.textContent).toContain("Clear for Scholar");
    expect(
      document.querySelector('[data-testid="checkpoint-band-control"]')!.textContent,
    ).toContain(
      "Inherited from Math group Rockets. Clearing it here affects Scholar only — the group keeps its own.",
    );
  });

  it("widens scope and sets the checkpoint in ONE call, naming what it adds", async () => {
    await render({
      plan: plan({
        practiceScope: {
          kind: "limited",
          domains: [{ domain: "probability", strands: ["compound"] }],
        },
      }),
    });
    const button = action()!;
    expect(button.textContent).toContain(
      "Add Chance to scope, then set checkpoint",
    );
    expect(
      document.querySelector('[data-testid="checkpoint-band-control"]')!.textContent,
    ).toContain("Adds one strand to practice scope.");
    // The refusal is drawn in the vocabulary the legend teaches.
    expect(document.querySelector('[data-testid="math-plan-slash"]')).toBeTruthy();

    await press(button);
    expect(convex.calls).toHaveLength(1);
    expect(convex.calls[0]!.checkpoint).toEqual({
      domain: "probability",
      grade: "7",
      strand: "chance",
    });
    expect(convex.calls[0]!.practiceScope).toEqual({
      kind: "limited",
      domains: [{ domain: "probability", strands: ["chance", "compound"] }],
    });
  });

  it("still names only the STRAND when the whole domain is out of scope, because that is all it adds", async () => {
    await render({
      plan: plan({
        practiceScope: { kind: "limited", domains: [{ domain: "fractions" }] },
      }),
    });
    expect(action()!.textContent).toContain(
      "Add Chance to scope, then set checkpoint",
    );
    await press(action()!);
    // One strand of Probability is served — not the whole domain the label
    // never promised.
    expect(convex.calls[0]!.practiceScope).toEqual({
      kind: "limited",
      domains: [{ domain: "fractions" }, { domain: "probability", strands: ["chance"] }],
    });
  });

  it("names the DOMAIN for a whole-domain band, which is what it widens", async () => {
    await render({
      node: { strand: null, grade: "7" },
      plan: plan({
        practiceScope: { kind: "limited", domains: [{ domain: "fractions" }] },
      }),
    });
    expect(action()!.textContent).toContain(
      "Add Probability to scope, then set checkpoint",
    );
    await press(action()!);
    expect(convex.calls[0]!.practiceScope).toEqual({
      kind: "limited",
      domains: [{ domain: "fractions" }, { domain: "probability" }],
    });
    expect(convex.calls[0]!.checkpoint).toEqual({
      domain: "probability",
      grade: "7",
    });
  });

  it("refuses without writing when the plan is conflicted, and routes to the modal", async () => {
    let opened = 0;
    await render({
      plan: plan({
        conflict: true,
        checkpoint: { domain: "fractions", grade: "5", source: "teacher" },
      }),
      onOpenPlan: () => {
        opened += 1;
      },
    });
    expect(action()!.textContent).toContain("Open math plan");
    await press(action()!);
    expect(opened).toBe(1);
    expect(convex.calls).toHaveLength(0);
  });

  it("refuses an empty limited scope the same way — the modal owns that repair too", async () => {
    let opened = 0;
    await render({
      plan: plan({ practiceScope: { kind: "limited", domains: [] } }),
      onOpenPlan: () => {
        opened += 1;
      },
    });
    expect(action()!.textContent).toContain("Open math plan");
    expect(
      document.querySelector('[data-testid="checkpoint-band-control"]')!.textContent,
    ).toContain("practice scope is limited to nothing");
    await press(action()!);
    expect(opened).toBe(1);
    expect(convex.calls).toHaveLength(0);
  });

  it("disables an ungraded skill instead of pretending it is a band", async () => {
    await render({ node: { strand: "chance", grade: null } });
    expect(action()!.textContent).toContain("No band");
    expect(action()!.disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="checkpoint-band-control"]')!.textContent,
    ).toContain("This skill has no grade");
  });

  it("renders nothing while the plan is loading, or where authoring is not offered", async () => {
    await render({ plan: undefined });
    expect(document.querySelector('[data-testid="checkpoint-band-control"]')).toBeNull();

    await render({ onOpenPlan: undefined });
    expect(document.querySelector('[data-testid="checkpoint-band-control"]')).toBeNull();
  });

  it("states a refusal inline rather than leaving the row half-set", async () => {
    convex.reject = "Checkpoint must be inside the Practice scope.";
    await render();
    await press(action()!);
    expect(
      document.querySelector('[data-testid="checkpoint-band-error"]')!.textContent,
    ).toBe("Checkpoint must be inside the Practice scope.");
    // The label is unchanged: nothing was written, so nothing moved.
    expect(action()!.textContent).toContain("Set checkpoint here");
  });

  it("announces the result only once the plan row carries the server's mode", async () => {
    await render({
      plan: plan({
        checkpoint: {
          domain: "probability",
          strand: "compound",
          grade: "7",
          source: "teacher",
        },
      }),
    });
    await press(action()!);
    // The fixture plan is static, so the write has not landed in the row yet —
    // and the control refuses to say it did.
    expect(
      document.querySelector('[data-testid="checkpoint-band-status"]')!.textContent,
    ).toBe("");
    expect(document.querySelector('[data-testid="checkpoint-band-undo"]')).toBeNull();

    // The reactive row arrives: now the sentence carries the DERIVED mode, and
    // the move — and only a move — offers its inverse.
    await render({
      plan: plan({
        mode: "deeper",
        checkpoint: {
          domain: "probability",
          strand: "chance",
          grade: "7",
          source: "teacher",
        },
      }),
    });
    const status = document.querySelector('[data-testid="checkpoint-band-status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe(
      "Checkpoint set to Chance · grade 7. Going deeper.",
    );
    const undo = document.querySelector<HTMLElement>(
      '[data-testid="checkpoint-band-undo"]',
    )!;
    expect(undo).toBeTruthy();
    expect(
      document.querySelector('[data-testid="checkpoint-band-control"]')!.textContent,
    ).toContain("Moved from Compound · grade 7.");

    await press(undo);
    // Undo restores the exact captured pair, atomically.
    expect(convex.calls[1]).toEqual({
      scholarId: "scholar-1",
      practiceScope: OPEN,
      checkpoint: { domain: "probability", strand: "compound", grade: "7" },
    });
    // The inverse is spent: the row no longer offers it a second time.
    expect(document.querySelector('[data-testid="checkpoint-band-undo"]')).toBeNull();
  });

  it("keeps the undo while the plan says what the write asked for, and drops it when anything else moves the checkpoint", async () => {
    const moved = {
      domain: "probability",
      strand: "chance",
      grade: "7",
      source: "teacher" as const,
    };
    await render({
      plan: plan({
        checkpoint: {
          domain: "probability",
          strand: "compound",
          grade: "7",
          source: "teacher",
        },
      }),
    });
    await press(action()!);
    await render({ plan: plan({ checkpoint: moved }) });
    expect(document.querySelector('[data-testid="checkpoint-band-undo"]')).toBeTruthy();

    // The row keeps arriving (band fluency recomputed, a sibling answered) —
    // the expected checkpoint is still there, so the undo stays offered.
    await render({
      plan: plan({ checkpoint: moved, bandSolid: 2, bandTotal: 4 }),
    });
    expect(document.querySelector('[data-testid="checkpoint-band-undo"]')).toBeTruthy();

    // Someone else moves it (the modal, the group, another teacher): the
    // captured pair no longer inverts anything, so it is forgotten.
    await render({
      plan: plan({
        checkpoint: {
          domain: "probability",
          strand: "center-spread",
          grade: "7",
          source: "teacher",
        },
      }),
    });
    expect(document.querySelector('[data-testid="checkpoint-band-undo"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="checkpoint-band-status"]')!.textContent,
    ).toBe("");
  });

  it("forgets a refusal, an announcement and an undo when the teacher clicks another cell", async () => {
    convex.reject = "Checkpoint must be inside the Practice scope.";
    await render();
    await press(action()!);
    expect(document.querySelector('[data-testid="checkpoint-band-error"]')).toBeTruthy();

    // A different skill is a different band — nothing from the last one holds.
    await render({ node: { strand: "compound", grade: "7" } });
    expect(document.querySelector('[data-testid="checkpoint-band-error"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="checkpoint-band-status"]')!.textContent,
    ).toBe("");
  });
});
