"use node";

// The meta-observer — the Workshop chats' slim incremental analysis pass,
// scheduled after EVERY exchange (convex/metaChat.ts → finalizeStream). This is
// the launch gate (§8/§10): the main observer's welfare-alert code sits AFTER
// its test-drive early-return, so a meta chat can't reuse it — a scholar-facing
// chat without welfare coverage is unshippable, so the meta chat gets its own.
//
// Two jobs, safety first: (1) the SAME welfare/ongoing-harm classification as
// the main observer, routed to the SAME internal.alerts.raise fabric (source
// "meta_chat"); (2) consented-idea distillation into scholarSuggestions; and
// (3) HIGH-BAR portrait evidence — clear self-reported metacognition/mastery
// written as reflection-typed masteryObservations rows (the observer's third
// job, §8). All governed memory: observer-authored, schema'd, teacher-visible.
// It writes NOTHING to the record from raw transcript — only the structured
// output — and no seeds/signals from a wrap-up chat. The DB reads/writes go
// through V8 functions in convex/metaChat.ts (this file is "use node").

import type Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./lib/institutionPromptProfile";
import { SCHOLAR_PRONOUN_GUIDANCE } from "./lib/scholarPronouns";
import { recordAnthropicUsage } from "./usage";

// Slim derivative of OBSERVER_SYSTEM_PROMPT's safety section — SAME bar
// (ongoing-harm disclosures only; a mid-thread "I'm fine" doesn't clear an
// earlier disclosure; ordinary frustration NEVER fires) — plus the
// suggestion-extraction rules (consent + verbatim scholar words) and the
// HIGH-BAR portrait-evidence rules (self-reported metacognition only).
const buildMetaObserverSystemPrompt = (
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string => {
  const location = profile.observerLocation
    ? ` in ${profile.observerLocation}`
    : "";
  return `You analyze one newly completed range of a Rabbithole Workshop conversation with a gifted elementary student${location}. You do NOT talk to the student. Produce ONE structured result with three parts: a rare safety alert, any consented product ideas, and any high-bar portrait evidence.

${SCHOLAR_PRONOUN_GUIDANCE}

## 1. Safety alert (welfare / ongoing harm) — RARE
Emit the OPTIONAL \`safetyAlert\` object ONLY when a STUDENT message in the NEW RANGE shows a disclosure of possible ONGOING HARM — to the student or someone else: abuse, violence at home, being hurt or unsafe, neglect, or self-harm / suicidal intent. PRIOR CONTEXT can clarify the new disclosure but can NEVER trigger an alert itself. This is NOT for ordinary sadness, frustration, a hard day, or academic struggle — those NEVER fire an alert. When you DO emit it:
- severity: "critical" for active/immediate danger (stated self-harm intent, abuse happening now); "warning" for a concerning disclosure that needs prompt human follow-up.
- category: self_harm | abuse | violence | neglect | other.
- summary: one neutral, actionable sentence — no diagnosis, no speculation beyond the transcript.
- excerpt: a short verbatim quote of the student's own words (one or two lines).
- sourceMessageId: the raw id inside brackets for the NEW student message containing the disclosure (omit the brackets themselves).
A later "I'm fine" in the same NEW RANGE does NOT cancel a real disclosure earlier in that range. When genuinely uncertain whether something rises to real harm, err toward "warning"; a human reviews every one.

## 2. Product ideas (the Workshop's listening job)
Return \`suggestions\`: an array of ideas the student voiced about how Rabbithole itself could work better. An idea exists ONLY where the transcript shows BOTH: the assistant offered to pass it along AND the student clearly agreed (a plain yes). Set \`consented: true\` only then. A musing with no consent, or the assistant's own idea, is NOT a suggestion — omit it (return an empty array if there are none).
For each consented idea:
- title: a short, neutral label (a few words).
- scholarWords: the STUDENT's own phrasing, VERBATIM from the transcript — do not paraphrase.
- distilled: one neutral sentence a builder can act on.
- consented: true.
Do not invent ideas to fill the array. Most reflections produce none.

## 3. Portrait evidence (self-reported metacognition / mastery) — RARE, HIGH BAR
Return \`portraitEvidence\`: an array of clear, SELF-REPORTED statements about the student's own learning worth adding to their learning portrait. The bar is HIGHER than in a working session (a wrap-up chat is a weak sensor): emit ONLY a specific, self-aware statement about what they now understand, how they learn best, or a mastery/metacognition claim — and ONLY when it is grounded in a VERBATIM quote from the transcript. At most 1-2 per chat; usually ZERO. Ordinary venting, frustration, "today was hard/fun", boredom, or a bare topic mention NEVER qualifies. For each:
- conceptLabel: a short label for what the statement is about (e.g. "dividing fractions", "learning by drawing it out").
- masteryLevel: 0.0-5.0 Bloom's float — your conservative read of the level this SELF-REPORT evidences (self-report is softer than a demonstration).
- note: one neutral sentence a teacher can read, explicitly flagged as self-reported (e.g. "Self-reported: says it clicked once they drew it themself — a representation preference").
- quote: the student's own words, VERBATIM from the transcript.
Do not invent evidence to fill the array. When in doubt, omit — the teacher governs the portrait, and a noisy wrap-up chat must not spam it.`;
};

// The single forced-output tool. Shape matches applyMetaAnalysis's args.
const META_OBSERVER_TOOL: Anthropic.Tool = {
  name: "record_meta_analysis",
  description:
    "Record the reflection-chat analysis: an optional welfare safety alert, any consented product ideas, and any high-bar self-reported portrait evidence.",
  input_schema: {
    type: "object",
    properties: {
      safetyAlert: {
        type: "object",
        description:
          "OMIT unless the transcript discloses possible ongoing harm.",
        properties: {
          severity: { type: "string", enum: ["critical", "warning"] },
          category: {
            type: "string",
            enum: ["self_harm", "abuse", "violence", "neglect", "other"],
          },
          summary: { type: "string" },
          excerpt: { type: "string" },
          sourceMessageId: {
            type: "string",
            description:
              "Raw id inside brackets for the NEW student message that triggered this alert; omit the brackets.",
          },
        },
        required: ["severity", "summary", "sourceMessageId"],
      },
      suggestions: {
        type: "array",
        description: "Consented product ideas; empty when there are none.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            scholarWords: { type: "string" },
            distilled: { type: "string" },
            consented: { type: "boolean" },
          },
          required: ["title", "scholarWords", "distilled", "consented"],
        },
      },
      portraitEvidence: {
        type: "array",
        description:
          "High-bar self-reported metacognition/mastery; empty when there is none (the common case). At most 1-2.",
        items: {
          type: "object",
          properties: {
            conceptLabel: { type: "string" },
            masteryLevel: { type: "number" },
            note: { type: "string" },
            quote: { type: "string" },
          },
          required: ["conceptLabel", "masteryLevel", "note", "quote"],
        },
      },
    },
    required: ["suggestions"],
  },
};

