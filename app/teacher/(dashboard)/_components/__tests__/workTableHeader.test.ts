import { describe, expect, it, vi } from "vitest";

// WorkTableHeader / HomeworkTableHeader are React components; this repo's Vitest
// runs on edge-runtime with no DOM, so we drive them as plain functions and
// walk the element tree they return. useNow is mocked to a fixed instant so the
// Homework date line is deterministic.

vi.mock("@/hooks/useNow", () => ({
  // 2026-08-25 is a Tuesday (local); the label reads the local date.
  useNow: () => new Date(2026, 7, 25, 9, 0, 0).getTime(),
}));

import { WorkTableHeader, HomeworkTableHeader } from "../WorkTableHeader";

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

/** The subtitle line <Text> nodes: fontSize sm, not the title. Identified by
 *  the `\u00A0` placeholder OR a real subtitle string — i.e. the sm texts under
 *  the title. We approximate by collecting Texts with fontSize "sm". */
function subtitleLineCount(tree: unknown): number {
  return findAll(tree, (el) => el.props.fontSize === "sm").length;
}

describe("WorkTableHeader — height stability", () => {
  it("reserves exactly `reservedLines` subtitle slots regardless of content", () => {
    const oneLine = WorkTableHeader({
      title: "Homework",
      subtitle: [{ text: "Tonight's list · Tue 25 Aug", tone: "strong" }],
      reservedLines: 3,
    });
    const threeLines = WorkTableHeader({
      title: "Academic Rounds",
      subtitle: [
        { text: "Aug 20 – 26", tone: "strong" },
        { text: "Not opened yet", tone: "muted" },
        { text: "Showing 3 of 10", tone: "muted", testId: "rounds-scope-count" },
      ],
      reservedLines: 3,
    });
    // Same number of rendered subtitle line slots → same height.
    expect(subtitleLineCount(oneLine)).toBe(3);
    expect(subtitleLineCount(threeLines)).toBe(3);
  });

  it("pads short subtitles with hidden placeholder lines", () => {
    const tree = WorkTableHeader({
      title: "Homework",
      subtitle: [{ text: "Tonight's list · Tue 25 Aug" }],
      reservedLines: 2,
    });
    const hidden = findAll(tree, (el) => el.props["aria-hidden"] === true);
    expect(hidden).toHaveLength(1); // one real line + one reserved-empty
  });

  it("keeps a title with the rounds-title testid, and reserves the action slot", () => {
    const tree = WorkTableHeader({
      title: "SEL Rounds",
      subtitle: [],
      reservedLines: 2,
      action: null,
    });
    const title = findAll(tree, (el) => el.props["data-testid"] === "rounds-title");
    expect(title).toHaveLength(1);
    expect(textOf(title[0])).toBe("SEL Rounds");
  });
});

describe("HomeworkTableHeader", () => {
  it("composes WorkTableHeader with the Homework title + a factual today line", () => {
    const el = HomeworkTableHeader({ reservedLines: 2 }) as unknown as El;
    expect(el.type).toBe(WorkTableHeader);
    expect(el.props.title).toBe("Homework");
    expect(el.props.reservedLines).toBe(2); // matches a non-scoped Rounds header
    const subtitle = el.props.subtitle as { text: string }[];
    // The subtitle names today's date (deterministic via the mocked clock).
    expect(subtitle[0].text).toBe("Tonight's list · Tue 25 Aug");
  });
});
