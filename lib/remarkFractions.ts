/**
 * remarkFractions — a tiny, dependency-free remark plugin that finds bare ASCII
 * fractions ("3/4", "9 4/9", "?/9") in the tutor's prose and marks them for the
 * chat markdown renderer to paint as stacked fractions (<FractionText>).
 *
 * WHY no `$...$` delimiters: the tutor writes fractions the plain way a teacher
 * would ("2/8 is less than 1/2"), so we auto-detect them straight from the text —
 * no LaTeX, no math fences. The shared `scanFractions` regex is deliberately
 * conservative (its lookbehind/lookahead guards reject decimals like "1.2/3",
 * word-slashes like "and/or", and URLs), and "$5" / "$3" money amounts have no
 * slash so they are never touched. (A date like "3/4" is an accepted, rare
 * false-positive; the tutor prompt asks it to spell dates out.)
 *
 * Each fraction run becomes a passthrough element rendered as:
 *   <span class="rh-frac">9 4/9</span>
 * which the `span` entry in chatMarkdownComponents swaps for <FractionText>.
 */

import { scanFractions } from "@/shared/fractions";

// Minimal mdast shapes — avoids a dep on @types/mdast.
type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

export const RH_FRAC_CLASS = "rh-frac";

function fracElement(value: string): MdNode {
  return {
    type: "element",
    data: {
      hName: "span",
      hProperties: { className: [RH_FRAC_CLASS] },
    },
    children: [{ type: "text", value }],
  };
}

function rewriteText(value: string): MdNode[] | null {
  const segments = scanFractions(value);
  if (!segments.some((s) => s.type === "frac")) return null;
  return segments.map((s) =>
    s.type === "text" ? { type: "text", value: s.value } : fracElement(s.value),
  );
}

// Depth-first: replace any text child that contains a fraction with a run of
// text + fraction element nodes. Skips code/inlineCode subtrees (a "3/4" in code
// is literal, not math).
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

export function remarkFractions() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
