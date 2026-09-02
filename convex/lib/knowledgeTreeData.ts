/**
 * Knowledge Tree — code-backed prerequisite DAG (the "daylight" lens).
 *
 * Phase 2 of the Learning Lenses plan: a curated, STABLE map (never
 * LLM-generated at read-time) so a teacher can challenge it. This is the
 * fractions fixture; the math edges mirror the CCSS-M coherence map
 * (Student Achievement Partners / CZI `buildsTowards`). A second,
 * deliberately non-hierarchical humanities fixture lives below to pressure-
 * test that the model degrades gracefully when prereq edges are sparse.
 *
 * See review/learning-lenses-plan.md ("How a gap is detected", "Source of truth").
 */

export type TreeNode = {
  key: string;
  label: string;
  /** CCSS code — the Standards *tag* that rides on the node, not a lens. */
  standard?: string;
  /** Lowercase keywords used to match observer concept labels → this node. */
  match: string[];
};

export type TreeEdge = {
  from: string;
  to: string;
  /** soft `buildsTowards` (support) vs hard `requires` (gate). */
  kind: "buildsTowards" | "requires";
};

export type KnowledgeTree = {
  domain: string;
  nodes: TreeNode[];
  edges: TreeEdge[];
};

export const FRACTIONS_TREE: KnowledgeTree = {
  domain: "Fractions",
  nodes: [
    { key: "partition", label: "Partition a whole", standard: "3.G.A.2", match: ["partition", "equal parts", "share equally", "halves", "split"] },
    { key: "equivalent", label: "Equivalent fractions", standard: "3.NF.A.3", match: ["equivalent fraction", "equivalence", "same fraction", "fair trade", "fair trades"] },
    { key: "quantity", label: "Fraction as a quantity", standard: "3.NF.A.2", match: ["fraction as a number", "number line", "fraction as quantity", "magnitude"] },
    { key: "compare", label: "Compare by size", standard: "4.NF.A.2", match: ["compare", "greater than", "bigger fraction", "order fractions", "1/8", "1/4"] },
    { key: "addsub", label: "Add / subtract fractions", standard: "4.NF.B.3", match: ["add fraction", "subtract fraction", "sum of fractions"] },
    { key: "commondenom", label: "Common denominators", standard: "5.NF.A.1", match: ["common denominator", "unlike denominator"] },
  ],
  edges: [
    { from: "partition", to: "equivalent", kind: "buildsTowards" },
    { from: "partition", to: "quantity", kind: "buildsTowards" },
    { from: "equivalent", to: "addsub", kind: "buildsTowards" },
    { from: "quantity", to: "addsub", kind: "buildsTowards" },
    { from: "compare", to: "addsub", kind: "requires" },
    { from: "addsub", to: "commondenom", kind: "buildsTowards" },
  ],
};

/**
 * Historical Thinking — the cross-discipline pressure test. A WIDE, SHALLOW web:
 * lateral `buildsTowards` only here and there, no deep prereq chains (math
 * builds on itself; the humanities don't). Gap detection should lean almost
 * entirely on misconceptions, not blocking-prereqs, here.
 */
export const HISTORICAL_THINKING_TREE: KnowledgeTree = {
  domain: "Historical thinking",
  nodes: [
    { key: "sourcing", label: "Sourcing a document", match: ["sourcing", "who wrote", "author's purpose", "primary source"] },
    { key: "context", label: "Contextualization", match: ["context", "historical context", "at the time"] },
    { key: "corroborate", label: "Corroboration", match: ["corroborate", "compare sources", "multiple sources"] },
    { key: "evidence", label: "Evidence vs. inference", match: ["evidence", "inference", "claim and evidence"] },
    { key: "change", label: "Change & continuity", match: ["change over time", "continuity"] },
    { key: "causation", label: "Causation", match: ["cause", "causation", "multiple causes"] },
  ],
  edges: [
    { from: "sourcing", to: "corroborate", kind: "buildsTowards" },
    { from: "evidence", to: "causation", kind: "buildsTowards" },
  ],
};

export const TREES: Record<string, KnowledgeTree> = {
  fractions: FRACTIONS_TREE,
  historicalThinking: HISTORICAL_THINKING_TREE,
};
