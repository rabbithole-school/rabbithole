import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isDurableEdge } from "../../shared/edgeOntology";

/**
 * Delete a pipeline-owned edge while enforcing the corpus/cache boundary.
 *
 * Fixture-authoritative dependency rebuilds deliberately do not use this
 * helper because they own topology and carry story payloads across reinserts.
 */
export async function deleteCacheOwnedEdge(
  ctx: MutationCtx,
  edge: Doc<"knowledgeNodeEdges">,
): Promise<boolean> {
  if (isDurableEdge(edge)) return false;
  await ctx.db.delete(edge._id);
  return true;
}
