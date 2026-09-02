/**
 * Regression test for the teacher-facing math plan section in the
 * scholar × domain drawer (All domains matrix). Two defects, one click:
 *
 *  1. The all-domains branch of `MathSkillsMasteryView` renders the Math plan
 *     rail but returned before ever mounting `EditMathPlanDialog` — the button
 *     set state no branch read, so nothing happened at all.
 *  2. That rail is hosted by a MODAL drawer on narrow screens. Ark's modal
 *     dialog holds the focus trap and marks everything below it inert
 *     (`hideContentBelow`), so an editor portalled as the drawer's sibling
 *     would open unreachable underneath it.
 *
 * Renders the REAL component in jsdom (react-dom/client + ChakraProvider — the
 * same harness as `components/workbench/__tests__/SimulatorViewport.*`; there
 * is no React Testing Library in this repo), with Convex's `useQuery` answered
 * from fixtures, and drives the actual click path: open a scholar's drawer →
 * the plan section → the editor's own controls must be present AND live (not
 * under an inert / aria-hidden layer).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

const convex = vi.hoisted(() => ({ answers: new Map<string, unknown>() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (reference: unknown, args: unknown) =>
      args === "skip"
        ? undefined
        : convex.answers.get(getFunctionName(reference as never)),
    useMutation: () => async () => undefined,
  };
});

// jsdom ships no `CSS` namespace, but Ark's radio group calls `CSS.escape`
// when it re-syncs its inputs after the choice changes. Every browser has had
// it for years, so this is an environment gap, not product behavior.
const globalWithCss = globalThis as unknown as {
  CSS?: { escape: (value: string) => string };
};
globalWithCss.CSS ??= {
  escape: (value: string) => value.replace(/([^\w-])/g, "\\$1"),
};

import { system } from "@/lib/theme";
import { MathSkillsMasteryView } from "../MathSkillsMasteryView";

const SCHOLAR_ID = "scholar-1";
const DOMAIN = "fractions";

const scholar = {
  id: SCHOLAR_ID,
  name: "Scholar H",
  username: "scholar_h",
  image: null,
  readingLevel: null,
  gradeLevel: "4",
  dateOfBirth: null,
  lastMessageAt: null,
  groupIds: [],
  isMine: true,
  enrollmentStanding: "enrolled" as const,
};

function seedFixtures() {
  convex.answers.clear();
  convex.answers.set("cohortPractice:crossDomainMasteryForScholars", {
    scholars: [{ scholarId: SCHOLAR_ID, domains: [] }],
  });
  convex.answers.set("cohortPractice:masteryForScholars", {
    scholars: [{ scholarId: SCHOLAR_ID, readings: [] }],
  });
  convex.answers.set("cohortPractice:mapStatusForScholars", { scholars: [] });
  convex.answers.set("cohortPractice:fastMathForScholars", { scholars: [] });
  convex.answers.set("practiceItemPool:poolSummary", {
    domain: DOMAIN,
    nodes: [],
  });
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
    },
  ]);
  convex.answers.set("mathPlans:planEditor", {
    practiceScope: { kind: "open" },
    scopeSource: "open_default",
    checkpoint: null,
    groupCheckpoint: null,
    conflict: false,
    migrationIssue: null,
    domains: [
      {
        domain: DOMAIN,
        label: "Fractions",
        grades: ["4", "5"],
        strands: [{ strand: "equivalence", label: "Equivalence", grades: ["4"] }],
      },
    ],
  });
}

function view() {
  return createElement(MathSkillsMasteryView, {
    domain: null,
    domainLabel: "All domains",
    nodes: [],
    allDomains: true,
    domains: [{ domain: DOMAIN, label: "Fractions" }],
    selectedNode: null,
    onSelectNode: () => {},
    treeView: false,
    onToggleTreeView: () => {},
    search: "",
    onSearchChange: () => {},
    statuses: new Set<never>(),
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

/** Choose an option in a real `<select>` the way a user would, through React's
 *  own value tracker (assigning `.value` alone is invisible to React). */
