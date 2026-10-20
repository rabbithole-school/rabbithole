// Agent-facing helpers for the public local runner (`pnpm local:setup`).
//
// `startTopicChat` lets the agent setting Rabbithole up on someone's computer
// land them straight in a tutor chat on the topic they named ("a kid I know is
// into aquaponics"), instead of walking them through Quests → + Custom Quest →
// topic → Continue → Endless chat → Start exploring:
//
//   CONVEX_AGENT_MODE=anonymous npx convex run localRunner:startTopicChat \
//     '{"username":"leilani_park","topic":"aquaponics"}'
//   → { sessionId, path: "/scholar/<sessionId>" }
//
// It is an INTERNAL mutation: only an admin of the backend (the Convex CLI, run
// from the checkout) can call it, never a browser. And it refuses on every
// deployment but the local runner, so it cannot mint sessions on a hosted one.
//
// It makes the session the web dialog makes, through the same code: the
// dialog's three calls (units.createQuest → sessions.create →
// units.scheduleCustomQuestBake with no bakePath, the "Endless chat" choice),
// run as the scholar. It does not start the tutor turn: the chat page's
// opening turn runs when the page mounts, as it does after the dialog.
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { isLocalRunnerDeployment } from "./lib/deploymentSafety";
import { createQuestHandler, scheduleCustomQuestBakeAs } from "./units";
import { createSessionAs } from "./sessions";

const MAX_TOPIC_CHARS = 200;

export const startTopicChat = internalMutation({
  args: { username: v.string(), topic: v.string() },
  handler: async (ctx, args) => {
    if (!isLocalRunnerDeployment()) {
      throw new Error(
        "localRunner:startTopicChat only runs on the local runner (pnpm local:setup).",
      );
    }
    const topic = args.topic.replace(/\s+/g, " ").trim();
    if (!topic) throw new Error("Name a topic, for example \"aquaponics\".");
    if (topic.length > MAX_TOPIC_CHARS) {
      throw new Error(`Keep the topic under ${MAX_TOPIC_CHARS} characters.`);
    }
    const username = args.username.trim();
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (!scholar || scholar.role !== "scholar") {
      throw new Error(`No scholar with the username "${username}" on this runner.`);
    }

    const asScholar = { ...ctx, user: scholar };
    const { unitId } = await createQuestHandler(asScholar, { title: topic });
    const session = await createSessionAs(asScholar, { unitId });
    await scheduleCustomQuestBakeAs(asScholar, { unitId, sessionId: session.id });
    return { sessionId: session.id, path: `/scholar/${session.id}` };
  },
});
