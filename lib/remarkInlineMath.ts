/**
 * remarkInlineMath — a tiny, dependency-free remark plugin that turns the
 * tutor's `$...$` (inline) and `$$...$$` (display) math into elements the chat
 * markdown renderer paints with <MathText> (stacked fractions).
 *
 * Why hand-rolled instead of remark-math: remark-math treats every `$` as a
 * math fence, so a money word problem ("You have $5 and spend $3") renders as
 * garbled math. We reuse `splitMathSegments` (shared/mathLatex) whose currency
 * guard only treats a `$...$` run as math when it actually looks like math (a
 * LaTeX macro or a bare fraction) — so "$5" stays literal. It also needs no new
 * dependency, keeping Phase 1 of the fraction-rendering plan dependency-free.
 *
 * `$` survives CommonMark unescaped (unlike `\(...\)`, which is stripped to
 * `(...)`), so splitting on already-parsed mdast text nodes is safe.
 *
 * Each math run becomes a passthrough element rendered as:
 *   <span class="rh-math" data-display="0|1">LATEX</span>
 * which the `span` entry in chatMarkdownComponents swaps for <MathText>.
 */

import { splitMathSegments } from "@/shared/mathLatex";

// Minimal mdast shapes — avoids a dep on @types/mdast.
type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

export const RH_MATH_CLASS = "rh-math";

function mathElement(latex: string, display: boolean): MdNode {
  return {
    type: "element",
    data: {
      hName: "span",
      hProperties: { className: [RH_MATH_CLASS], "data-display": display ? "1" : "0" },
    },
    children: [{ type: "text", value: latex }],
  };
}

function rewriteText(value: string): MdNode[] | null {
  const segments = splitMathSegments(value);
  if (!segments.some((s) => s.type === "math")) return null;
  return segments.map((s) =>
    s.type === "text" ? { type: "text", value: s.value } : mathElement(s.latex, s.display),
  );
}

// Depth-first: replace any text child that contains math with a run of text +
// math element nodes. Skips code/inlineCode subtrees (never math there).
function walk(node: MdNode): void {
  if (!node.children || node.children.length === 0) return;
  if (node.type === "code" || node.type === "inlineCode") return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const rewritten = rewriteText(child.value);
      if (rewritten) {
        next.push(...rewritten);
        continue;
      }
    } else if (child.type !== "inlineCode" && child.type !== "code") {
      walk(child);
    }
    next.push(child);
  }
  node.children = next;
}

export function remarkInlineMath() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
