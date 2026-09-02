"use node";

/**
 * Interpretive constellation generator — the LLM call ("the magic").
 *
 * A DEDICATED, EXPANSIVE generator, separate from the conservative live observer
 * (which is capped at 1-3 tasteful seeds). This one is encouraged to be boldly
 * associative: given a kid's sparks, reach across ALL of human knowledge for
 * surprising, TRUE, cross-disciplinary stars — including `leap` bridges (vampire
 * bats, songlines, nautical flags). Teacher curates as an overlay; default-on.
 * See review/learning-lenses-plan.md ("Generating the magic").
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { cleanSeedLabel } from "./lib/seedLabel";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import {
  capCuratedExplorationSelections,
  curatedExplorationEntryForTopic,
  curatedExplorationPromptSection,
} from "./lib/curatedExplorationCatalog";

const SYSTEM_PROMPT = `You are the Interpretive lens for Rabbithole, an AI school for gifted kids. Your job is to look at what a learner is drawn to and chart a "sky" of explorations — a constellation of fascinating, TRUE places their curiosity could travel next, across the ENTIRE breadth of human knowledge.

This is NOT the cautious in-lesson tutor. Be boldly associative and delightful. The whole record of human thought is your canvas — linguistics, string theory, nautical signal flags, Aboriginal songlines, vampire-bat reciprocity, medieval guilds, game theory, origami math. The history of discovery is the history of unexpected cross-disciplinary leaps; reward that.

RULES:
- Every star must be TRUE (a real idea/field/phenomenon you can stand behind). Never invent facts.
- Every star must connect to something THIS kid has shown interest in — name the bridge in "connectionTo".
- Range across MANY domains. Favor surprise: a kid who loves fairness should meet vampire bats and the "just price", not just more fractions.
- "topic" is the star LABEL: a SHORT standalone, curiosity-forward noun phrase (roughly ≤ 6 words). NEVER include "→", "->", "➜", or any arrow connector in the topic; put the surprising bridge/leap in "connectionTo" and "rationale" instead.
- "reach": 0 = a near next-step in a domain they already work in; 1 = a near neighbor; 2 = a FAR, surprising leap into another discipline. Aim for a MIX, weighted toward 2.
- "suggestionType": "leap" for a transdisciplinary bridge (most stars), "frontier" for a next-step in a known domain, "depth_probe" to go deeper on a current concept.
- "rationale": one or two vivid, specific sentences a curious kid would find irresistible. Concrete, not generic.
- VOICE: "rationale" and "connectionTo" are shown DIRECTLY TO THE STUDENT. Write to them in the SECOND PERSON ("you", "your") — never refer to the student by name or in the third person ("Kai's instinct…", "they keep reaching for…" are WRONG; "the fair trades you keep reaching for" is right).
- A curated catalog may appear in the learner context. It is inspiration, not coverage: select 0-2 entries only when a specific learner signal creates an honest bridge. Never force one, and never generate another star that substantially overlaps a catalog entry you select.
- 9 to 12 stars. Do not repeat the learner's existing exploration topics.`;

const TOOL = {
  name: "chart_sky",
  description: "Return the constellation of exploration stars for this learner.",
  input_schema: {
    type: "object" as const,
    required: ["stars"],
    properties: {
      stars: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["topic", "domain", "rationale", "connectionTo", "suggestionType", "reach"],
          properties: {
            topic: { type: "string" as const, description: "Short standalone star label: clean noun phrase, no arrow connector or bridge tail." },
            domain: { type: "string" as const, description: "Broad discipline, e.g. Biology, History, Physics, Mathematics, Culture, Economics, Linguistics." },
            rationale: { type: "string" as const },
            connectionTo: { type: "string" as const, description: "The spark of theirs this bridges from." },
            suggestionType: { type: "string" as const, enum: ["leap", "frontier", "depth_probe"] },
            reach: { type: "number" as const, enum: [0, 1, 2] },
          },
        },
      },
    },
  },
};

type Star = {
  topic: string;
  domain: string;
  rationale: string;
  connectionTo?: string;
  suggestionType: string;
  reach: number;
};

export const generateConstellation = internalAction({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<number | null> => {
    const interests = await ctx.runQuery(
      internal.interpretiveHelpers.gatherInterests,
      { scholarId: args.scholarId },
    );
    const hasLearnerSignals =
      interests.signals.length > 0 ||
      interests.connections.length > 0 ||
      interests.concepts.length > 0 ||
      interests.statedInterests.length > 0;

    const userMessage = [
      `Learner: ${interests.scholarName}`,
      "",
      "CHARACTER / AFFECT SIGNALS:",
      ...(interests.signals.length
        ? interests.signals.map((s) => `- [${s.type}] ${s.description}`)
        : ["- (none recorded yet)"]),
      "",
      "CROSS-DOMAIN CONNECTIONS THEY'VE MADE:",
      ...(interests.connections.length
        ? interests.connections.map(
            (c) => `- ${c.concepts.join(", ")} (${c.domains.join(" ↔ ")}): ${c.description}`,
          )
        : ["- (none recorded yet)"]),
      "",
      "CONCEPTS THEY'VE ENGAGED:",
      ...(interests.concepts.length
        ? interests.concepts.slice(0, 20).map((c) => `- ${c.label} [${c.domain}]`)
        : ["- (none recorded yet)"]),
      "",
      "WHAT THIS LEARNER IS DRAWN TO (their sparks — build surprising bridges OUT of these; don't merely restate them):",
      ...(interests.statedInterests.length
        ? interests.statedInterests.map((t) => `- ${t}`)
        : ["- (none recorded yet)"]),
      "",
      "ALREADY-SUGGESTED TOPICS (do not repeat):",
      ...(interests.existingTopics.length
        ? interests.existingTopics.map((t) => `- ${t}`)
        : ["- (none)"]),
      "",
      curatedExplorationPromptSection(
        interests.existingTopics,
        hasLearnerSignals,
      ),
      "",
      "Chart this learner's sky now.",
    ].join("\n");

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();
    const model = process.env.INTERPRETIVE_MODEL || MODELS.SONNET;
    const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
      userId: args.scholarId,
      principal: "scholar",
    });

    let stars: Star[] = [];
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "chart_sky" },
        messages: [{ role: "user", content: userMessage }],
      });
      const block = response.content.find((b) => b.type === "tool_use");
      if (block && block.type === "tool_use") {
        const input = block.input as { stars?: Star[] };
        stars = Array.isArray(input.stars) ? input.stars : [];
      }
      await recordAnthropicUsage(ctx, {
        source: "interpretive",
        role: ROLES.SCHOLAR,
        model,
        usage: response.usage,
        institutionId,
      });
    } catch (err) {
      console.error("[Interpretive] generation failed:", err instanceof Error ? err.message : err);
      return null;
    }

    // sanity-bound + normalize reach
    const normalizedStars = stars
      .filter((s) => s.topic && s.rationale)
      .slice(0, 14)
      .map((s) => ({
        ...s,
        topic: cleanSeedLabel(s.topic).slice(0, 120),
      }));
    const clean = capCuratedExplorationSelections(
      normalizedStars,
      2,
      hasLearnerSignals,
    )
      .map((s) => {
        const topic = s.topic;
        const catalogEntry = curatedExplorationEntryForTopic(topic);
        return {
          topic: catalogEntry
            ? cleanSeedLabel(catalogEntry.topic).slice(0, 120)
            : topic,
          domain: catalogEntry?.domain ?? (s.domain || "general"),
          rationale: (catalogEntry?.invitation ?? s.rationale).slice(0, 600),
          connectionTo: s.connectionTo,
          suggestionType: catalogEntry
            ? "leap"
            : ["leap", "frontier", "depth_probe"].includes(s.suggestionType)
              ? s.suggestionType
              : "leap",
          reach: catalogEntry
            ? 2
            : [0, 1, 2].includes(s.reach)
              ? s.reach
              : 2,
        };
      });

    if (clean.length === 0) return null;
    const n = await ctx.runMutation(internal.interpretiveHelpers.recordConstellation, {
      scholarId: args.scholarId,
      stars: clean,
    });
    console.log(`[Interpretive] charted ${n} stars for ${args.scholarId}`);
    return n;
  },
});
