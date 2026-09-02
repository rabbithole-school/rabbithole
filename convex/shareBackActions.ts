"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import type { Id } from "./_generated/dataModel";
import {
  SCHOLAR_NAME_PRONOUN_HINT,
  SCHOLAR_PRONOUN_GUIDANCE,
} from "./lib/scholarPronouns";

// ─────────────────────────────────────────────────────────────────────
// Share Back digest generation — AI action.
//
// Pulls the collated deliverables across a Share Back's source
// activities, calls Claude to produce a facilitation-ready digest
// (summary / themes / highlights / discussion prompts), and writes it.
//
// Highlights: the model only cites a `deliverableId` (from the list we
// give it) plus a `reason` and `excerpt`. We reconcile every cited id
// against the authoritative collation and fill in scholar name /
// project / source title / angle ourselves — so a hallucinated id is
// dropped rather than trusted, and names are always correct.
//
// Mirrors convex/observer.ts's structured-output pattern.
// See review/shareback-offline-activity.md.
// ─────────────────────────────────────────────────────────────────────

// Recipe is the dominant frame — it sets tone, lens, and what to look
// for. Earlier versions of this file made the recipe a paragraph
// _overlay_ on a warm/teacherly base prompt; the AI averaged the two
// and reverted to celebration even when the recipe said "find what
// didn't land." Now each recipe owns the whole instruction block, and
// the SHARED_STRUCTURE_BLOCK is purely mechanical (the JSON shape +
// deliverableId integrity contract, no tone).
const SHARED_STRUCTURE_BLOCK = `Structure — same for every recipe (the recipe above sets the lens):
- summary: 2–4 sentences (~80 words).
- themes: 2–4 entries, each { title, body } where body is 1–2 sentences referencing what students actually did.
- highlights: 3–6 entries citing real deliverableIds from the list below. Each has { deliverableId, reason (one line), excerpt (≤200 chars) }. NEVER invent deliverableIds.
- discussionPrompts: 2–4 open questions grounded in what students produced.

Be concrete and refer to specific student work by name. The digest should be ready to present in 10 minutes.`;

const RECIPE_PROMPTS = {
  reflection: `You are helping a teacher run a REFLECTION share back. Tone is warm, teacherly, celebratory.

Lens: surface what the class collectively produced — common moves, range of approaches, craft worth naming. Summary names the shape of what they made. Themes name patterns. Highlights celebrate variety in approach and craft. Discussion prompts open up the "how did you do that" conversation.`,
  galleryWalk: `You are helping a teacher run a GALLERY WALK. Tone is light, curatorial.

Lens: every student deserves a moment on the board — privilege coverage over deep synthesis. Summary is short (one or two sentences). Themes are 2–3, kept short — the teacher's going to let students walk and read for themselves. Highlights should include EVERY scholar where the count fits the 3–6 cap (so for a class of 4, give 4 highlights, one per scholar). Discussion prompts prime good circulation: "Find a piece that surprised you", "Pair up and trade one observation."`,
  exitTicket: `You are helping a teacher run an EXIT TICKET review. Tone is HONEST and DIAGNOSTIC, not warm. Do NOT celebrate.

Lens: surface CONFUSION, GAPS, partial understanding, and misconceptions — that's the entire point. Summary is honest about what didn't land ("Most students could X but stumbled on Y", "Three out of five mixed up Z with W"). Themes name specific misconceptions or partial-understanding patterns (e.g. "Confusion between unlike denominators and unlike numerators", "Conflating correlation with causation"). Highlights pull representative CONFUSIONS — quote the wrong-or-incomplete bit and name the misconception, so the teacher sees who needs re-teaching on what. Discussion prompts are diagnostic ("Who can explain why X actually happens?", "What's the difference between Y and Z?").

If every submission is genuinely solid with no gaps to surface, say so plainly in the summary instead of inventing celebration. But default-assume there ARE gaps — students rarely all-nail an exit ticket.`,
  debateDebrief: `You are helping a teacher run a DEBATE DEBRIEF. Tone is analytical and balanced.

Lens: identify the POSITIONS students took and how they CONTRAST. Summary maps the rough distribution of stances. Themes group arguments: "Pro-X students leaned on evidence about A", "Counterarguments hinged on B". Highlights surface the strongest articulation of EACH major position plus any unusual / hybrid stances — give each side a voice. Discussion prompts push synthesis: "Where do these positions actually agree?", "What evidence would change your mind?".`,
  custom: `The teacher's FACILITATION FOCUS below is your primary frame. Read it carefully and shape the digest entirely around it — tone, what to surface, what to skip. Use the structure scaffold but let the focus dictate emphasis.`,
} as const;

