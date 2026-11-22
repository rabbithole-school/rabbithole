/**
 * One event each time a scholar opens their Sky (TRA-669): the BunnyPad's pull
 * down from the Quests tab and the web's "Your sky" band both call `record`.
 * It answers "do kids open the Sky at all?" (counted per kid per week), which
 * nothing could answer before. Table and why it is its own: schema.ts
 * `skyOpens`.
 */

import { authedMutation } from "./lib/customFunctions";
import { ROLES } from "./lib/roles";

/** The signed-in scholar opened their Sky. Self only: it takes no scholar id.
 *  Anyone else records nothing (a teacher looking at a scholar's Sky is not
 *  the kid opening it), quietly, so a client can call it without a role
 *  check of its own. */
export const record = authedMutation({
  args: {},
  handler: async (ctx) => {
    if (ctx.user.role !== ROLES.SCHOLAR) return { recorded: false };
    await ctx.db.insert("skyOpens", { scholarId: ctx.user._id });
    return { recorded: true };
  },
});
