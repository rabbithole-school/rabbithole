import { beforeEach, describe, expect, it, vi } from "vitest";

// ScholarWorkTable is the one persistent table behind Homework · Academic
// Rounds · SEL Rounds. This repo's Vitest runs on edge-runtime with no DOM, so
// we drive it as a plain function and walk the element tree it returns. Hooks
// are mocked to stay deterministic; child components (Avatar, RoundsRowContent,
// HomeworkContent, NextLink) are never invoked, only inspected as element nodes
// — so the grade math (real `gradeForAgeFromDob`) and the row structure are
// what we assert.

const state: unknown[] = [];
let stateIndex = 0;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => {
      const index = stateIndex++;
      if (!(index in state)) {
        state[index] = typeof init === "function" ? (init as () => T)() : init;
      }
      const setter = (value: T | ((prev: T) => T)) => {
        state[index] =
          typeof value === "function"
            ? (value as (prev: T) => T)(state[index] as T)
            : value;
      };
      return [state[index] as T, setter] as const;
    },
    useMemo: <T,>(factory: () => T) => factory(),
  };
});

const { homeworkResultsRef } = vi.hoisted(() => ({
  homeworkResultsRef: { current: {} as Record<string, unknown> },
}));

vi.mock("convex/react", () => ({
  useQueries: () => homeworkResultsRef.current,
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
}));
vi.mock("@/components/rounds/useScholarBatches", () => ({
  useBatchedScholarRows: () => ({ byId: new Map(), loading: false, failed: false }),
}));
vi.mock("@/hooks/useNow", () => ({ useNow: () => 1_700_000_000_000 }));

import { ScholarWorkTable } from "../ScholarWorkTable";
import { RoundsRowContent } from "@/components/rounds/RoundsRowContent";
import { ScholarWorkRow } from "../ScholarWorkTable";
import { HomeworkContent } from "../HomeworkContent";
import type { Scholar } from "../types";

type El = { type: unknown; props: Record<string, unknown> };

function isEl(node: unknown): node is El {
  return !!node && typeof node === "object" && "props" in node;
}
function walk(node: unknown, visit: (el: El) => void): void {
  if (node == null || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (isEl(node)) {
    visit(node);
    walk(node.props.children, visit);
  }
}
function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const out: El[] = [];
  walk(node, (el) => {
    if (pred(el)) out.push(el);
  });
  return out;
}
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isEl(node)) return textOf(node.props.children);
  return "";
}

function scholar(id: string, name: string, dateOfBirth: string | null): Scholar {
  return {
    id,
    name,
    dateOfBirth,
    enrollmentStanding: "enrolled",
    readingLevel: null,
    sessionCount: 0,
    messageCount: 0,
    lastActive: 0,
    statusSummary: null,
    pulseScore: null,
    lastMessage: null,
    lastMessageAt: null,
    lastSessionTitle: null,
    processStep: null,
    processTitle: null,
  };
}

const OLDER = scholar("s1", "Older", "2015-01-01"); // higher grade
const YOUNGER = scholar("s2", "Younger", "2019-01-01"); // lower grade
const NODOB = scholar("s3", "No DOB", null);

const href = (id: string) => `/x/${id}`;
const onToggleSort = vi.fn();

function render(props: Partial<Parameters<typeof ScholarWorkTable>[0]> = {}) {
  stateIndex = 0;
  return ScholarWorkTable({
    tab: "homework",
    scholars: [OLDER, YOUNGER, NODOB],
    sortDir: "asc",
    onToggleSort,
    hrefForScholar: href,
    week: undefined,
    weekKey: null,
    ...props,
  }) as unknown;
}

/** Row anchors (ScholarWorkRow elements), in document (render) order. Each
 *  carries `href`, `gradeForAge`, `isRounds`, and its content `children`. */
function rowEls(tree: unknown): El[] {
  return findAll(
    tree,
    (el) => "gradeForAge" in el.props && "href" in el.props && "isRounds" in el.props,
  );
}
function rowHrefs(tree: unknown): string[] {
  return rowEls(tree).map((el) => el.props.href as string);
}
function rowGrades(tree: unknown): (number | null)[] {
  return rowEls(tree).map((el) => el.props.gradeForAge as number | null);
}

beforeEach(() => {
  state.length = 0;
  homeworkResultsRef.current = {};
  onToggleSort.mockClear();
});

describe("ScholarWorkTable grade column + sort", () => {
  it("sorts ascending grade-for-age (youngest first), null DOB last", () => {
    const tree = render({ sortDir: "asc" });
    expect(rowHrefs(tree)).toEqual(["/x/s2", "/x/s1", "/x/s3"]);
    // The null-DOB row's grade is null (renders the em-dash cell).
    expect(rowGrades(tree).at(-1)).toBeNull();
  });

  it("sorts descending (oldest first), null DOB still last", () => {
    const tree = render({ sortDir: "desc" });
    expect(rowHrefs(tree)).toEqual(["/x/s1", "/x/s2", "/x/s3"]);
    expect(rowGrades(tree).at(-1)).toBeNull();
  });

  it("the Grade header cycles the sort via the lifted onToggleSort", () => {
    const tree = render();
    const header = findAll(tree, (el) => el.props["data-testid"] === "rounds-sort-grade");
    expect(header).toHaveLength(1);
    (header[0].props.onClick as () => void)();
    expect(onToggleSort).toHaveBeenCalledTimes(1);
  });

  it("marks the header aria-sort to match the direction", () => {
    const asc = findAll(render({ sortDir: "asc" }), (el) => el.props["aria-sort"] !== undefined);
    expect(asc[0].props["aria-sort"]).toBe("ascending");
    const desc = findAll(render({ sortDir: "desc" }), (el) => el.props["aria-sort"] !== undefined);
    expect(desc[0].props["aria-sort"]).toBe("descending");
  });
});

