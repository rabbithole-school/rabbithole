// Resolves a `?skill=` deep link into a single-skill practice scope.
//
// This lives outside `app/scholar/practice/page.tsx` because Next.js only
// permits its own reserved exports (`default`, `metadata`, `generateMetadata`,
// …) from a page module — any other named export fails the production build
// with "is not a valid Page export field". The page imports it from here.

export type SkillNodeLookup =
  | {
      node: {
        nodeKey: string;
        domain: string;
        practiceServeable: boolean;
      };
    }
  | null
  | undefined;

export type TargetedPractice =
  | { domain: string; skillKeys: [string] }
  | { error: string }
  | null
  | undefined;

export function resolveTargetedPractice(
  skillKey: string | null,
  lookup: SkillNodeLookup,
): TargetedPractice {
  if (!skillKey) return null;
  if (lookup === undefined) return undefined;
  if (lookup === null) {
    return { error: "We couldn’t find that skill. Return to your map and choose another node." };
  }
  // The engine's own serveability verdict (template OR stored non-stretch
  // item), computed server-side — never the legacy knowledgeNodes.verifierKind
  // field, which the practice-graph seeder doesn't write.
  if (!lookup.node.practiceServeable) {
    return { error: "That node doesn’t have practice available yet." };
  }
  return {
    domain: lookup.node.domain,
    skillKeys: [lookup.node.nodeKey],
  };
}
