// Live "choose your path" suggester — a one-shot, non-interactive call to the
// SAME Curriculum Bot brain that designs units, asked to propose 2-4 concrete,
// kid-facing ways a scholar could dive into THIS topic (instead of fixed
// deep/wide/build archetypes).
//
// Two entry points, ONE suggester (DRY): a TOPIC SEED the scholar owns
// (star-map / ChoosePathDialog), or a FREE-TEXT Custom Quest the scholar is
// about to create (no seed yet — passed as `topic`/`rationale`).
//
// DRY: it reuses the bot's actual judgment by running its real system prompt
// (`buildUnitDesignerSystemText`) — the single source of "what makes a good
// gifted activity." No build tools are bound (it isn't building anything yet);
// a forced `report_paths` tool returns the options as structured JSON. The
// chosen option is then threaded into the bake as the unit's "way in".

import { v } from "convex/values";
import { authedAction } from "./lib/customFunctions";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import type { ActionCtx } from "./_generated/server";
import { recordAnthropicUsage } from "./usage";
import { buildUnitDesignerSystemText } from "./unitDesignerStream";

export interface SuggestedPath {
  emoji: string;
  title: string;
  blurb: string;
}

// Used only when the live call errors/times out, so the menu never dead-ends.
// Deliberately still concrete-ish, not the old abstract archetypes.
const FALLBACK_PATHS: SuggestedPath[] = [
  { emoji: "🔍", title: "Get to the bottom of it", blurb: "Chase the one big 'why' behind it until it really clicks." },
  { emoji: "🔗", title: "Find the surprising links", blurb: "See what this secretly connects to in your own world." },
  { emoji: "🛠️", title: "Make something that shows it", blurb: "Build a little explainer or diagram that proves you get it." },
];

const REPORT_PATHS_TOOL = {
  name: "report_paths" as const,
  description:
    "Return 2-4 distinct, concrete, kid-facing ways into the topic for the scholar to choose from.",
  input_schema: {
    type: "object" as const,
    required: ["paths"],
    properties: {
      paths: {
        type: "array" as const,
        minItems: 2,
        maxItems: 4,
        items: {
          type: "object" as const,
          required: ["emoji", "title", "blurb"],
          properties: {
            emoji: { type: "string" as const, description: "One emoji that fits this way in." },
            title: {
              type: "string" as const,
              description: "2-5 words, kid-facing, in the scholar's voice (e.g. 'Be a sound detective'). NOT 'go deep/wide'.",
            },
            blurb: {
              type: "string" as const,
              description: "One short sentence, second-person, saying what they'd actually DO on this path.",
            },
          },
        },
      },
    },
  },
};

/** The topic context the path suggester needs, however it was sourced. */
interface PathTopicContext {
  topic: string;
  domain: string | null;
  rationale: string | null;
  readingLevel: string | null;
}

/**
 * Ask the Curriculum Bot for 2-4 concrete ways into a topic. Shared by both
 * entry points (a topic seed OR a free-text Custom Quest) so the two never
 * drift. Never throws — falls back to FALLBACK_PATHS on any failure.
 */
async function proposePaths(
  ctx: ActionCtx,
  cx: PathTopicContext,
  institutionId: Id<"institutions"> | null,
): Promise<SuggestedPath[]> {
  const userMessage = [
    `A gifted elementary scholar just chose, on their own, to explore this topic:`,
    `"${cx.topic}"${cx.domain ? ` (${cx.domain})` : ""}`,
    cx.rationale
      ? `What seems to pull them toward it (private — don't read this back to them): ${cx.rationale}`
      : "",
    `Their reading level: ${cx.readingLevel ?? "(elementary — pick a sensible default)"}`,
    "",
    "Propose 2-4 GENUINELY DIFFERENT, concrete ways they could dive in — each a real, worthwhile gifted activity (not the same idea reworded, and NOT abstract labels like 'go deep' / 'go wide'). Make each one a specific angle or thing-they'd-do that a curious kid would actually want to pick, and that still leads to genuinely understanding the topic. Speak TO the kid (second person), warm and concrete. Use your judgment about what makes a good gifted activity. Call report_paths.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
    const res = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 700,
      // Reuse the bot's real system prompt = its real judgment (DRY). No
      // processes needed for proposing ways-in.
      system: buildUnitDesignerSystemText(""),
      tools: [REPORT_PATHS_TOOL],
      tool_choice: { type: "tool", name: "report_paths" },
      messages: [{ role: "user", content: userMessage }],
    });
    await recordAnthropicUsage(ctx, {
      source: "bake-paths",
      model: MODELS.SONNET,
      usage: res.usage,
      institutionId,
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return FALLBACK_PATHS;
    const raw = (block.input as { paths?: SuggestedPath[] }).paths ?? [];
    const paths = raw
      .filter((p) => p && p.title && p.blurb)
      .slice(0, 4)
      .map((p) => ({
        emoji: (p.emoji || "✨").trim(),
        title: p.title.trim(),
        blurb: p.blurb.trim(),
      }));
    return paths.length >= 2 ? paths : FALLBACK_PATHS;
  } catch (err) {
    console.error("[suggestBakePaths] failed:", err);
    return FALLBACK_PATHS;
  }
}

/**
 * Propose the menu options for a scholar's quest. Public (the menu calls it on
 * open). Two sources, same suggester:
 *   - `seedId` — a topic seed the scholar owns (star-map / ChoosePathDialog).
 *   - `topic` (+ optional `rationale`) — a free-text Custom Quest the scholar is
 *     about to create (no seed exists yet).
 * Exactly one source is expected; a missing/invalid one yields FALLBACK_PATHS.
 */
export const suggestBakePaths = authedAction({
  args: {
    seedId: v.optional(v.id("seeds")),
    topic: v.optional(v.string()),
    rationale: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ paths: SuggestedPath[] }> => {
    const user = await ctx.runQuery(api.users.currentUser, {});
    if (!user) return { paths: FALLBACK_PATHS };
    const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
      userId: user._id,
      principal: "scholar",
    });
    if (args.seedId) {
      // Auth + topic-seed gate in one (getBakeLaunchInfo returns null unless the
      // caller owns this seed; a structured seed never reaches the menu).
      const info = await ctx.runQuery(api.seeds.getBakeLaunchInfo, {
        seedId: args.seedId,
      });
      if (!info || !info.isTopicSeed) return { paths: FALLBACK_PATHS };
      return {
        paths: await proposePaths(ctx, {
          topic: info.topic,
          domain: info.domain,
          rationale: info.rationale,
          readingLevel: info.readingLevel,
        }, institutionId),
      };
    }

    const topic = args.topic?.trim();
    if (!topic) return { paths: FALLBACK_PATHS };
    // Free-text Custom Quest: currentUser both gates auth (null when signed out)
    // and gives us the scholar's reading level to calibrate to.
    return {
      paths: await proposePaths(ctx, {
        topic,
        domain: null,
        rationale: args.rationale?.trim() || null,
        readingLevel: user.readingLevel ?? null,
      }, institutionId),
    };
  },
});
