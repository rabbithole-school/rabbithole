import { describe, expect, it, vi } from "vitest";

// The Rounds row CONTENT (headline + evidence/guidance chips + note, or the SEL
// synthesis shape) moved out of the old RoundsWeekBoard `ScholarRow` into
// `RoundsRowContent`. This repo's Vitest runs on edge-runtime with no DOM, so —
// as before — we drive the component as a plain function and walk the element
// tree it returns. `useMemo` is passed through so the pure derivations run.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
  };
});

import { RoundsRowContent } from "../RoundsRowContent";
import { NO_EVIDENCE_HEADLINE, type RoundsEvidenceInput } from "../roundsEvidence";
import type { SelSynthesisRow } from "../selSynthesisView";

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

function silentScholar(id: string, name: string) {
  return {
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
  };
}

function evidence(over: Partial<RoundsEvidenceInput> = {}): RoundsEvidenceInput {
  return {
    observations: over.observations ?? [],
    mastery: over.mastery ?? [],
    practice: over.practice ?? { attempts: 0, correct: 0, nodes: 0, lastAttemptAt: null },
    pulse: over.pulse ?? null,
  };
}

function render(props: Parameters<typeof RoundsRowContent>[0]) {
  return RoundsRowContent(props) as unknown;
}

function chipTexts(tree: unknown): string[] {
  return findAll(tree, (el) => !!el.props.chip).map(
    (el) => (el.props.chip as { text: string }).text,
  );
}

describe("RoundsRowContent", () => {
  it("promotes the academic evidence density and guidance", () => {
    const scholar = {
      ...silentScholar("s1", "Kai Kahale"),
      ...evidence({
        observations: [
          { _id: "o1", type: "note", note: "hi", weight: "minor", at: 1, teacherName: "Lehua Torres" },
        ],
        practice: { attempts: 4, correct: 3, nodes: 2, lastAttemptAt: 2 },
      }),
      guidance: [{ _id: "g1", label: "Sit near the front", expiresAt: null }],
    };
    const tree = render({
      scholar: scholar as never,
      cadence: "academic",
      synthesis: null,
      synthesisLoading: false,
    });
    expect(chipTexts(tree)).toEqual(["1 note · practice", "1 guidance running"]);
  });

  it("renders the quiet no-evidence headline with no evidence chip", () => {
    const tree = render({
      scholar: silentScholar("s1", "Kai Kahale") as never,
      cadence: "academic",
      synthesis: null,
      synthesisLoading: false,
    });
    expect(textOf(tree)).toContain(NO_EVIDENCE_HEADLINE);
    expect(chipTexts(tree)).toEqual([]);
  });

  it("uses the SEL synthesis shape for the SEL lens", () => {
    const synthesis: SelSynthesisRow = {
      strengths: [{ text: "Kind to a new scholar", cites: [] }],
      watch: [{ text: "Quieter in group work", cites: [] }],
      quiet: false,
      generatedAt: 1,
    };
    const tree = render({
      scholar: silentScholar("s1", "Kai Kahale") as never,
      cadence: "sel",
      synthesis,
      synthesisLoading: false,
    });
    expect(textOf(tree)).toContain("Kind to a new scholar");
    expect(chipTexts(tree)).toContain("1 strength · 1 to watch");
  });
});