export function buildShareBackSystemPrompt(
  recipe: keyof typeof RECIPE_PROMPTS,
  facilitationFocus: string | null,
): string {
  const recipeBlock = RECIPE_PROMPTS[recipe] ?? RECIPE_PROMPTS.reflection;
  // Focus only feeds in for the Custom recipe — named recipes ARE the
  // focus. (See activities.update: switching to a named recipe clears
  // facilitationFocus server-side; this check is defense in depth.)
  const focusBlock =
    recipe === "custom" && facilitationFocus
      ? `\n\nTEACHER'S FACILITATION FOCUS:\n${facilitationFocus}\n`
      : "";
  return `${recipeBlock}${focusBlock}\n\n${SCHOLAR_PRONOUN_GUIDANCE}\n\n${SHARED_STRUCTURE_BLOCK}`;
}

const SHAREBACK_TOOL = {
  name: "record_shareback_digest" as const,
  description:
    "Record the structured Share Back digest for the teacher to facilitate.",
  input_schema: {
    type: "object" as const,
    required: ["summary", "themes", "highlights", "discussionPrompts"],
    properties: {
      summary: { type: "string" as const, description: "2-4 sentence synthesis" },
      themes: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["title", "body"],
          properties: {
            title: { type: "string" as const },
            body: { type: "string" as const },
          },
        },
      },
      highlights: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["deliverableId", "reason", "excerpt"],
          properties: {
            deliverableId: {
              type: "string" as const,
              description: "The exact deliverableId from the provided list.",
            },
            reason: {
              type: "string" as const,
              description: "Why this one — what the class can learn from it.",
            },
            excerpt: {
              type: "string" as const,
              description: "Short pull-quote or paraphrase (<=200 chars).",
            },
          },
        },
      },
      discussionPrompts: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
  },
};

type DigestToolInput = {
  summary: string;
  themes: Array<{ title: string; body: string }>;
  highlights: Array<{ deliverableId: string; reason: string; excerpt: string }>;
  discussionPrompts: string[];
};

