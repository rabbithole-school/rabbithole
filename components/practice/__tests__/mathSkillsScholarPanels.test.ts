/**
 * The Math Skills right panel, driven through the real component: the two new
 * HEADING gestures (All domains, Fast math), the Math plan's collapse at a
 * specific-focus altitude, and the plan-scope note that replaces the mapping
 * note when the work in view is not served.
 *
 * Rendered rather than source-asserted: every one of these is a reachability
 * claim ("the teacher can still press Edit while the plan is collapsed",
 * "clicking the heading again gives the panel back"), and a source assertion
 * cannot tell a mounted control from a reachable one.
 *
 * Same harness as `mathPlanEditorFromDrawer.test.ts` — react-dom/client +
 * ChakraProvider with Convex answered from fixtures; there is no React Testing
 * Library in this repo.
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

import { system } from "@/lib/theme";
import { FAST_MATH_DOMAIN } from "@/components/practice/MathSkillsDomainRail";
import { MathSkillsMasteryView } from "../MathSkillsMasteryView";
import type { PracticeScope } from "../mathPlanProjection";

const SCHOLAR_ID = "scholar-1";
const DOMAIN = "fractions";
const OTHER_DOMAIN = "geometry";

const scholar = {
  id: SCHOLAR_ID,
  name: "Kai Kahale",
  username: "kai_kahale",
  image: null,
  readingLevel: null,
  gradeLevel: "4",
  dateOfBirth: null,
  lastMessageAt: null,
  groupIds: [],
  isMine: true,
  enrollmentStanding: "enrolled" as const,
};

const EMPTY_SLICE = { automaticCount: 0, denominator: 0, percent: 0 };

function seedFixtures(scope: PracticeScope = { kind: "open" }) {
  convex.answers.clear();
  convex.answers.set("cohortPractice:crossDomainMasteryForScholars", {
    scholars: [{ scholarId: SCHOLAR_ID, domains: [] }],
  });
  convex.answers.set("cohortPractice:masteryForScholars", {
    scholars: [{ scholarId: SCHOLAR_ID, readings: [] }],
  });
  convex.answers.set("cohortPractice:mapStatusForScholars", {
    scholars: [
      {
        scholarId: SCHOLAR_ID,
        perDomain: [
          { domain: DOMAIN, status: "unmapped", blockedBy: [] },
          { domain: OTHER_DOMAIN, status: "unmapped", blockedBy: [] },
        ],
      },
    ],
  });
  convex.answers.set("cohortPractice:fastMathForScholars", {
    scholars: [
      {
        scholarId: SCHOLAR_ID,
        automaticCount: 42,
        denominator: 100,
        percent: 42,
        ready: true,
        baselineKnown: true,
        license: null,
        byOperation: { add: EMPTY_SLICE, sub: EMPTY_SLICE, mul: EMPTY_SLICE },
        byFamily: {},
      },
    ],
  });
  convex.answers.set("practiceItemPool:poolSummary", {
    domain: DOMAIN,
    nodes: [],
  });
  convex.answers.set("mathPlans:forScholars", [
    {
      scholarId: SCHOLAR_ID,
      practiceScope: scope,
      scopeSource: scope.kind === "open" ? "open_default" : "math_plan",
      migrationIssue: null,
      checkpoint: null,
      conflict: false,
      mode: "toward",
      bandSolid: 0,
      bandTotal: 0,
    },
  ]);
  convex.answers.set("mathPlans:planEditor", {
    practiceScope: scope,
    scopeSource: "math_plan",
    checkpoint: null,
    groupCheckpoint: null,
    conflict: false,
    migrationIssue: null,
    domains: [{ domain: DOMAIN, label: "Fractions", grades: ["4"], strands: [] }],
  });
}

const DOMAINS = [
  { domain: DOMAIN, label: "Fractions" },
  { domain: OTHER_DOMAIN, label: "Geometry" },
];

function view(overrides: Record<string, unknown> = {}) {
  return createElement(MathSkillsMasteryView, {
    domain: null,
    domainLabel: "All domains",
    nodes: [],
    allDomains: true,
    domains: DOMAINS,
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
    ...overrides,
  } as never);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReturnType<typeof view>) {
  await act(async () => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, { value: system, children: element }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** The panel body a narrow-screen teacher is actually looking at. */
