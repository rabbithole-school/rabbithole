/**
 * remarkHardBreaks — a tiny, dependency-free remark plugin that turns single
 * newlines inside a paragraph into hard line breaks (<br>), the way a chat UI
 * is expected to behave.
 *
 * Why: CommonMark treats a single `\n` inside a paragraph as a SOFT break, which
 * HTML collapses to a space. The aides (Curriculum Bot, profile aide) routinely
 * write short single-newline-separated lines — e.g. a "here's what I built"
 * recap of Unit / Lesson / Activity — expecting each on its own line. Without
 * this, those lines run together into one wrapped paragraph.
 *
 * This is the same transform the published `remark-breaks` performs (soft line
 * ending → `break` node), hand-rolled here to avoid a new dependency, matching
 * the local `remarkInlineMath` convention. `code`/`inlineCode` are leaf nodes
 * (no `children`), so their embedded newlines are never touched; structural
 * newlines between blocks/list-items live outside text nodes, so lists, tables,
 * and code fences are unaffected.
 */

// Minimal mdast shapes — avoids a dep on @types/mdast.
type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
};

function splitHardBreaks(value: string): MdNode[] | null {
  if (!value.includes("\n")) return null;
  const out: MdNode[] = [];
  const parts = value.split("\n");
  parts.forEach((part, i) => {
    if (i > 0) out.push({ type: "break" });
    if (part) out.push({ type: "text", value: part });
  });
  return out;
}

// Depth-first: replace any text child that contains a newline with a run of
// text + break nodes. Skips code/inlineCode subtrees (leaf nodes anyway).
function walk(node: MdNode): void {
  if (!node.children || node.children.length === 0) return;
  if (node.type === "code" || node.type === "inlineCode") return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const rewritten = splitHardBreaks(child.value);
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

export function remarkHardBreaks() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
