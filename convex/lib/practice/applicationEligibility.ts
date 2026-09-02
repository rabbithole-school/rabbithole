import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { buildStoredServable, type ServableItem } from "./servable";
import { isFluent } from "./scheduler";

export const APPLICATION_EVIDENCE_TYPE = "application_success";

type DepthObservation = Pick<
  Doc<"masteryObservations">,
  "evidenceType" | "isSuperseded"
>;

export function isOptionalDepthItemEligible(
  item: Pick<
    Doc<"practiceItems">,
    "tier" | "storyToKey" | "answerType" | "rubricCriteria"
  >,
  observations: readonly DepthObservation[],
  stretchEvidenceTypes: ReadonlySet<string>,
): boolean {
  if (item.tier !== "stretch") return false;
  if (
    item.answerType === "dialogue" &&
    (item.rubricCriteria?.length ?? 0) === 0
  ) {
    return false;
  }

  const current = observations.filter(
    (observation) => observation.isSuperseded === false,
  );
  return item.storyToKey !== undefined
    ? !current.some(
        (observation) =>
          observation.evidenceType === APPLICATION_EVIDENCE_TYPE,
      )
    : !current.some((observation) =>
        stretchEvidenceTypes.has(observation.evidenceType),
      );
}

export type EligibleStoryApplication = {
  domain: string;
  hook: string;
  items: ServableItem[];
};

/**
 * Resolve a story-card serve hint back to its canonical edge and eligible
 * verifier-backed items. The caller supplies only graph keys; item identity,
 * fluency, facet evidence, and renderability are all re-checked here.
 */
export async function eligibleStoryApplication(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  fromKey: string,
  toKey: string,
): Promise<EligibleStoryApplication | null> {
  const edge = (
    await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_from", (q) => q.eq("fromKey", fromKey))
      .collect()
  ).find((candidate) => candidate.toKey === toKey && candidate.story !== undefined);
  if (!edge?.story) return null;

  const mastery = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_skill", (q) =>
      q.eq("scholarId", scholarId).eq("skillKey", fromKey),
    )
    .first();
  if (!mastery || !isFluent(mastery)) return null;

  const [node, observations, storedItems] = await Promise.all([
    ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", fromKey))
      .first(),
    ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_node", (q) =>
        q.eq("scholarId", scholarId).eq("nodeKey", fromKey),
      )
      .filter((q) => q.eq(q.field("isSuperseded"), false))
      .collect(),
    ctx.db
      .query("practiceItems")
      .withIndex("by_skill", (q) => q.eq("skillKey", fromKey))
      .filter((q) => q.eq(q.field("tier"), "stretch"))
      .collect(),
  ]);
  if (!node) return null;

  const items = storedItems
    .filter(
      (item) =>
        item.storyToKey === toKey &&
        item.answerType !== "dialogue" &&
        isOptionalDepthItemEligible(item, observations, new Set()),
    )
    .map((item) =>
      buildStoredServable(
        `gen#${item._id}`,
        item,
        { label: node.label, domain: node.domain },
        node.domain,
      ),
    )
    .filter((item): item is ServableItem => item !== null);

  return items.length > 0
    ? { domain: node.domain, hook: edge.story.hook, items }
    : null;
}
