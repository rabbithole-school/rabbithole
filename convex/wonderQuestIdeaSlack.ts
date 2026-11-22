// The "Offer an app: …" buttons under a day's wonder (TRA-697): what a tap
// does. /slack/interactivity has already verified Slack's signature and
// resolved the tapping Slack user to their Rabbithole user
// (slackInteractivity.handleInteraction); this checks the tap is on the idea's
// own post and the idea is still its school's, then offers the Quest as that
// teacher through questProposals.offerQuestForUser (which decides who may
// offer; nothing here repeats it). The idea's id is the offer's `ideaKey`, so
// a second tap, or Slack's retry, is the same offer. The post is never written
// here: `wonderQuestIdeas.markOffered` asks for it to be rebuilt from stored
// state (dayWonders.syncWonderPost), so concurrent taps converge. Anything
// refused is said privately to the teacher who tapped, and nothing changes.

import { ConvexError } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { respondEphemeral } from "./lib/slackApi";
import { QUEST_IDEA_PREFIX } from "./lib/wonderQuestIdeas";
import {
  messageLocation,
  type SlackBlockAction,
  type SlackBlockActionsPayload,
} from "./lib/slackInteractivity";

const LOG = "[WonderQuestIdeas]";
const REFUSED_FORBIDDEN =
  "You can't offer this scholar a Quest, so nothing changed. Ask a teacher who works with them.";
const REFUSED_UNKNOWN = "That didn't go through, so nothing changed. Try again in a moment.";
const REFUSED_GONE = "I can't find that idea, so nothing changed.";
const ALREADY = "That idea was already offered, so nothing changed.";

export async function handleQuestIdeaButton(
  ctx: ActionCtx,
  p: SlackBlockActionsPayload,
  action: SlackBlockAction,
  clicker: { userId: Id<"users"> },
): Promise<void> {
  if (!action.action_id.startsWith(`${QUEST_IDEA_PREFIX}:offer:`)) return;
  const say = (text: string) => respondEphemeral(p.response_url, text);
  const loc = messageLocation(p);
  if (!loc || !action.value) return;
  // Slack retries a tap it didn't hear back about: one answer per tap.
  const { fresh } = await ctx.runMutation(internal.slackBot.claimEvent, {
    eventId: `${QUEST_IDEA_PREFIX}:${p.trigger_id ?? action.action_ts ?? ""}:${action.action_id}`,
  });
  if (!fresh) return;
  const idea = await ctx.runQuery(internal.wonderQuestIdeas.ideaOnPost, {
    channelId: loc.channel,
    ts: loc.ts,
    ideaId: action.value,
  });
  if (!idea) {
    await say(REFUSED_GONE);
    return;
  }
  try {
    const outcome = await ctx.runMutation(internal.questProposals.offerQuestForUser, {
      scholarId: idea.scholarId,
      kind: idea.kind,
      mission: idea.mission,
      title: idea.title,
      ideaKey: `wonder-idea:${idea.ideaId}`,
      offererId: clicker.userId,
      expectedInstitutionId: idea.institutionId,
    });
    await ctx.runMutation(internal.wonderQuestIdeas.markOffered, {
      ideaId: idea.ideaId,
      unitId: outcome.unitId,
    });
    if (!outcome.created) await say(ALREADY);
  } catch (error: unknown) {
    if (error instanceof ConvexError && typeof error.data === "string") {
      await say(error.data);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Forbidden")) await say(REFUSED_FORBIDDEN);
    else {
      console.error(`${LOG} ${idea.ideaId}: offer failed:`, message);
      await say(REFUSED_UNKNOWN);
    }
  }
}