function inDrawer(testId: string) {
  return [...document.querySelectorAll(`[data-testid="${testId}"]`)].find(
    (el) => el.closest('[role="dialog"]'),
  );
}

function heading(testId: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  seedFixtures();
  // Narrow viewport, so the detail body is presented as a modal drawer.
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

describe("All domains — the scholar heading", () => {
  it("is a real toggle that opens and clears the scholar's panel", async () => {
    await render(view());

    const header = heading(`mastery-scholar-header-${SCHOLAR_ID}`);
    expect(header, "the all-domains matrix has a scholar heading").toBeTruthy();
    expect(header!.tagName).toBe("BUTTON");
    expect(header!.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector('[data-testid="all-domains-scholar-detail"]'))
      .toBeNull();

    await click(header!);

    expect(
      heading(`mastery-scholar-header-${SCHOLAR_ID}`)!.getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(inDrawer("all-domains-scholar-detail")).toBeTruthy();

    // Clicking the selected heading again clears the focus, matching the
    // per-domain matrix.
    await click(heading(`mastery-scholar-header-${SCHOLAR_ID}`)!);
    expect(
      heading(`mastery-scholar-header-${SCHOLAR_ID}`)!.getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(inDrawer("all-domains-scholar-detail")).toBeFalsy();
  });

  it("gives the Math plan full presence and names the next gesture", async () => {
    await render(view());
    await click(heading(`mastery-scholar-header-${SCHOLAR_ID}`)!);

    const panel = inDrawer("all-domains-scholar-detail")!;
    // The plan is the subject here, so its BODY is open — not just its summary.
    expect(panel.querySelector('[data-testid="math-plan-rail"]')).toBeTruthy();
    // The fuller summary, not the one-liner — the plan is the subject here.
    expect(panel.querySelector('[data-testid="math-plan-summary"]')).toBeNull();
    expect(panel.querySelector('[data-testid="math-plan-detail"]')).toBeTruthy();
    expect(panel.textContent).toContain("Practice scope");
    // One quiet line instead of a report CTA it has no domain to open.
    expect(panel.textContent).toContain(
      "Select a domain to see Kai\u2019s reading in it.",
    );
    expect(panel.textContent).not.toContain("Open full report");
    // No checkpoint control at scholar × domain altitude: no skill is in view,
    // so no band is implied — offering one would mean a grade picker, and that
    // is the modal (D4).
    expect(
      panel.querySelector('[data-testid="checkpoint-band-control"]'),
    ).toBeNull();
  });

  it("opens Fast math detail from its scholar cell without leaving All domains", async () => {
    const selectedDomains: string[] = [];
    await render(
      view({
        onSelectDomain: (domain: string) => selectedDomains.push(domain),
      }),
    );

    await click(
      document.querySelector(
        `[data-testid="mastery-fastmath-cell-${SCHOLAR_ID}"]`,
      )!,
    );

    expect(selectedDomains).toEqual([]);
    const panel = inDrawer("fast-math-scholar-detail");
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain("42%");
    expect(panel!.textContent).toContain("Back to all domains");
  });

  it("opens the same scholar-level panel from Across all math as from the heading", async () => {
    await render(view());

    await click(
      document.querySelector(
        `[data-testid="mastery-summary-cell-${SCHOLAR_ID}"]`,
      )!,
    );

    const panel = inDrawer("all-domains-scholar-detail");
    expect(panel).toBeTruthy();
    expect(panel!.querySelector('[data-testid="math-plan-rail"]')).toBeTruthy();
    expect(panel!.textContent).toContain(
      "Select a domain to see Kai\u2019s reading in it.",
    );
  });

  it("highlights ONLY the surface that was clicked, and moves the highlight", async () => {
    await render(view());

    const header = () => heading(`mastery-scholar-header-${SCHOLAR_ID}`)!;
    const summary = () =>
      document.querySelector<HTMLElement>(
        `[data-testid="mastery-summary-cell-${SCHOLAR_ID}"]`,
      )!;

    // Heading click → heading only.
    await click(header());
    expect(header().getAttribute("aria-pressed")).toBe("true");
    expect(summary().getAttribute("aria-pressed")).toBe("false");
    expect(inDrawer("all-domains-scholar-detail")).toBeTruthy();

    // Switching to the summary cell MOVES the highlight; the panel stays.
    await click(summary());
    expect(header().getAttribute("aria-pressed")).toBe("false");
    expect(summary().getAttribute("aria-pressed")).toBe("true");
    expect(inDrawer("all-domains-scholar-detail")).toBeTruthy();

    // …and the summary cell toggles itself off.
    await click(summary());
    expect(summary().getAttribute("aria-pressed")).toBe("false");
    expect(header().getAttribute("aria-pressed")).toBe("false");
    expect(inDrawer("all-domains-scholar-detail")).toBeFalsy();
  });

  it("leaves the Fast math cell's own selection out of the scholar-only sources", async () => {
    await render(view());

    await click(
      document.querySelector(
        `[data-testid="mastery-fastmath-cell-${SCHOLAR_ID}"]`,
      )!,
    );

    expect(
      heading(`mastery-scholar-header-${SCHOLAR_ID}`)!.getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(
      document
        .querySelector(`[data-testid="mastery-summary-cell-${SCHOLAR_ID}"]`)!
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(inDrawer("fast-math-scholar-detail")).toBeTruthy();
  });
});

describe("The Math plan section", () => {
  it("is ONE click target at a specific focus — a summary, no disclosure", async () => {
    await render(view());

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );

    const summary = inDrawer("math-plan-summary");
    expect(summary, "the compact plan states both controls in one line")
      .toBeTruthy();
    expect(summary!.textContent).toContain("Open scope");

    const section = inDrawer("math-plan-edit") as HTMLButtonElement | undefined;
    expect(section).toBeTruthy();
    expect(section!.tagName).toBe("BUTTON");
    expect(section!.getAttribute("aria-label")).toBe("View or edit math plan");
    // The summary lives INSIDE the one target — clicking the words works.
    expect(section!.contains(summary!)).toBe(true);
    // No disclosure, and no nested button to compete with the section's gesture.
    expect(inDrawer("math-plan-disclosure")).toBeFalsy();
    expect(section!.querySelector("button")).toBeNull();
    expect(section!.getAttribute("aria-expanded")).toBeNull();

    // Clicking the section opens the dual-purpose view/editor.
    await click(section!);
    expect(
      document.querySelector('[data-testid="math-plan-scope-kind"]'),
    ).toBeTruthy();
  });

  it("carries the richer summary at All-domains scholar focus, still one target", async () => {
    await render(view());
    await click(heading(`mastery-scholar-header-${SCHOLAR_ID}`)!);

    const section = inDrawer("math-plan-edit") as HTMLButtonElement | undefined;
    expect(section).toBeTruthy();
    expect(section!.querySelector('[data-testid="math-plan-detail"]')).toBeTruthy();
    expect(section!.querySelector("button")).toBeNull();
    // Both authored controls are still stated, each as a named value…
    expect(section!.textContent).toContain("Practice scope");
    expect(section!.textContent).toContain("Open");
    expect(section!.textContent).toContain("Checkpoint");
    expect(section!.textContent).toContain("None");
    // …but the at-a-glance card no longer restates what the modal holds: no
    // source tag line, and no explanatory scope prose.
    expect(section!.textContent).not.toContain("Authored");
    expect(section!.textContent).not.toContain(
      "Every domain and strand appropriate",
    );
    expect(section!.textContent).not.toContain("Anything unchecked");

    await click(section!);
    expect(
      document.querySelector('[data-testid="math-plan-scope-kind"]'),
    ).toBeTruthy();
  });

  it("states a conflict in the summary and opens the same modal — no hidden repair", async () => {
    seedFixtures();
    convex.answers.set("mathPlans:forScholars", [
      {
        scholarId: SCHOLAR_ID,
        practiceScope: { kind: "limited", domains: [{ domain: OTHER_DOMAIN }] },
        scopeSource: "math_plan",
        migrationIssue: null,
        checkpoint: { domain: DOMAIN, grade: "4", source: "scholar" },
        conflict: true,
        mode: "toward",
        bandSolid: 0,
        bandTotal: 0,
      },
    ]);
    await render(view());

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );

    const section = inDrawer("math-plan-edit") as HTMLButtonElement | undefined;
    expect(section).toBeTruthy();
    expect(section!.textContent).toContain("Needs attention");
    // The repair is the editor itself, reached by the section's one gesture.
    expect(inDrawer("math-plan-repair")).toBeFalsy();
    expect(section!.querySelector("button")).toBeNull();

    await click(section!);
    expect(
      document.querySelector('[data-testid="math-plan-scope-kind"]'),
    ).toBeTruthy();
  });
});

describe("The plan-scope note", () => {
  it("replaces the mapping note for a domain the plan excludes", async () => {
    seedFixtures({
      kind: "limited",
      domains: [{ domain: OTHER_DOMAIN }],
    });
    await render(view());

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );

    const strip = inDrawer("math-plan-scope-strip");
    expect(strip, "the excluded domain gets the not-served note").toBeTruthy();
    expect(strip!.textContent).toContain("Not served");
    expect(strip!.textContent).toContain(
      "Fractions is outside Kai\u2019s Math plan",
    );
    // …and mapping guidance is gone, because it is not a next action here.
    expect(inDrawer("domain-map-status-strip")).toBeFalsy();
  });

  it("leaves the mapping note alone for a domain the plan serves", async () => {
    seedFixtures({ kind: "limited", domains: [{ domain: DOMAIN }] });
    await render(view());

    await click(
      document.querySelector(
        `[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`,
      )!,
    );

    expect(inDrawer("math-plan-scope-strip")).toBeFalsy();
    expect(inDrawer("domain-map-status-strip")).toBeTruthy();
  });
});

describe("Fast math — the scholar heading", () => {
  it("selects the scholar and states the one overall reading", async () => {
    await render(
      view({
        allDomains: false,
        fastMathView: true,
        domain: FAST_MATH_DOMAIN,
        domainLabel: "Fast math",
      }),
    );

    const header = heading(`fast-math-scholar-header-${SCHOLAR_ID}`);
    expect(header, "the Fast math matrix has a scholar heading").toBeTruthy();
    expect(header!.tagName).toBe("BUTTON");
    expect(header!.getAttribute("aria-pressed")).toBe("false");

    await click(header!);

    expect(
      heading(`fast-math-scholar-header-${SCHOLAR_ID}`)!.getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    const panel = inDrawer("fast-math-scholar-detail");
    expect(panel).toBeTruthy();
    // The canonical overall reading, from the same helper the matrix cell uses.
    expect(panel!.textContent).toContain("42%");
    // One escalation, and none of the report's own contents restated.
    expect(panel!.querySelector('[data-testid="fast-math-open-report"]'))
      .toBeTruthy();
    expect(panel!.textContent).not.toContain("Addition");
    // No plan rail: this view is one fixed slice, so there is no scope decision
    // to read here.
    expect(panel!.querySelector('[data-testid="math-plan-rail"]')).toBeNull();

    await click(heading(`fast-math-scholar-header-${SCHOLAR_ID}`)!);
    expect(inDrawer("fast-math-scholar-detail")).toBeFalsy();
  });

  it("leaves the cell's heavier gesture alone — it still opens the report", async () => {
    const opened: string[] = [];
    await render(
      view({
        allDomains: false,
        fastMathView: true,
        domain: FAST_MATH_DOMAIN,
        domainLabel: "Fast math",
        onOpenReport: (id: string) => opened.push(id),
      }),
    );

    const cell = document.querySelector(
      `[data-testid="fast-math-cell-operation-add-${SCHOLAR_ID}"]`,
    );
    expect(cell).toBeTruthy();
    await click(cell!);
    expect(opened).toEqual([SCHOLAR_ID]);
  });
});


/**
 * The two matrix NITS, asserted on the rendered surface because both are
 * questions about computed style — a source assertion can say a prop was
 * written, not that it reached the element.
 */
function cursorOf(selector: string) {
  const el = document.querySelector(selector);
  expect(el, `${selector} is on the page`).toBeTruthy();
  return getComputedStyle(el!).cursor;
}

/** Everything the selection ring must NOT move when it appears. */
function geometryOf(el: Element) {
  const style = getComputedStyle(el);
  return {
    cursor: style.cursor,
    padBlock: style.getPropertyValue("padding-block"),
    padInline: style.getPropertyValue("padding-inline"),
    borderTopWidth: style.borderTopWidth,
    borderBottomWidth: style.borderBottomWidth,
    borderLeftWidth: style.borderLeftWidth,
    borderRightWidth: style.borderRightWidth,
    alignItems: style.alignItems,
    justifyContent: style.justifyContent,
    gap: style.gap,
  };
}

describe("The scholar heading's geometry", () => {
  it("keeps one balanced, centred footprint whether or not it is selected", async () => {
    await render(view());

    const header = heading(`mastery-scholar-header-${SCHOLAR_ID}`)!;
    const unselected = geometryOf(header);

    // Balanced: equal padding on both axes, and the avatar/name stack centred
    // inside it — not hugged to one edge.
    expect(unselected.padBlock).toBe("2px");
    expect(unselected.padInline).not.toBe("");
    expect(unselected.alignItems).toBe("center");
    expect(unselected.justifyContent).toBe("center");
    // The unselected ring is transparent, never absent, so selecting cannot
    // nudge the column (Chakra is border-box).
    expect(unselected.borderTopWidth).toBe("1px");
    expect(unselected.borderBottomWidth).toBe("1px");
    expect(unselected.borderLeftWidth).toBe("1px");
    expect(unselected.borderRightWidth).toBe("1px");

    await click(header);
    const selected = heading(`mastery-scholar-header-${SCHOLAR_ID}`)!;
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(geometryOf(selected)).toEqual(unselected);
  });

  it("gives the Fast math heading the SAME treatment, not a second one", async () => {
    await render(view());
    const allDomains = geometryOf(heading(`mastery-scholar-header-${SCHOLAR_ID}`)!);

    await render(
      view({
        allDomains: false,
        fastMathView: true,
        domain: FAST_MATH_DOMAIN,
        domainLabel: "Fast math",
      }),
    );
    expect(
      geometryOf(heading(`fast-math-scholar-header-${SCHOLAR_ID}`)!),
    ).toEqual(allDomains);
  });
});

describe("Pointer affordance in the matrices", () => {
  it("shows a pointer on every interactive all-domains surface", async () => {
    await render(view({ onSelectDomain: () => {} }));

    expect(cursorOf(`[data-testid="mastery-scholar-header-${SCHOLAR_ID}"]`)).toBe(
      "pointer",
    );
    expect(cursorOf(`[data-testid="mastery-domain-row-${DOMAIN}"]`)).toBe(
      "pointer",
    );
    expect(
      cursorOf(`[data-testid="mastery-domain-cell-${DOMAIN}-${SCHOLAR_ID}"]`),
    ).toBe("pointer");
    expect(cursorOf('[data-testid="mastery-fastmath-row"]')).toBe("pointer");
    expect(cursorOf(`[data-testid="mastery-fastmath-cell-${SCHOLAR_ID}"]`)).toBe(
      "pointer",
    );
  });

  it("leaves a label with no gesture on the default cursor", async () => {
    // No `onSelectDomain`: the domain label opens nothing, so it stays inert.
    await render(view());
    expect(cursorOf(`[data-testid="mastery-domain-row-${DOMAIN}"]`)).not.toBe(
      "pointer",
    );
  });

  it("shows a pointer on the Fast math heading, family label and cells", async () => {
    await render(
      view({
        allDomains: false,
        fastMathView: true,
        domain: FAST_MATH_DOMAIN,
        domainLabel: "Fast math",
      }),
    );

    expect(cursorOf(`[data-testid="fast-math-scholar-header-${SCHOLAR_ID}"]`)).toBe(
      "pointer",
    );
    expect(
      cursorOf(`[data-testid="fast-math-cell-operation-add-${SCHOLAR_ID}"]`),
    ).toBe("pointer");
    // A fact-family row's label drills into that family …
    expect(
      cursorOf('[data-testid^="fast-math-row-family-"] > div > *:first-child'),
    ).toBe("pointer");
    // … while the operation GROUP label above it is a heading, not a target.
    expect(
      cursorOf('[data-testid="fast-math-row-operation-add"] > div > *:first-child'),
    ).not.toBe("pointer");
  });
});