export const generateDigest = internalAction({
  args: {
    shareBackActivityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
  },
  handler: async (ctx, args) => {
    const collated = await ctx.runQuery(internal.shareBack.collateSources, {
      shareBackActivityId: args.shareBackActivityId,
      assignmentId: args.assignmentId,
    });
    if (!collated) {
      await ctx.runMutation(internal.shareBack.setDigestError, {
        activityId: args.shareBackActivityId,
        assignmentId: args.assignmentId,
        error: "No Share Back sources are configured.",
      });
      return null;
    }
    if (collated.deliverables.length === 0) {
      await ctx.runMutation(internal.shareBack.setDigestError, {
        activityId: args.shareBackActivityId,
        assignmentId: args.assignmentId,
        error:
          "No scholars have submitted work to the source activities yet.",
      });
      return null;
    }

    // Build the prompt. Cap per-deliverable content so a few long
    // artifacts don't blow the token budget; the AI gets enough to
    // judge + quote.
    const MAX_CONTENT = 1500;
    const lines: string[] = [];
    lines.push(`Share Back: "${collated.shareBackTitle}"`);
    lines.push(
      `Source activities: ${collated.perSource
        .map((s) => `"${s.title}" (${s.deliverableCount} submitted)`)
        .join(", ")}`,
    );
    lines.push("");
    lines.push("STUDENT SUBMISSIONS:");
    for (const d of collated.deliverables) {
      lines.push("");
      lines.push(`--- deliverableId: ${d.deliverableId}`);
      lines.push(`Student: ${d.scholarName} ${SCHOLAR_NAME_PRONOUN_HINT}`);
      lines.push(`From activity: ${d.sourceActivityTitle}`);
      if (d.angleTitle) {
        lines.push(
          `Their angle: ${d.angleTitle}${d.angleDescription ? ` — ${d.angleDescription}` : ""}`,
        );
      }
      if (d.overall) lines.push(`Rubric: ${d.overall}`);
      if (d.contentKind === "file") {
        lines.push(
          `[Submitted a ${"file"} — photo/audio/slides. No text to quote; judge by metadata only or skip as a highlight.]`,
        );
      } else if (d.content) {
        const body =
          d.content.length > MAX_CONTENT
            ? d.content.slice(0, MAX_CONTENT) + "… [truncated]"
            : d.content;
        lines.push(
          d.contentKind === "portfolio"
            ? `Scanned work (AI caption + transcription):\n${body}`
            : `Work:\n${body}`,
        );
      } else if (d.contentKind === "portfolio") {
        lines.push(
          "[Scanned work — no caption/transcription captured. Judge by metadata only or skip as a highlight.]",
        );
      } else {
        lines.push("[No content captured.]");
      }
    }
    const userMessage = lines.join("\n");
    const institutionId = await ctx.runQuery(
      internal.usage.resolveSharedScholarInstitution,
      {
        userIds: collated.deliverables.map((deliverable) => deliverable.scholarId),
      },
    );

    let parsed: DigestToolInput;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 3000,
        system: buildShareBackSystemPrompt(
          (collated.shareBackRecipe ?? "reflection") as keyof typeof RECIPE_PROMPTS,
          collated.facilitationFocus,
        ),
        tools: [SHAREBACK_TOOL],
        tool_choice: { type: "tool", name: "record_shareback_digest" },
        messages: [{ role: "user", content: userMessage }],
      });
      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        throw new Error("Model returned no structured digest.");
      }
      await recordAnthropicUsage(ctx, {
        source: "share-back",
        role: ROLES.TEACHER,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId,
      });
      parsed = toolBlock.input as DigestToolInput;
    } catch (err) {
      await ctx.runMutation(internal.shareBack.setDigestError, {
        activityId: args.shareBackActivityId,
        assignmentId: args.assignmentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Reconcile highlights against the authoritative collation. Drop
    // any cited id that isn't real; fill name / project / source /
    // angle from our own data (never trust the model for those).
    const byId = new Map(
      collated.deliverables.map((d) => [String(d.deliverableId), d]),
    );
    const highlights = (parsed.highlights ?? [])
      .map((h) => {
        const d = byId.get(String(h.deliverableId));
        if (!d) return null;
        return {
          deliverableId: d.deliverableId as Id<"deliverables">,
          scholarId: d.scholarId as Id<"users">,
          scholarName: d.scholarName,
          sourceActivityTitle: d.sourceActivityTitle,
          angleTitle: d.angleTitle ?? undefined,
          reason: h.reason ?? "",
          excerpt: (h.excerpt ?? "").slice(0, 280),
          sessionId: d.sessionId as Id<"sessions">,
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);

    await ctx.runMutation(internal.shareBack.setDigestReady, {
      activityId: args.shareBackActivityId,
      assignmentId: args.assignmentId,
      summary: parsed.summary ?? "",
      themes: (parsed.themes ?? []).map((t) => ({
        title: t.title ?? "",
        body: t.body ?? "",
      })),
      highlights,
      discussionPrompts: parsed.discussionPrompts ?? [],
    });
    return null;
  },
});
