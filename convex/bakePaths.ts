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
import { describeLevelsForPrompt, levelsPromptLine } from "./lib/readingLevels";
import { authedAction } from "./lib/customFunctions";
import { customQuestTopic } from "./lib/customQuestTopic";
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
  /** "build" marks the Build a simulation card (shared/missionCopy.ts). */
  shape?: "build";
}

export interface PathSuggestions {
  paths: SuggestedPath[];
  /** The scholar's own words already describe a specific thing to make, so
   * the Custom Quest dialog skips the menu and starts a build-first quest.
   * Only ever true for a typed topic — a seed is the system's suggestion. */
  specificBuild: boolean;
}

// Used only when the live call errors/times out, so the menu never dead-ends.
// Deliberately still concrete-ish, not the old abstract archetypes. The build
// path is not listed: every picker renders the fixed "Build a simulation"
// card (shared/missionCopy.ts) after whatever list it gets (TRA-519 B4).
const FALLBACK_PATHS: SuggestedPath[] = [
  { emoji: "🔍", title: "Get to the bottom of it", blurb: "Chase the one big 'why' behind it until it really clicks." },
  { emoji: "🔗", title: "Find the surprising links", blurb: "See what this secretly connects to in your own world." },
];

const FALLBACK: PathSuggestions = { paths: FALLBACK_PATHS, specificBuild: false };

// `strict` makes the API enforce this schema. Without it the model packed its
// whole answer into `paths` as a string in 100 of 114 probe calls, dropped
// `specific_build` from 37 (read as false — a third of build requests missed),
// and left 19 menus on the fallback paths. Strict tools reject minItems > 1 and
// maxItems, so the 2-4 bound lives in the description and in proposePaths.
const REPORT_PATHS_TOOL = {
  name: "report_paths" as const,
  description:
    "Return 2-4 distinct, concrete, kid-facing ways into the topic for the scholar to choose from, and whether the scholar already described a specific thing to make.",
  strict: true,
  input_schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["specific_build", "paths"],
    properties: {
      specific_build: {
        type: "boolean" as const,
        description:
          "true when the scholar's words already describe a SPECIFIC thing they want to make — a game, app, simulation, or tool with its own idea (e.g. 'A game called Canine rotation where a noodly dog teaches angles'). false when they named a topic or question to explore (e.g. 'angles', 'why do dogs chase their tails'), even if building something could be one way in.",
      },
      paths: {
        type: "array" as const,
        description: "2-4 ways in.",
        items: {
          type: "object" as const,
          additionalProperties: false,
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
 * Read `report_paths`' input, tolerating the model packing its whole answer
 * into `paths` as a JSON string (seen live with the two-field schema before
 * the tool went strict: the array AND `specific_build` arrived inside the
 * string). Never throws.
 */
export function readReportPaths(input: unknown): {
  paths: SuggestedPath[];
  specificBuild: boolean;
} {
  const parse = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  let obj = (parse(input) ?? {}) as Record<string, unknown>;
  const inner = parse(obj.paths);
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    obj = { ...obj, ...(inner as Record<string, unknown>) };
    obj.paths = parse(obj.paths);
  } else {
    obj = { ...obj, paths: inner };
  }
  return {
    paths: Array.isArray(obj.paths) ? (obj.paths as SuggestedPath[]) : [],
    specificBuild: obj.specific_build === true,
  };
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
): Promise<PathSuggestions> {
  const userMessage = [
    `A gifted elementary scholar just started a quest of their own:`,
    `"${cx.topic}"${cx.domain ? ` (${cx.domain})` : ""}`,
    cx.rationale
      ? `What seems to pull them toward it (private — don't read this back to them): ${cx.rationale}`
      : "",
    levelsPromptLine(cx.readingLevel) ?? "Talk level: (elementary — pick a sensible default)",
    "",
    "Propose 2-4 GENUINELY DIFFERENT, concrete ways they could dive in — each a real, worthwhile gifted activity (not the same idea reworded, and NOT abstract labels like 'go deep' / 'go wide'). Make each one a specific angle or thing-they'd-do that a curious kid would actually want to pick, and that still leads to genuinely understanding the topic. Speak TO the kid (second person), warm and concrete. Use your judgment about what makes a good gifted activity. Call report_paths.",
    "Do not propose a build-an-app/simulation path; that option is always offered separately.",
    "",
    "specific_build: read their words again. If they describe a SPECIFIC thing they want to MAKE — a game, app, simulation, or tool with its own idea, name, or mechanic (\"a game called X where…\", \"an app that…\", \"make a simulator of…\") — set it true: they don't need a menu, they need to start building. If they named a topic or question to explore, set it false, even if building could be one way in.",
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
    if (!block || block.type !== "tool_use") return FALLBACK;
    const input = readReportPaths(block.input);
    const paths = input.paths
      .filter((p) => p && p.title && p.blurb)
      .slice(0, 4)
      .map((p) => ({
        emoji: (p.emoji || "✨").trim(),
        title: p.title.trim(),
        blurb: p.blurb.trim(),
      }));
    return {
      paths: paths.length >= 2 ? paths : FALLBACK_PATHS,
      specificBuild: input.specificBuild,
    };
  } catch (err) {
    console.error("[suggestBakePaths] failed:", err);
    return FALLBACK;
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
  handler: async (ctx, args): Promise<PathSuggestions> => {
    const user = await ctx.runQuery(api.users.currentUser, {});
    if (!user) return FALLBACK;
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
      if (!info || !info.isTopicSeed) return FALLBACK;
      const { paths } = await proposePaths(ctx, {
        topic: info.topic,
        domain: info.domain,
        rationale: info.rationale,
        readingLevel: info.readingLevel,
      }, institutionId);
      return { paths, specificBuild: false };
    }

    if (!args.topic?.trim()) return FALLBACK;
    // Free-text Custom Quest: currentUser both gates auth (null when signed out)
    // and gives us the scholar's reading level to calibrate to. Title +
    // description read together, exactly as the bake will read them, so the
    // menu offers angles on the same idea the quest gets built around.
    const { topic, rationale } = customQuestTopic(args.topic, args.rationale, user);
    return proposePaths(ctx, {
      topic,
      domain: null,
      rationale,
      readingLevel: describeLevelsForPrompt(user),
    }, institutionId);
  },
});
