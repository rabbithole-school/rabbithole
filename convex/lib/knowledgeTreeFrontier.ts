/**
 * Pure frontier + gap computation for the Knowledge Tree lens — no Convex deps,
 * so it's unit-testable. The Convex query (convex/knowledgeTree.ts) maps stored
 * masteryObservations onto `ObsLite` and calls computeFrontier().
 *
 * Gap logic (see review/learning-lenses-plan.md): a gap is never "not yet
 * demonstrated" (that's the whole unexplored tree). A node is a gap only when
 * it's BOTH unmet/mis-held AND load-bearing for where the learner is now —
 * ① an open misconception on the node, or ② an unmet prerequisite of an active
 * (frontier/probed) node. Everything else unmet-but-not-load-bearing is "locked".
 */

import type { KnowledgeTree } from "./knowledgeTreeData";

export type NodeStatus =
  | "demonstrated"
  | "frontier"
  | "gap"
  | "probed"
  | "locked";

/** One observation reduced to what the frontier computation needs. */
export type ObsLite = {
  conceptLabel: string;
  masteryLevel: number;
  evidenceType: string;
  misconceptionStatus?: string;
  evidenceSummary?: string;
  fluencyLevel?: number;
};

export type FrontierNode = {
  key: string;
  label: string;
  standard?: string;
  status: NodeStatus;
  gapReason?: string;
  evidence?: string;
  /** 1–3 automaticity diamonds, present only where a real fluency signal exists. */
  fluency?: number;
};

export type FrontierResult = {
  domain: string;
  nodes: FrontierNode[];
  edges: KnowledgeTree["edges"];
};

type Match = {
  demonstrated: boolean;
  probed: boolean;
  openMisconception: boolean;
  evidence?: string;
  fluency?: number;
};

const DEMONSTRATED_THRESHOLD = 2.5; // ≥ "apply" on the 0–5 Bloom scale

function matchObservations(
  tree: KnowledgeTree,
  obs: ObsLite[],
): Map<string, Match> {
  const byNode = new Map<string, Match>();
  for (const node of tree.nodes) {
    const m: Match = { demonstrated: false, probed: false, openMisconception: false };
    for (const o of obs) {
      const label = o.conceptLabel.toLowerCase();
      if (!node.match.some((kw) => label.includes(kw))) continue;
      m.evidence = o.evidenceSummary;
      if (typeof o.fluencyLevel === "number") {
        m.fluency = Math.max(m.fluency ?? 0, o.fluencyLevel);
      }
      if (
        o.evidenceType === "misconception_signal" &&
        o.misconceptionStatus !== "addressed"
      ) {
        m.openMisconception = true;
      } else if (o.masteryLevel >= DEMONSTRATED_THRESHOLD) {
        m.demonstrated = true;
      } else {
        m.probed = true;
      }
    }
    byNode.set(node.key, m);
  }
  return byNode;
}

export function computeFrontier(
  tree: KnowledgeTree,
  obs: ObsLite[],
): FrontierResult {
  const matched = matchObservations(tree, obs);
  const labelOf = (k: string) => tree.nodes.find((n) => n.key === k)?.label ?? k;
  const isDemonstrated = (k: string) => matched.get(k)?.demonstrated ?? false;

  const prereqs = new Map<string, { from: string; kind: string }[]>();
  const dependents = new Map<string, string[]>();
  for (const e of tree.edges) {
    (prereqs.get(e.to) ?? prereqs.set(e.to, []).get(e.to)!).push({
      from: e.from,
      kind: e.kind,
    });
    (dependents.get(e.from) ?? dependents.set(e.from, []).get(e.from)!).push(e.to);
  }

  const status = new Map<string, NodeStatus>();
  const gapReason = new Map<string, string>();

  // base status
  for (const node of tree.nodes) {
    const m = matched.get(node.key)!;
    status.set(node.key, m.demonstrated ? "demonstrated" : m.probed ? "probed" : "locked");
  }

  // frontier: not demonstrated, all prereqs demonstrated (or a probed root)
  for (const node of tree.nodes) {
    if (isDemonstrated(node.key)) continue;
    const ps = prereqs.get(node.key) ?? [];
    const reachable =
      ps.length === 0
        ? matched.get(node.key)?.probed ?? false
        : ps.every((p) => isDemonstrated(p.from));
    if (reachable) status.set(node.key, "frontier");
  }

  // gap pass — ① misconception, ② blocking prerequisite of an active node
  for (const node of tree.nodes) {
    const m = matched.get(node.key)!;
    if (m.openMisconception) {
      status.set(node.key, "gap");
      gapReason.set(
        node.key,
        "Open misconception — the scholar holds a confidently-wrong belief here.",
      );
      continue;
    }
    if (!isDemonstrated(node.key)) {
      const blocks = (dependents.get(node.key) ?? []).find(
        (d) => status.get(d) === "frontier" || status.get(d) === "probed",
      );
      if (blocks) {
        const edge = tree.edges.find((e) => e.from === node.key && e.to === blocks);
        status.set(node.key, "gap");
        gapReason.set(
          node.key,
          edge?.kind === "requires"
            ? `Blocking prerequisite — "${labelOf(blocks)}" needs this first.`
            : `Worth attention — supports "${labelOf(blocks)}", which the scholar is reaching for.`,
        );
      }
    }
  }

  return {
    domain: tree.domain,
    nodes: tree.nodes.map((n) => ({
      key: n.key,
      label: n.label,
      standard: n.standard,
      status: status.get(n.key)!,
      gapReason: gapReason.get(n.key),
      evidence: matched.get(n.key)?.evidence,
      fluency: matched.get(n.key)?.fluency,
    })),
    edges: tree.edges,
  };
}
