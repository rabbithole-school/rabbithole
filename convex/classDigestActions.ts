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
// Class Digest generation — AI action ("use node").
//
// One generator, two scopes (DRY): "activity" synthesizes one assigned
// activity across a cohort; "cohort" rolls up the whole assignment's
// recent work ("today's read"). Each produces the SAME content shape
// (headline / summary / themes / moments / discussionPrompts) so the UI
// renders both with one component.
//
// Moments cite a scholarId from the list we provide; we reconcile every
// cited id against the collation and fill name / project ourselves, so a
// hallucinated id is dropped rather than trusted. Mirrors
// shareBackActions.ts + observer.ts's structured-output pattern.
// ─────────────────────────────────────────────────────────────────────

const SHARED_STRUCTURE = `Produce a glanceable digest a teacher can absorb in seconds, with depth a click away:
- headline: ONE line (<= 100 chars) that captures how it landed across the class. Concrete, not generic. E.g. "11 of 13 finished — strong sensory detail, two drifted off-task."
- summary: 2-4 sentences naming the shape of what the class did and where they diverged.
- themes: 1-3 entries { title, body } — common moves, shared strengths, or shared stumbles. Body is one sentence grounded in what scholars actually did.
- moments: 2-5 entries worth the teacher's attention. Each { kind, scholarId, headline, detail }:
    - kind ∈ "breakthrough" | "misconception" | "offTask" | "insight" | "needsHelp"
    - scholarId: the EXACT scholarId from the roster list below. NEVER invent one.
    - headline: <= 80 chars, names the move (not the child's caliber).
    - detail: one line of context or a short quote.
  Prefer a spread of scholars and kinds over five of the same. Flag who needs a look.
- discussionPrompts: 2-4 open questions grounded in what the class produced, ready to use in a debrief.

Name the idea or the move, never grade the scholar ("led with a sensory hook", not "brilliant writer"). Be concrete and refer to real work.

SCOPE: This digest covers ONLY this assignment. When nothing is finished, say so IN THAT SCOPE (e.g. "No activities in this dispatch are marked finished yet") — never an unqualified, day-wide claim that the scholar has finished nothing, since work under other assignments isn't visible here.`;

const ACTIVITY_LENS = `You are helping a teacher review how ONE activity landed across their whole class, just after running it. Your job is the post-class read: what did the cohort collectively produce, who's flying, who's stuck, what's worth discussing next.`;

const COHORT_LENS = `You are helping a teacher get a "today's read" on their whole class for this assignment — a roll-up across everything the cohort has been working on recently. Surface the cohort's momentum, who needs attention, and what's worth a whole-class conversation. Moments should point at specific scholars.`;

export function buildClassDigestSystemPrompt(
  scope: "activity" | "cohort",
): string {
  const lens = scope === "activity" ? ACTIVITY_LENS : COHORT_LENS;
  return `${lens}\n\n${SCHOLAR_PRONOUN_GUIDANCE}\n\n${SHARED_STRUCTURE}`;
}

