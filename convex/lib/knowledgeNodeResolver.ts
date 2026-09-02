import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeLabel } from "./nodeDepthHelpers";
import { fuzzyLabelMatch } from "./practice/storyDigest";

type ObservationConcept = {
  conceptLabel: string;
  domain?: string;
};

function uniqueCandidate(
  candidates: readonly Doc<"knowledgeNodes">[],
  domain: string | undefined,
): Doc<"knowledgeNodes"> | undefined {
  const unique = [...new Map(candidates.map((node) => [node.nodeKey, node])).values()];
  if (unique.length === 1) return unique[0];
  if (!domain) return undefined;

  const normalizedDomain = normalizeLabel(domain);
  const inDomain = unique.filter(
    (node) => normalizeLabel(node.domain) === normalizedDomain,
  );
  return inDomain.length === 1 ? inDomain[0] : undefined;
}

/**
 * Resolve free-text observer evidence to one canonical node, preferring
 * precision over recall. A lower-confidence tier is considered only when the
 * stronger tier found no candidates; ambiguity always remains unresolved.
 */
export function matchObservationToKnowledgeNode(
  nodes: readonly Doc<"knowledgeNodes">[],
  observation: ObservationConcept,
): string | undefined {
  const conceptLabel = observation.conceptLabel.trim();
  if (!conceptLabel) return undefined;

  const exactKey = nodes.filter((node) => node.nodeKey === conceptLabel);
  if (exactKey.length > 0) {
    return uniqueCandidate(exactKey, observation.domain)?.nodeKey;
  }

  const normalizedConcept = normalizeLabel(conceptLabel);
  const exactLabel = nodes.filter(
    (node) =>
      normalizeLabel(node.label) === normalizedConcept ||
      node.normalizedLabel === normalizedConcept,
  );
  if (exactLabel.length > 0) {
    return uniqueCandidate(exactLabel, observation.domain)?.nodeKey;
  }

  const loweredConcept = conceptLabel.toLowerCase();
  const keywordMatches = nodes.filter((node) =>
    node.matchKeywords?.some((keyword) => {
      const normalizedKeyword = keyword.trim().toLowerCase();
      return normalizedKeyword.length > 0 && loweredConcept.includes(normalizedKeyword);
    }),
  );
  if (keywordMatches.length > 0) {
    return uniqueCandidate(keywordMatches, observation.domain)?.nodeKey;
  }

  const fuzzyMatches = nodes.filter(
    (node) =>
      fuzzyLabelMatch(conceptLabel, node.label) ||
      node.matchKeywords?.some((keyword) => fuzzyLabelMatch(conceptLabel, keyword)),
  );
  return uniqueCandidate(fuzzyMatches, observation.domain)?.nodeKey;
}

export async function loadKnowledgeNodes(
  ctx: Pick<MutationCtx, "db">,
): Promise<Doc<"knowledgeNodes">[]> {
  const nodes: Doc<"knowledgeNodes">[] = [];
  for await (const node of ctx.db.query("knowledgeNodes")) nodes.push(node);
  return nodes;
}

export async function resolveObservationNodeKey(
  ctx: Pick<MutationCtx, "db">,
  observation: ObservationConcept,
): Promise<string | undefined> {
  return matchObservationToKnowledgeNode(
    await loadKnowledgeNodes(ctx),
    observation,
  );
}

/**
 * Second-chance resolution against an ACTIVITY-DECLARED target shortlist
 * (`activities.probeSkillKeys` / `problemSet.targetSkillKeys`). The global
 * pass punts on ambiguity by design; a 2–3 node shortlist makes the same
 * precision-first tiers decisive where the whole-graph match could not be.
 * This is attribution, not blanket credit: the observation's label still has
 * to MATCH a declared target — a session that wandered off its declared
 * nodes keeps producing node-less observations, exactly as before.
 */
export function matchObservationToDeclaredTargets(
  nodes: readonly Doc<"knowledgeNodes">[],
  targetKeys: readonly string[],
  observation: ObservationConcept,
): string | undefined {
  if (targetKeys.length === 0) return undefined;
  const targetSet = new Set(targetKeys);
  const shortlist = nodes.filter((node) => targetSet.has(node.nodeKey));
  if (shortlist.length === 0) return undefined;

  const conceptLabel = observation.conceptLabel.trim();
  if (!conceptLabel) return undefined;
  const normalizedConcept = normalizeLabel(conceptLabel);

  const exactMatches = shortlist.filter(
    (node) =>
      node.nodeKey === conceptLabel ||
      normalizeLabel(node.label) === normalizedConcept ||
      node.normalizedLabel === normalizedConcept ||
      node.matchKeywords?.some(
        (keyword) => normalizeLabel(keyword) === normalizedConcept,
      ),
  );
  if (exactMatches.length > 0) {
    return uniqueCandidate(exactMatches, observation.domain)?.nodeKey;
  }

  // A declared-target retry is attribution, not search. One generic shared word
  // can make a single node look "closest" inside a tiny shortlist even though
  // the evidence is too weak to distinguish it from a neighboring target.
  // Require phrase containment with >=2 meaningful words, or >=2-word overlap.
  const meaningfulTokens = (value: string) =>
    normalizeLabel(value)
      .split(/\s+/)
      .filter((token) => token.length >= 4);
  const strongMatch = (candidate: string) => {
    const normalizedCandidate = normalizeLabel(candidate);
    const conceptTokens = meaningfulTokens(conceptLabel);
    const candidateTokens = meaningfulTokens(candidate);
    if (
      conceptTokens.length >= 2 &&
      candidateTokens.length >= 2 &&
      (normalizedConcept.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedConcept))
    ) {
      return true;
    }
    const candidateSet = new Set(candidateTokens);
    return conceptTokens.filter((token) => candidateSet.has(token)).length >= 2;
  };
  const strongMatches = shortlist.filter(
    (node) =>
      strongMatch(node.label) ||
      node.matchKeywords?.some((keyword) => strongMatch(keyword)),
  );
  return uniqueCandidate(strongMatches, observation.domain)?.nodeKey;
}