async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Click, then let the presence/animation frames the dialog machines schedule
 *  actually run — a closed→open transition is not synchronous. */
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** The rail is rendered twice — once in the CSS-hidden desktop detail frame,
 *  once in the drawer. The drawer's copy is the one a narrow-screen teacher
 *  actually taps, so drive that one. */
function editButtonInDrawer() {
  return [
    ...document.querySelectorAll('[data-testid="math-plan-edit"]'),
  ].find((button) => button.closest('[role="dialog"]'));
}

/** Ark hides everything below a modal dialog; anything under that layer is
 *  present in the DOM but unreachable by pointer, keyboard, or AT. */
function underAnInertLayer(el: Element) {
  for (
    let node: Element | null = el;
    node;
    node = node.parentElement
  ) {
    if (node.getAttribute("aria-hidden") === "true") return true;
    if (node.hasAttribute("inert")) return true;
  }
  return false;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  seedFixtures();
  // Narrow viewport: `useBreakpointValue` resolves the base value, so the
  // scholar detail is presented as a modal drawer rather than a side panel.
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

describe("The math plan editor, from the scholar drawer", () => {
  it("opens a live editor instead of nothing (or a buried modal)", async () => {
    await act(async () => {
      root!.render(
        // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
        createElement(ChakraProvider, { value: system, children: view() }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const cell = document.querySelector(
      `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
    );
    expect(cell).toBeTruthy();

    await click(cell!);

    const edit = editButtonInDrawer();
    expect(edit, "the drawer shows the Math plan rail's edit action").toBeTruthy();
    // Nothing is open yet.
    expect(
      document.querySelector('[data-testid="math-plan-scope-kind"]'),
    ).toBeNull();

    await click(edit!);

    // 1. The branch that owns the drawer also mounts the editor.
    const scopeControl = document.querySelector(
      '[data-testid="math-plan-scope-kind"]',
    );
    const save = document.querySelector('[data-testid="math-plan-save"]');
    expect(scopeControl, "the Math plan editor is mounted and rendered").toBeTruthy();
    expect(save).toBeTruthy();

    // 2. …and it is genuinely reachable, not stacked under the drawer's
    //    inert layer.
    expect(underAnInertLayer(scopeControl!)).toBe(false);
    expect(underAnInertLayer(save!)).toBe(false);
    expect((save as HTMLButtonElement).disabled).toBe(false);

    // The drawer yielded the modal layer rather than fighting the editor for
    // it: exactly one open dialog on screen.
    const openDialogs = [
      ...document.querySelectorAll('[role="dialog"]'),
    ].filter((dialog) => dialog.getAttribute("data-state") !== "closed");
    expect(openDialogs).toHaveLength(1);
    expect(openDialogs[0]!.contains(scopeControl!)).toBe(true);
  });

  it("offers Open and Limited as two stacked, self-explaining rows", async () => {
    await act(async () => {
      root!.render(
        // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
        createElement(ChakraProvider, { value: system, children: view() }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );
    await click(editButtonInDrawer()!);

    const scope = document.querySelector('[data-testid="math-plan-scope-kind"]')!;
    const rows = [
      document.querySelector<HTMLElement>('[data-testid="math-plan-scope-open"]')!,
      document.querySelector<HTMLElement>(
        '[data-testid="math-plan-scope-limited"]',
      )!,
    ];
    expect(rows[0], "Open has its own row").toBeTruthy();
    expect(rows[1], "Limited has its own row").toBeTruthy();
    // Both rows sit in the main flow, one under the other — not two words in
    // the section heading.
    expect(rows.every((row) => scope.contains(row))).toBe(true);
    expect(
      rows[0]!.compareDocumentPosition(rows[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    for (const row of rows) {
      // Whole-row target: the row IS the label, so a click anywhere in it —
      // including on the supporting description — chooses that option.
      expect(row.tagName).toBe("LABEL");
      const input = row.querySelector<HTMLInputElement>('input[type="radio"]');
      expect(input, "the row is keyboard-operable as a real radio").toBeTruthy();
      expect(getComputedStyle(row).cursor).toBe("pointer");
    }
    expect(rows[0]!.textContent).toContain(
      "Every domain and strand appropriate for this scholar may be served.",
    );
    expect(rows[1]!.textContent).toContain("not served anywhere in Math skills");

    // Selection is legible without colour: the chosen row is the checked radio
    // and the bolder label.
    expect(rows[0]!.getAttribute("data-state")).toBe("checked");
    expect(rows[1]!.getAttribute("data-state")).toBe("unchecked");

    await click(rows[1]!);
    expect(
      document
        .querySelector('[data-testid="math-plan-scope-limited"]')!
        .getAttribute("data-state"),
    ).toBe("checked");
    expect(
      document
        .querySelector('[data-testid="math-plan-scope-open"]')!
        .getAttribute("data-state"),
    ).toBe("unchecked");
    expect(
      document.querySelector('[data-testid="math-plan-scope-tree"]'),
    ).toBeTruthy();
  });

  it("labels the save action in sentence case", async () => {
    await act(async () => {
      root!.render(
        // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
        createElement(ChakraProvider, { value: system, children: view() }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );
    await click(editButtonInDrawer()!);

    expect(
      document.querySelector('[data-testid="math-plan-save"]')!.textContent,
    ).toBe("Save math plan");
  });

  it("picks the checkpoint as a band grid, not two coupled dropdowns", async () => {
    await act(async () => {
      root!.render(
        // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
        createElement(ChakraProvider, { value: system, children: view() }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );
    await click(editButtonInDrawer()!);

    // The domain axis is still a select, and it still offers "No checkpoint".
    const domainSelect = document.querySelector<HTMLSelectElement>(
      '[aria-label="Checkpoint domain"]',
    )!;
    expect(domainSelect).toBeTruthy();
    expect(domainSelect.textContent).toContain("No checkpoint");
    // Strand and grade are no longer lists at all.
    expect(document.querySelector('[aria-label="Checkpoint strand"]')).toBeNull();
    expect(document.querySelector('[aria-label="Checkpoint grade"]')).toBeNull();
    expect(document.querySelector('[data-testid="checkpoint-band-grid"]')).toBeNull();

    await choose(domainSelect, DOMAIN);

    const grid = document.querySelector('[data-testid="checkpoint-band-grid"]')!;
    expect(grid, "choosing a domain reveals its band grid").toBeTruthy();
    expect(grid.getAttribute("role")).toBe("radiogroup");

    const chips = [...grid.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    // Any strand × (G4, G5) plus Equivalence × G4 — the graph holds no
    // Equivalence × G5, so that intersection is an inert dash, not a radio.
    expect(chips).toHaveLength(3);
    expect(grid.querySelectorAll('[data-testid="checkpoint-band-empty"]')).toHaveLength(1);

    // The domain landed on the first band the grid itself offers…
    const checked = chips.filter((chip) => chip.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.getAttribute("data-testid")).toBe("checkpoint-band-chip-__any-4");
    // …the chosen chip wears the corner flag, and nothing else does.
    expect(grid.querySelectorAll('[data-testid^="math-plan-corner-"]')).toHaveLength(1);
    // …and the grid keeps ONE tab stop.
    expect(chips.filter((chip) => chip.tabIndex === 0)).toHaveLength(1);

    // One click states strand AND grade together.
    await click(
      grid.querySelector('[data-testid="checkpoint-band-chip-equivalence-4"]')!,
    );
    expect(
      document
        .querySelector('[data-testid="checkpoint-band-chip-equivalence-4"]')!
        .getAttribute("aria-checked"),
    ).toBe("true");

    // Arrow keys walk the grid, skipping the hole in the Equivalence row.
    const equivalence = document.querySelector<HTMLButtonElement>(
      '[data-testid="checkpoint-band-chip-equivalence-4"]',
    )!;
    await act(async () => {
      equivalence.focus();
      equivalence.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "checkpoint-band-chip-__any-4",
    );

    // The atomic save is still the one exit, and still live.
    const save = document.querySelector<HTMLButtonElement>(
      '[data-testid="math-plan-save"]',
    )!;
    expect(save.disabled).toBe(false);
    expect(underAnInertLayer(grid)).toBe(false);
  });
});