const DIGEST_TOOL = {
  name: "record_class_digest" as const,
  description: "Record the structured class digest for the teacher.",
  input_schema: {
    type: "object" as const,
    required: ["headline", "summary", "themes", "moments", "discussionPrompts"],
    properties: {
      headline: { type: "string" as const },
      summary: { type: "string" as const },
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
      moments: {
        type: "array" as const,
        items: {
          type: "object" as const,
          required: ["kind", "scholarId", "headline", "detail"],
          properties: {
            kind: {
              type: "string" as const,
              enum: [
                "breakthrough",
                "misconception",
                "offTask",
                "insight",
                "needsHelp",
              ],
            },
            scholarId: { type: "string" as const },
            headline: { type: "string" as const },
            detail: { type: "string" as const },
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

type MomentKind =
  | "breakthrough"
  | "misconception"
  | "offTask"
  | "insight"
  | "needsHelp";

const VALID_MOMENT_KINDS = new Set<MomentKind>([
  "breakthrough",
  "misconception",
  "offTask",
  "insight",
  "needsHelp",
]);

type DigestToolInput = {
  headline: string;
  summary: string;
  themes: Array<{ title: string; body: string }>;
  moments: Array<{
    kind: MomentKind;
    scholarId: string;
    headline: string;
    detail: string;
  }>;
  discussionPrompts: string[];
};

type DigestRosterEntry = {
  scholarId: Id<"users">;
  name: string;
  sessionId: Id<"sessions"> | null;
};

type ReadyDigestInput = Omit<DigestToolInput, "moments"> & {
  moments: Array<{
    kind: MomentKind;
    scholarId: Id<"users">;
    scholarName: string;
    sessionId?: Id<"sessions">;
    headline: string;
    detail: string;
  }>;
};

const MAX_CONTENT = 1200;
const cap = (s: string) =>
  s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + "… [truncated]" : s;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const isMomentKind = (value: unknown): value is MomentKind =>
  typeof value === "string" && VALID_MOMENT_KINDS.has(value as MomentKind);

export function normalizeClassDigestToolInput(
  parsed: unknown,
  roster: Map<string, DigestRosterEntry>,
): ReadyDigestInput {
  const input = asRecord(parsed) ?? {};
  const moments = asArray(input.moments)
    .map((rawMoment) => {
      const moment = asRecord(rawMoment);
      if (!moment) return null;
      const who = roster.get(String(moment.scholarId ?? ""));
      if (!who) return null;
      // Coerce any out-of-enum kind the model emits — a bad literal
      // would otherwise make setReady's strict validator throw and wedge
      // the row in "pending".
      const kind: MomentKind = isMomentKind(moment.kind)
        ? moment.kind
        : "insight";
      return {
        kind,
        scholarId: who.scholarId,
        scholarName: who.name,
        sessionId: who.sessionId ?? undefined,
        headline: asString(moment.headline).slice(0, 160),
        detail: asString(moment.detail).slice(0, 280),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  return {
    headline: asString(input.headline).slice(0, 200),
    summary: asString(input.summary),
    themes: asArray(input.themes)
      .map(asRecord)
      .filter((theme): theme is Record<string, unknown> => theme !== null)
      .map((theme) => ({
        title: asString(theme.title),
        body: asString(theme.body),
      })),
    moments,
    discussionPrompts: asArray(input.discussionPrompts).filter(
      (prompt): prompt is string => typeof prompt === "string",
    ),
  };
}

export const generate = internalAction({
  args: {
    scope: v.union(v.literal("activity"), v.literal("cohort")),
    assignmentId: v.id("assignments"),
    activityId: v.optional(v.id("activities")),
  },
  handler: async (ctx, args) => {
    // Roster map: scholarId → { name, sessionId } — the authority for
    // reconciling AI-cited moments.
    const roster = new Map<
      string,
      { scholarId: Id<"users">; name: string; sessionId: Id<"sessions"> | null }
    >();
    const lines: string[] = [];

    // Land any failure on the digest row (keyed by assignment + optional
    // activity), so a collation that yields nothing fails the row instead of
    // leaving it spinning.
    const fail = async (error: string) => {
      await ctx.runMutation(internal.classDigests.setError, {
        scope: args.scope,
        assignmentId: args.assignmentId,
        activityId: args.activityId,
        error,
      });
    };

    if (args.scope === "activity") {
      if (!args.activityId) {
        await fail("activityId required for activity-scope digest.");
        return null;
      }
      const data = await ctx.runQuery(internal.classDigests.collateActivity, {
        assignmentId: args.assignmentId,
        activityId: args.activityId,
      });
      if (!data) {
        await fail("Assignment or activity not found.");
        return null;
      }
      lines.push(
        `Activity: "${data.activityTitle}"${data.unitTitle ? ` (unit: ${data.unitTitle})` : ""}`,
      );
      lines.push(`Class size: ${data.rosterSize}`);
      lines.push("");
      lines.push("PER-SCHOLAR:");
      for (const s of data.scholars) {
        roster.set(String(s.scholarId), {
          scholarId: s.scholarId,
          name: s.name,
          sessionId: s.sessionId,
        });
        lines.push("");
        lines.push(`--- scholarId: ${s.scholarId}`);
        lines.push(`Name: ${s.name} ${SCHOLAR_NAME_PRONOUN_HINT}`);
        lines.push(
          `Status: ${s.completed ? "finished" : s.started ? "in progress" : "not started"}`,
        );
        if (s.analysisSummary) lines.push(`Tutor's read: ${s.analysisSummary}`);
        if (typeof s.pulseScore === "number")
          lines.push(`Engagement pulse (0-5): ${s.pulseScore}`);
        if (s.deliverableContent) {
          lines.push(
            `Submitted work${s.deliverableOverall ? ` (rubric: ${s.deliverableOverall})` : ""}:\n${cap(s.deliverableContent)}`,
          );
        } else if (s.started && !s.completed) {
          lines.push("(working, nothing submitted yet)");
        }
      }
    } else {
      // scope === "cohort": roll up the whole assignment's recent work.
      const data = await ctx.runQuery(internal.classDigests.collateCohort, {
        assignmentId: args.assignmentId,
      });
      if (!data) {
        await fail("Assignment not found.");
        return null;
      }
      lines.push(`Assignment unit: "${data.unitTitle}"`);
      lines.push(
        `Class size: ${data.rosterSize} · total activities finished across the cohort: ${data.completionsTotal}`,
      );
      lines.push("");
      lines.push("PER-SCHOLAR (most recent work):");
      for (const s of data.scholars) {
        roster.set(String(s.scholarId), {
          scholarId: s.scholarId,
          name: s.name,
          sessionId: s.sessionId,
        });
        lines.push("");
        lines.push(`--- scholarId: ${s.scholarId}`);
        lines.push(`Name: ${s.name} ${SCHOLAR_NAME_PRONOUN_HINT}`);
        if (s.currentActivityTitle)
          lines.push(`Currently on: ${s.currentActivityTitle}`);
        lines.push(`Activities finished: ${s.completedCount}`);
        if (s.analysisSummary) lines.push(`Tutor's read: ${s.analysisSummary}`);
        if (typeof s.pulseScore === "number")
          lines.push(`Engagement pulse (0-5): ${s.pulseScore}`);
      }
    }

    const institutionId = await ctx.runQuery(
      internal.usage.resolveSharedScholarInstitution,
      {
        userIds: [...roster.values()].map(({ scholarId }) => scholarId),
      },
    );
    const system = buildClassDigestSystemPrompt(args.scope);

    let parsed: unknown;
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 2500,
        system,
        tools: [DIGEST_TOOL],
        tool_choice: { type: "tool", name: "record_class_digest" },
        messages: [{ role: "user", content: lines.join("\n") }],
      });
      const block = response.content.find((b) => b.type === "tool_use");
      if (!block || block.type !== "tool_use") {
        throw new Error("Model returned no structured digest.");
      }
      await recordAnthropicUsage(ctx, {
        source: "class-digest",
        role: ROLES.TEACHER,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId,
      });
      parsed = block.input;
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err));
      return null;
    }

    // Reconcile moments against the roster — drop hallucinated ids, fill
    // name + session from our own data.
    const digest = normalizeClassDigestToolInput(parsed, roster);

    try {
      await ctx.runMutation(internal.classDigests.setReady, {
        scope: args.scope,
        assignmentId: args.assignmentId,
        activityId: args.scope === "activity" ? args.activityId : undefined,
        ...digest,
      });
    } catch (err) {
      // A validator rejection (unexpected shape from the model) must land
      // the row in "error", never leave it stuck "pending".
      await fail(err instanceof Error ? err.message : String(err));
    }
    return null;
  },
});