type MetaSafetyAlert = {
  severity: "critical" | "warning";
  category?: string;
  summary: string;
  excerpt?: string;
  sourceMessageId: string;
};
type MetaSuggestion = {
  title: string;
  scholarWords: string;
  distilled: string;
  consented: boolean;
};
type MetaPortraitEvidence = {
  conceptLabel: string;
  masteryLevel: number;
  note: string;
  quote: string;
};

/** Pull the forced tool_use input out of the response, defensively. */
function parseMetaAnalysis(content: Anthropic.ContentBlock[]): {
  safetyAlert?: MetaSafetyAlert;
  suggestions: MetaSuggestion[];
  portraitEvidence: MetaPortraitEvidence[];
} | null {
  const tool = content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === "record_meta_analysis",
  );
  if (!tool) return null;
  const input = tool.input as {
    safetyAlert?: MetaSafetyAlert;
    suggestions?: MetaSuggestion[];
    portraitEvidence?: MetaPortraitEvidence[];
  };
  const suggestions = Array.isArray(input.suggestions)
    ? input.suggestions.filter(
        (s) =>
          s &&
          typeof s.title === "string" &&
          typeof s.scholarWords === "string" &&
          typeof s.distilled === "string" &&
          typeof s.consented === "boolean",
      )
    : [];
  const portraitEvidence = Array.isArray(input.portraitEvidence)
    ? input.portraitEvidence.filter(
        (p) =>
          p &&
          typeof p.conceptLabel === "string" &&
          p.conceptLabel.trim() !== "" &&
          typeof p.masteryLevel === "number" &&
          typeof p.note === "string" &&
          typeof p.quote === "string" &&
          p.quote.trim() !== "",
      )
    : [];
  const sa =
    input.safetyAlert &&
    (input.safetyAlert.severity === "critical" ||
      input.safetyAlert.severity === "warning") &&
    typeof input.safetyAlert.summary === "string"
    && typeof input.safetyAlert.sourceMessageId === "string"
      ? input.safetyAlert
      : undefined;
  return { safetyAlert: sa, suggestions, portraitEvidence };
}

function buildTranscript(
  messages: Array<{ id: string; role: string; content: string }>,
): string {
  return messages
    .filter((m) => m.content.trim() !== "")
    .map(
      (m) =>
        `[${m.id}] ${m.role === "user" ? "Student" : "Rabbithole"}: ${m.content}`,
    )
    .join("\n\n");
}

