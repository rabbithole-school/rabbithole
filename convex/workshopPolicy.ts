/**
 * App designer edit policy — the stream's read of the verdict (TRA-301).
 * The `/session-stream` HTTP action cannot touch the db directly, so it asks
 * this internal query for the effective mode of the turn it is about to run.
 * The derivation itself lives in `lib/workshopPolicy.ts` and is shared with
 * `sessions.sendMessage` / `sessions.getWithMessages`.
 */

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import {
  resolveTurnMode,
  resolveWorkshopPolicy,
  type WorkshopMode,
} from "./lib/workshopPolicy";

/** The one client-caused rejection of a stream turn: the placeholder named by
 *  the request is not this session's live assistant row. `/session-stream`
 *  maps exactly this message to a 400; everything else stays a server error. */
export const PLACEHOLDER_BINDING_ERROR =
  "Turn placeholder does not belong to this stream";

export const resolveTurnModeForStream = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    callerUserId: v.id("users"),
    requestedMode: v.union(v.literal("edit"), v.literal("play")),
    /** The live stream this turn is running under (from the stream body). */
    streamId: v.string(),
    /** The turn's assistant placeholder (from the stream body). */
    assistantMsgId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    // Bind the placeholder to THIS live stream before trusting anything on it —
    // for EVERY session kind, not only vibecode. `assistantMsgId` and `streamId`
    // both come straight from the POST body, and the stream then patches,
    // deletes, and finalizes that row unconditionally (sessionHelpers
    // updateStreamContent / finalizeStream). An authorized caller streaming an
    // ordinary session of their own could otherwise aim `assistantMsgId` at an
    // unrelated row (another session's turn, a historical message) and overwrite
    // or delete it while streaming; a vibecode caller could additionally point
    // at an OLD designer-stamped row to replay its stamp. Require the row to be
    // the assistant placeholder of THIS session AND this stream — the same
    // binding sessions.stampTurnThread / sessions.requestRenderCheck enforce
    // (convex/sessions.ts ~2113-2123, ~2145-2161). Otherwise the turn is a
    // forgery: reject it before the stream writes anything.
    const placeholder = await ctx.db.get(args.assistantMsgId);
    if (
      !placeholder ||
      placeholder.sessionId !== session._id ||
      placeholder.role !== "assistant" ||
      placeholder.streamId !== args.streamId
    ) {
      throw new Error(PLACEHOLDER_BINDING_ERROR);
    }

    // Why the turn was opened, as the server stamped it on the bound
    // placeholder — trusted for that reason, so the request body carries no
    // trigger of its own. For an app update, also how many app asks it answers.
    const trigger = {
      streamTrigger: placeholder.streamTrigger ?? null,
      appUpdateAskCount:
        placeholder.streamTrigger === "appUpdate"
          ? await countAppAsksBefore(ctx, placeholder)
          : 0,
    };

    // Only a vibecode session has a Play: every other session runs its full
    // tool set whatever the body says, and stamps nothing.
    if (session.sessionMode !== "vibecode") {
      return {
        effectiveEditAccess: "allowed" as const,
        mode: "edit" as const,
        thread: null,
        stampNeeded: false,
        ...trigger,
      };
    }
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Caller not found");

    const policy = await resolveWorkshopPolicy(ctx, { session, caller });
    // The mutation that opened this turn (sendMessage / kickoff / retry /
    // rubric check) already derived the verdict and stamped BOTH rows of the
    // turn; that stamp is the turn's mode of record, so the user row and the
    // assistant row never split across threads. An unstamped placeholder (an
    // older client path) falls back to the body's requested mode.
    //
    // Either way the stamp is only a REQUEST — it NEVER widens access. The
    // effective mode is min(stamped/requested, current verdict): under a
    // verdict that is not `allowed`, the turn is Play whatever the stamp says
    // (a stored `thread: "designer"` cannot buy back code tools once the
    // teacher has hidden or locked Edit).
    const stamped = placeholder.thread ?? null;
    const requested: WorkshopMode =
      stamped === null
        ? args.requestedMode
        : stamped === "tutor"
          ? "play"
          : "edit";
    const turn = resolveTurnMode(requested, policy.effectiveEditAccess);
    return {
      effectiveEditAccess: policy.effectiveEditAccess,
      mode: turn.mode,
      thread: turn.thread,
      // Stamp when the placeholder carries no thread yet, or when the verdict
      // clamped it to a DIFFERENT thread than it was stamped with (designer →
      // tutor once Edit is no longer allowed), so the assistant row records the
      // thread the turn actually ran in.
      stampNeeded: stamped !== turn.thread,
      ...trigger,
    };
  },
});

/**
 * The app asks an appUpdate turn answers: the app-modality user rows directly
 * before its placeholder (startAppUpdateTurn inserts them in the same
 * mutation). Tool rows in between are skipped; anything else ends the run, so
 * an older ask whose own turn already replied is never counted again.
 */
async function countAppAsksBefore(
  ctx: Pick<QueryCtx, "db">,
  placeholder: Doc<"messages">,
): Promise<number> {
  let count = 0;
  for await (const message of ctx.db
    .query("messages")
    .withIndex("by_session", (q) =>
      q
        .eq("sessionId", placeholder.sessionId)
        .lt("_creationTime", placeholder._creationTime),
    )
    .order("desc")) {
    if (message.role === "tool") continue;
    if (message.role !== "user" || message.inputModality !== "app") break;
    count++;
  }
  return count;
}
