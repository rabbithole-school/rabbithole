/**
 * The scholar's ONE ranked queue of open items — rendered by the Quests tab
 * (the whole list) and the Scholar's Prep "Keep going" section (its top rows),
 * on web and native. Core + ranking: `lib/questionQueue.ts`
 * (`questionQueueForScholar`), shared so a teacher-facing read can render the
 * identical set later without re-deriving it.
 *
 * Answering a row: `practiceMoments.recordMomentAnswer` on the row's
 * `eventId`; a row with no `eventId` mints its ledger row first via
 * `practiceMoments.recordMomentOffered({ ...row.moment, surface: "quests" })`.
 * "Why? →" is `sessions.createFromSeed({ seedId })`.
 */

import { authedQuery } from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import { questionQueueForScholar } from "./lib/questionQueue";

/** Self-only: the signed-in scholar's own queue (no subject-id argument, so
 *  there is no cross-scholar or cross-tenant read to gate). Non-scholars get
 *  `[]`. */
export const forSelf = authedQuery({
  args: {},
  handler: async (ctx) => {
    if (ctx.user.role !== ROLES.SCHOLAR) return [];
    return await questionQueueForScholar(ctx, ctx.user._id);
  },
});
