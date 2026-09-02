import type { MasteryState } from "../../../vendor/shared/treeMapLayout";

export type NeighbourRelation = "prerequisite" | "unlock" | "bridge";

export type NeighbourhoodNode = {
  nodeKey: string;
  label: string;
};

export type NeighbourhoodEdge = {
  fromKey: string;
  toKey: string;
  relation: "dependency" | "bridge";
  method: string | null;
  weight: number | null;
};

export type NodeNeighbourhood = {
  node: {
    nodeKey: string;
    label: string;
    practiceServeable: boolean;
  };
  edges: NeighbourhoodEdge[];
  stories: NodeStory[];
  neighbours: NeighbourhoodNode[];
  neighbourMastery: Record<string, { mastery: MasteryState }>;
} | null;

export type NodeStory = {
  edgeId: string;
  direction: "incoming" | "outgoing";
  fromKey: string;
  fromLabel: string;
  toKey: string;
  toLabel: string;
  story: unknown;
};

export type DerivedNeighbour = NeighbourhoodNode & {
  relation: NeighbourRelation;
  mastery?: MasteryState;
  observed?: boolean;
};

export type DerivedNeighbourhood = {
  prerequisites: DerivedNeighbour[];
  unlocks: DerivedNeighbour[];
  bridges: DerivedNeighbour[];
  stories: NodeStory[];
};

/** Converts the canonical NodeDrawer response into the native sheet's tappable
 * relationship groups. Graph semantics stay server-owned; this only arranges
 * the response for the smaller iPad inspection surface. */
export function deriveNeighbourhood(
  data: NodeNeighbourhood,
): DerivedNeighbourhood | null {
  if (!data) return null;

  const focalKey = data.node.nodeKey;
  const nodeByKey = new Map(data.neighbours.map((node) => [node.nodeKey, node]));
  const byRelationAndKey = new Map<string, DerivedNeighbour>();

  for (const edge of data.edges) {
    const isFromFocal: boolean = edge.fromKey === focalKey;
    const otherKey = isFromFocal ? edge.toKey : edge.fromKey;
    const neighbour = nodeByKey.get(otherKey);
    if (!neighbour) continue;

    let relation: NeighbourRelation;
    if (edge.relation === "bridge") relation = "bridge";
    else relation = isFromFocal ? "unlock" : "prerequisite";

    const key = `${relation}:${otherKey}`;
    const previous = byRelationAndKey.get(key);
    const item: DerivedNeighbour = {
      ...neighbour,
      relation,
      mastery: data.neighbourMastery[otherKey]?.mastery,
      ...(relation === "bridge" && (previous?.observed || edge.method === "observed")
        ? { observed: true }
        : {}),
    };
    byRelationAndKey.set(key, item);
  }

  const values = [...byRelationAndKey.values()];
  return {
    prerequisites: values.filter((item) => item.relation === "prerequisite"),
    unlocks: values.filter((item) => item.relation === "unlock"),
    bridges: values.filter((item) => item.relation === "bridge"),
    stories: data.stories,
  };
}

export function neighbourAccessibilityLabel(neighbour: DerivedNeighbour): string {
  const relation =
    neighbour.relation === "prerequisite"
      ? "Builds on"
      : neighbour.relation === "unlock"
        ? "Leads to"
        : "Connects to";
  return `${relation} ${neighbour.label}`;
}

export function neighbourAccessibilityHint(neighbour: DerivedNeighbour): string {
  return `Opens ${neighbour.label} in this skill map.`;
}

export function nodeAccessibilityLabel(node: { label: string; mastery: MasteryState }): string {
  return `${node.label}. ${node.mastery === "locked" ? "Not unlocked yet" : node.mastery}.`;
}

export function nodeAccessibilityHint(node: { label: string }): string {
  return `Opens details for ${node.label}.`;
}