export function normalizeMetaSourceMessageId(sourceMessageId: string): string {
  const trimmed = sourceMessageId.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

/**
 * Analyze the reflection chat: one Anthropic call, then hand the structured
 * result to the V8 write path. The ONLY thing it writes to the learning record
 * is high-bar, self-reported portrait evidence — and only through the
 * structured output, never raw transcript (§8 guardrail).
 */
export const analyzeMetaChat = internalAction({
  args: {
    chatId: v.id("metaChats"),
    attempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ alerted: boolean; captured: number; portraitEvidence: number } | null> => {
    const claim = await ctx.runMutation(
      internal.metaChat.claimMetaObserverRange,
      { chatId: args.chatId },
    );
    if (!claim) {
      return null;
    }
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: claim.scholarId, principal: "scholar" },
    );
    const hasStudentTurn = claim.newMessages.some(
      (m) => m.role === "user" && m.content.trim() !== "",
    );
    if (!hasStudentTurn) {
      return await ctx.runMutation(internal.metaChat.applyMetaAnalysis, {
        chatId: args.chatId,
        leaseId: claim.leaseId,
        rangeKey: claim.rangeKey,
        expectedCursorAt: claim.expectedCursorAt,
        throughAt: claim.throughAt,
        newUserMessageIds: [],
        suggestions: [],
        portraitEvidence: [],
      });
    }

    const priorTranscript = buildTranscript(claim.contextMessages);
    const newTranscript = buildTranscript(claim.newMessages);
    const openList =
      claim.openTitles.length > 0
        ? claim.openTitles.map((t) => `- ${t}`).join("\n")
        : "(none)";
    const purposeInstruction =
      claim.purpose === "reflection"
        ? "This is Today's reflection. Safety, consented product ideas, and high-bar portrait evidence are eligible."
        : "This is Ask Rabbithole. Safety is eligible. Return empty suggestions and portraitEvidence arrays; this standing transparency chat never writes reflection or portrait state.";
    const userMessage = `${purposeInstruction}

PRIOR CONTEXT — context only; NEVER alert or write evidence from this section:
${priorTranscript || "(none)"}

NEW RANGE — analyze and apply only this section:
${newTranscript}

---
The student already has these OPEN ideas on file (don't re-file a duplicate):
${openList}`;
    const newUserMessageIds = claim.newMessages
      .filter((message) => message.role === "user")
      .map((message) => message.id);

    const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
    const anthropic = new AnthropicSDK();
    // Same tier as the main observer.
    const model = MODELS.SONNET;

    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2048,
        system: [
          {
            type: "text",
            text: buildMetaObserverSystemPrompt(claim.institutionProfile),
            // 1h TTL: this per-institution prefix is stable but its cadence is
            // sparse/bursty (scheduled after each reflection/Ask exchange), so
            // the default 5-minute ephemeral cache frequently expires before any
            // reuse. A 1h TTL keeps it warm across a class-reflection block.
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        tools: [META_OBSERVER_TOOL],
        tool_choice: { type: "tool", name: "record_meta_analysis" },
        messages: [{ role: "user", content: userMessage }],
      });
      await recordAnthropicUsage(ctx, {
        source: "meta-observer",
        model,
        usage: response.usage,
        institutionId,
      });
      const parsed = parseMetaAnalysis(response.content);
      if (!parsed) {
        throw new Error("No record_meta_analysis tool_use block in response");
      }
      const safetyAlert = parsed.safetyAlert
        ? {
            ...parsed.safetyAlert,
            sourceMessageId: normalizeMetaSourceMessageId(
              parsed.safetyAlert.sourceMessageId,
            ),
          }
        : undefined;
      if (
        safetyAlert &&
        !newUserMessageIds.includes(safetyAlert.sourceMessageId)
      ) {
        throw new Error("Safety alert referenced a message outside the claimed range");
      }

      const result = await ctx.runMutation(internal.metaChat.applyMetaAnalysis, {
        chatId: args.chatId,
        leaseId: claim.leaseId,
        rangeKey: claim.rangeKey,
        expectedCursorAt: claim.expectedCursorAt,
        throughAt: claim.throughAt,
        newUserMessageIds,
        safetyAlert,
        suggestions:
          claim.purpose === "reflection" ? parsed.suggestions : [],
        portraitEvidence:
          claim.purpose === "reflection" ? parsed.portraitEvidence : [],
      });
      console.log(
        `[MetaObserver] Done — alerted: ${result.alerted}, ideas captured: ${result.captured}, portrait evidence: ${result.portraitEvidence}`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempt = args.attempt ?? 0;
      await ctx.runMutation(internal.metaChat.releaseMetaObserverLease, {
        chatId: args.chatId,
        leaseId: claim.leaseId,
      });
      if (attempt < 3) {
        const delayMs = 1_000 * 2 ** attempt;
        await ctx.scheduler.runAfter(
          delayMs,
          internal.metaObserver.analyzeMetaChat,
          {
            chatId: args.chatId,
            attempt: attempt + 1,
          },
        );
      } else {
        console.error(
          `[MetaObserver] Failed after ${attempt + 1} attempts: ${message}`,
        );
      }
      return null;
    }
  },
});