describe("ScholarWorkTable — Homework tab", () => {
  it("renders the homework-list container and a HomeworkContent cell per row", () => {
    const tree = render({ tab: "homework" });
    expect(findAll(tree, (el) => el.props["data-testid"] === "homework-list")).toHaveLength(1);
    // Three rows, each a non-rounds anchor whose content cell is HomeworkContent.
    const rows = rowEls(tree);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.props.isRounds === false)).toBe(true);
    expect(findAll(tree, (el) => el.type === HomeworkContent)).toHaveLength(3);
  });
});

describe("ScholarWorkTable — Rounds tab", () => {
  const weekScholar = (id: string, name: string) => ({
    scholarId: id,
    scholarName: name,
    dateOfBirth: "2017-05-01",
    entryId: `e-${id}`,
    note: null,
    noteVersion: null,
    discussedAt: null,
    discussedByName: null,
    previous: null,
    observations: [],
    mastery: [],
    practice: { attempts: 0, correct: 0, nodes: 0, lastAttemptAt: null },
    pulse: null,
    guidance: [],
  });

  const week = {
    configured: true,
    weekLabel: "20 Aug",
    window: { startMs: 1_000, endMs: 2_000 },
    institutionId: "inst1",
    meeting: null,
    scholars: [weekScholar("s1", "Older"), weekScholar("s2", "Younger")],
  };

  it("uses rounds anchors and joins week content by scholarId", () => {
    const tree = render({
      tab: "academic-rounds",
      week: week as never,
      weekKey: "2026-08-20",
    });
    expect(findAll(tree, (el) => el.props["data-testid"] === "scholar-work-table")).toHaveLength(1);
    const rows = rowEls(tree);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.props.isRounds === true)).toBe(true);
    // The two in-period scholars get RoundsRowContent as their content cell; the
    // DOB-less s3 (absent from the week payload) gets the muted "not in this
    // reporting period" cell.
    const contentTypes = rows.map((r) => (r.props.children as El | null)?.type);
    expect(contentTypes.filter((t) => t === RoundsRowContent)).toHaveLength(2);
    expect(textOf(tree)).toContain("Not in this reporting period");
  });

  it("shows a per-cell placeholder (not a blank column) while the week loads", () => {
    const tree = render({ tab: "academic-rounds", week: undefined, weekKey: "2026-08-20" });
    const rows = rowEls(tree);
    // Rows + grades still render immediately from the roster…
    expect(rows).toHaveLength(3);
    expect(rowGrades(tree).filter((g) => g !== null)).toHaveLength(2);
    // …and no RoundsRowContent yet (content cells are placeholders).
    expect(rows.map((r) => (r.props.children as El | null)?.type).filter((t) => t === RoundsRowContent)).toHaveLength(0);
  });
});

describe("ScholarWorkRow — column structure (long names don't wander the content edge)", () => {
  function renderRow(name: string) {
    return ScholarWorkRow({
      scholarId: "s1",
      name,
      image: null,
      gradeForAge: 2.4,
      href: "/x/s1",
      isRounds: true,
      ariaLabel: `${name} — open`,
      topBorder: false,
      children: null,
    }) as unknown;
  }

  const GRADE_COL_W_STR = "3rem";
  /** The identity cell: the HStack that holds the Avatar + the name Text. It is
   *  the structural column whose width must be FIXED so the content cell shares
   *  one left edge across rows. Located as the ancestor HStack of the name Text
   *  (the node carrying `title={name}`). */
  function identityCell(tree: unknown, name: string): El | undefined {
    return findAll(tree, (el) => findAll(el, (c) => c.props.title === name).length > 0).find(
      (el) => el.props.w !== undefined && el.props.w !== GRADE_COL_W_STR,
    );
  }

  it("gives the identity column a FIXED width (not a min-width)", () => {
    const cell = identityCell(
      renderRow("Alexandria Montgomery-Rivera"),
      "Alexandria Montgomery-Rivera",
    );
    expect(cell).toBeDefined();
    // A responsive fixed width, and it does NOT shrink (flexShrink 0) so the
    // content cell always starts at the same x regardless of name length.
    expect(cell!.props.w).toMatchObject({ md: expect.any(String) });
    expect(cell!.props.flexShrink).toBe(0);
    // The width is IDENTICAL for a short and a long name — that's the fix.
    expect(identityCell(renderRow("Kai"), "Kai")!.props.w).toEqual(cell!.props.w);
  });

  it("truncates a long name with an ellipsis + full-name title, keeping minW 0", () => {
    const name = "Alexandria Montgomery-Rivera";
    const nameText = findAll(renderRow(name), (el) => el.props.title === name);
    expect(nameText).toHaveLength(1);
    expect(nameText[0].props.lineClamp).toBe(1);
    expect(nameText[0].props.minW).toBe(0); // required for lineClamp to shrink
  });
});
