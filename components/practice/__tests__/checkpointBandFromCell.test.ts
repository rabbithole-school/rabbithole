/**
 * The whole gesture, end to end: a teacher clicks a scholar × skill cell in the
 * single-domain matrix and the panel that opens offers the checkpoint for the
 * band that cell names — the claim Sketch 2 exists to make ("set the flag where
 * you see it", `review/math-checkpoint-interaction-refinements.html`).
 *
 * Renders the REAL `MathSkillsMasteryView` in jsdom with Convex answered from
 * fixtures, so this pins the MOUNT and its wiring (which band, whose plan, how
 * many siblings) rather than the control's own words, which
 * `checkpointBandControlBehavior.test.ts` covers directly.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

const convex = vi.hoisted(() => ({
  answers: new Map<string, unknown>(),
  calls: [] as Record<string, unknown>[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
    useQuery: (reference: unknown, args: unknown) =>
      args === "skip"
        ? undefined
        : convex.answers.get(getFunctionName(reference as never)),
    useMutation: () => async (args: Record<string, unknown>) => {
      convex.calls.push(args);
      return undefined;
    },
  };
});

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: { _id: "teacher-1", name: "Teacher", role: "teacher" },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

import { system } from "@/lib/theme";
import { MASTERY_FILTER_ORDER } from "@/components/practice/mathSkillsMasteryFilters";
import { MathSkillsMasteryView } from "../MathSkillsMasteryView";

const SCHOLAR_ID = "scholar-1";
const DOMAIN = "probability";

/** Two Chance skills at grade 7 (one band, two siblings) and one at grade 6. */
const NODES = [
  { nodeKey: "chance-a", label: "Likelihood", strand: "chance", grade: "7" },
  { nodeKey: "chance-b", label: "Sample space", strand: "chance", grade: "7" },
  { nodeKey: "chance-c", label: "Certain or impossible", strand: "chance", grade: "6" },
  { nodeKey: "compound-a", label: "Two events", strand: "compound", grade: "7" },
];

const scholar = {
  id: SCHOLAR_ID,
  name: "Scholar H",
  username: "scholar_h",
  image: null,
  readingLevel: null,
  gradeLevel: "6",
  dateOfBirth: null,
  lastMessageAt: null,
  groupIds: [],
  isMine: true,
  enrollmentStanding: "enrolled" as const,
};

function seedFixtures(plan: Record<string, unknown>) {
  convex.answers.clear();
  convex.calls = [];
  convex.answers.set("cohortPractice:masteryForScholars", {
    scholars: [
      {
        scholarId: SCHOLAR_ID,
        name: scholar.name,
        image: null,
        readings: NODES.map((node) => ({
          nodeKey: node.nodeKey,
          mastery: "frontier",
          automaticity: 0.5,
          depth: 1,
          frontier: true,
          flagged: false,
        })),
      },
    ],
  });
  convex.answers.set("cohortPractice:mapStatusForScholars", { scholars: [] });
  convex.answers.set("cohortPractice:fastMathForScholars", { scholars: [] });
  convex.answers.set("practiceItemPool:poolSummary", { domain: DOMAIN, nodes: [] });
  convex.answers.set("mathPlans:forScholars", [
    {
      scholarId: SCHOLAR_ID,
      practiceScope: { kind: "open" },
      scopeSource: "open_default",
      migrationIssue: null,
      checkpoint: null,
      conflict: false,
      mode: "toward",
      bandSolid: 0,
      bandTotal: 0,
      ...plan,
    },
  ]);
}

/** The page owns the selected skill, so the harness has to as well — otherwise
 *  every cell click falls back to whichever node happens to sort first. */
function Harness() {
  const [selected, setSelected] = useState<string | null>(null);
  return createElement(MathSkillsMasteryView, {
    domain: DOMAIN,
    domainLabel: "Probability",
    nodes: NODES,
    domains: [{ domain: DOMAIN, label: "Probability" }],
    selectedNode: selected,
    onSelectNode: (nodeKey: string | null) => setSelected(nodeKey),
    treeView: false,
    onToggleTreeView: () => {},
    search: "",
    onSearchChange: () => {},
    statuses: new Set(MASTERY_FILTER_ORDER),
    onStatusesChange: () => {},
    scopedScholars: [scholar],
    effectiveScholarId: "",
    rosterLoading: false,
    reportScholarId: "",
    onOpenReport: () => {},
    onOpenContentForNode: () => {},
    onOpenStoriesForNode: () => {},
  });
}

const view = () => createElement(Harness);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  await act(async () => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, { value: system, children: view() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const cell = (nodeKey: string) =>
  document.querySelector(`[data-testid="mastery-cell-${nodeKey}-${SCHOLAR_ID}"]`);

const control = () =>
  document.querySelector('[data-testid="checkpoint-band-control"]');

const action = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="checkpoint-band-action"]',
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
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
  vi.unstubAllGlobals();
});

describe("setting the checkpoint from the cell you are looking at", () => {
  it("offers the clicked cell's own band, counts its siblings, and writes it atomically", async () => {
    seedFixtures({});
    await render();

    // No scholar × skill drill yet, so nothing to author.
    expect(control()).toBeNull();

    await click(cell("chance-a")!);
    const row = control();
    expect(row, "a clicked cell opens the panel that carries the control").toBeTruthy();
    expect(row!.textContent).toContain("Chance · grade 7");
    // Two Chance skills at grade 7 — counted from the domain's nodes, not from
    // whatever the filters happen to leave on screen.
    expect(row!.textContent).toContain("2 skills in this band");
    expect(action()!.textContent).toContain("Set checkpoint here");

    await click(action()!);
    expect(convex.calls).toEqual([
      {
        scholarId: SCHOLAR_ID,
        practiceScope: { kind: "open" },
        checkpoint: { domain: DOMAIN, strand: "chance", grade: "7" },
      },
    ]);
  });

  it("re-reads the band when the teacher drills a different skill", async () => {
    seedFixtures({});
    await render();

    await click(cell("chance-c")!);
    expect(control()!.textContent).toContain("Chance · grade 6");
    // Grade 6 holds one Chance skill, and the copy is singular.
    expect(control()!.textContent).toContain("1 skill in this band");

    await click(cell("compound-a")!);
    expect(control()!.textContent).toContain("Compound · grade 7");
  });

  it("names the band being left when this scholar's checkpoint is elsewhere", async () => {
    seedFixtures({
      checkpoint: {
        domain: DOMAIN,
        strand: "compound",
        grade: "7",
        source: "teacher",
      },
      mode: "toward",
    });
    await render();

    await click(cell("chance-a")!);
    expect(action()!.textContent).toContain("Move checkpoint here");
    expect(control()!.textContent).toContain("moves it off Compound · grade 7");
  });
});
