"use node";

import { v } from "convex/values";
import type Anthropic from "@anthropic-ai/sdk";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { PARENT_REPORT_EFFORT, PARENT_REPORT_MODEL } from "./lib/models";
import {
  buildParentReportSystemPrompt,
  buildParentReportUserPrompt,
  buildRevisionRequest,
  buildEnrichmentListRequest,
  buildEnrichmentListSystemPrompt,
  checkDraft,
  cleanDraft,
  parseEnrichmentList,
  splitDraftPieces,
  type UnitReading,
} from "./lib/parentReport";
import {
  buildUnitExtract,
  buildUnitReadingRequest,
  buildUnitReadingSystemPrompt,
  parseUnitReadingNotes,
} from "./lib/parentReportReading";
import { TUTOR_REFUSAL_FALLBACK_BETA, tutorRefusalFallback } from "./lib/tutorModel";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";

// The model thinks before it writes, and its thinking counts against this cap.
// At 1200 an SEL draft spent the budget thinking and saved cut off mid-sentence
// (TRA-728); the report itself stays ~240 words by prompt.
const PARENT_REPORT_MAX_TOKENS = 16000;

// The reading pass returns a few short JSON notes; thinking counts against this.
const UNIT_READING_MAX_TOKENS = 12000;
// Below this many scholar turns a unit can't show a habit or a change.
const MIN_READING_TURNS = 4;

const queueItem = v.object({ narrativeId: v.id("courseNarratives"), requestedAt: v.number() });

/**
 * Draft parent reports from the record (gathered by
 * `parentReports.evidenceForDraft`) and land each in its prose section.
 * Scheduled by `parentReports.requestDraft` / `draftAllForScholar`, which do the
 * access checks. A queue (`next`) is drafted one report per run, in order, so
 * each draft sees the ones before it; failures are written back per report so
 * the composer can say so, and never stop the rest of the queue.
 */
export const draft = internalAction({
  // `requestedAt` identifies this request; a completion for a superseded one is dropped.
  args: { narrativeId: v.id("courseNarratives"), requestedAt: v.number(), next: v.optional(v.array(queueItem)) },
  handler: async (ctx, args) => {
    const [head, ...rest] = await ctx.runMutation(internal.parentReports.claimDraftQueue, {
      items: [{ narrativeId: args.narrativeId, requestedAt: args.requestedAt }, ...(args.next ?? [])],
    });
    try {
      if (head) await draftOne(ctx, head);
    } finally {
      // Re-claim the rest right before handing off, so the time this draft
      // took never counts against the reports still waiting.
      const live = rest.length > 0 ? await ctx.runMutation(internal.parentReports.claimDraftQueue, { items: rest }) : [];
      if (live.length > 0) {
        const [following, ...after] = live;
        await ctx.scheduler.runAfter(0, internal.parentReportActions.draft, { ...following, next: after });
      }
    }
  },
});

async function draftOne(
  ctx: ActionCtx,
  item: { narrativeId: Id<"courseNarratives">; requestedAt: number },
): Promise<void> {
  try {
    const gathered = await ctx.runQuery(internal.parentReports.evidenceForDraft, {
      narrativeId: item.narrativeId,
    });
    if (!gathered) return;
    const { default: AnthropicClient } = await import("@anthropic-ai/sdk");
    const anthropic = new AnthropicClient();
    const fallback = tutorRefusalFallback(PARENT_REPORT_MODEL);
    if (gathered.kind === "enrichment") {
      // The list's lines, rewritten for parents in one call. On a reply that
      // doesn't give one line per item, the plain titles already saved stay.
      // Nothing left to describe (the work changed since the fill): say so,
      // which also ends the drafting state; the saved titles stay.
      if (gathered.items.length === 0)
        throw new Error("There's nothing left on the list to describe, so it keeps what's there.");
      const response = await anthropic.messages.create(
        {
          model: PARENT_REPORT_MODEL,
          max_tokens: PARENT_REPORT_MAX_TOKENS,
          output_config: { effort: PARENT_REPORT_EFFORT },
          system: buildEnrichmentListSystemPrompt(),
          messages: [{ role: "user", content: buildEnrichmentListRequest(gathered.items) }],
          ...(fallback ? ({ fallbacks: "default" } as Record<string, unknown>) : {}),
        },
        fallback ? { headers: { "anthropic-beta": TUTOR_REFUSAL_FALLBACK_BETA } } : undefined,
      );
      await recordAnthropicUsage(ctx, {
        source: "parent-report-draft",
        role: ROLES.TEACHER,
        institutionId: gathered.institutionId,
        model: PARENT_REPORT_MODEL,
        usage: response.usage,
      });
      const raw = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const body = response.stop_reason === "end_turn" ? parseEnrichmentList(raw, gathered.items.length) : null;
      if (!body) throw new Error("The list couldn't be written for parents, so it shows the unit titles. Try drafting again.");
      await ctx.runMutation(internal.parentReports.saveDraft, {
        narrativeId: item.narrativeId,
        requestedAt: item.requestedAt,
        body,
      });
      return;
    }
    // Read the scholar's own turns in each of the class's main units first.
    // Any failure there only means fewer notes; it never fails the draft.
    const readings = await readUnits(ctx, anthropic, fallback, item.narrativeId, gathered.readingUnitIds, gathered.institutionId);
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: buildParentReportUserPrompt(gathered.evidence, gathered.otherReports, readings) },
    ];
    const ask = async (): Promise<string> => {
      const response = await anthropic.messages.create(
        {
          model: PARENT_REPORT_MODEL,
          max_tokens: PARENT_REPORT_MAX_TOKENS,
          output_config: { effort: PARENT_REPORT_EFFORT },
          system: buildParentReportSystemPrompt(),
          messages,
          // Server-side refusal fallback; postdates the pinned SDK's types.
          ...(fallback ? ({ fallbacks: "default" } as Record<string, unknown>) : {}),
        },
        fallback ? { headers: { "anthropic-beta": TUTOR_REFUSAL_FALLBACK_BETA } } : undefined,
      );
      await recordAnthropicUsage(ctx, {
        source: "parent-report-draft",
        role: ROLES.TEACHER,
        institutionId: gathered.institutionId,
        model: PARENT_REPORT_MODEL,
        usage: response.usage,
      });
      // A draft cut off at the cap would save as if it were finished.
      if (response.stop_reason === "max_tokens")
        throw new Error("The draft was cut off before it finished. Try drafting again.");
      if (response.stop_reason === "refusal")
        throw new Error("The model declined to write this draft. Try drafting again, or write it by hand.");
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      if (!text) throw new Error("The model returned an empty draft");
      // Only the text goes back: with the refusal fallback the content can
      // carry blocks from another model that this request can't replay.
      messages.push({ role: "assistant", content: text });
      return text;
    };

    const offered = gathered.evidence.pieces;
    // Split off the Pieces line first, then clean the report itself.
    const parse = (raw: string) => {
      const split = splitDraftPieces(raw, offered);
      return { ...split, text: cleanDraft(split.text) };
    };
    let draft = parse(await ask());
    if (!draft.text) throw new Error("The model returned an empty draft");
    // One revision when the draft breaks a rule a code check can see. Its
    // result is kept even if it still trips the check, and if the revision
    // fails the first draft is kept: the teacher reads every draft before
    // publishing, and a second loop rarely helps.
    const problems = checkDraft(draft.text, gathered.evidence.pronouns);
    if (problems.length > 0) {
      messages.push({ role: "user", content: buildRevisionRequest(problems) });
      try {
        const revised = parse(await ask());
        // An empty revision keeps the first draft; one that drops the Pieces
        // line keeps the first draft's list.
        if (revised.text) draft = revised.found ? revised : { ...revised, pieceIds: draft.pieceIds };
      } catch (e) {
        console.warn(`[parentReports] revision failed, keeping the first draft: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await ctx.runMutation(internal.parentReports.saveDraft, {
      narrativeId: item.narrativeId,
      requestedAt: item.requestedAt,
      body: draft.text,
      pieces: draft.pieceIds as Id<"portfolioItems">[],
    });
  } catch (e) {
    await ctx.runMutation(internal.parentReports.saveDraftError, {
      narrativeId: item.narrativeId,
      requestedAt: item.requestedAt,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * The reading pass for a class report: per unit (in parallel), the scholar's
 * own dated turns across its sessions this term go to the model, which returns
 * notes whose quotes are then verified in code (`parseUnitReadingNotes`). A
 * unit that fails in any way (no input, too few turns, a model error, a
 * refusal, a cut-off reply, unparseable output) contributes no notes.
 */
async function readUnits(
  ctx: ActionCtx,
  anthropic: Anthropic,
  fallback: boolean,
  narrativeId: Id<"courseNarratives">,
  unitIds: Id<"units">[],
  institutionId: Id<"institutions"> | null,
): Promise<UnitReading[]> {
  const results = await Promise.all(
    unitIds.map(async (unitId): Promise<UnitReading | null> => {
      try {
        const input = await ctx.runQuery(internal.parentReports.unitReadingInput, { narrativeId, unitId });
        if (!input) return null;
        const extract = buildUnitExtract(input);
        if (extract.scholarTurns < MIN_READING_TURNS) return null;
        const response = await anthropic.messages.create(
          {
            model: PARENT_REPORT_MODEL,
            max_tokens: UNIT_READING_MAX_TOKENS,
            output_config: { effort: "medium" },
            system: buildUnitReadingSystemPrompt(),
            messages: [{ role: "user", content: buildUnitReadingRequest(input, extract) }],
            ...(fallback ? ({ fallbacks: "default" } as Record<string, unknown>) : {}),
          },
          fallback ? { headers: { "anthropic-beta": TUTOR_REFUSAL_FALLBACK_BETA } } : undefined,
        );
        await recordAnthropicUsage(ctx, {
          source: "parent-report-draft",
          role: ROLES.TEACHER,
          institutionId,
          model: PARENT_REPORT_MODEL,
          usage: response.usage,
        });
        if (response.stop_reason !== "end_turn") return null;
        const raw = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
        const notes = parseUnitReadingNotes(raw, input);
        return notes.length > 0 ? { unitTitle: input.unitTitle, notes } : null;
      } catch (e) {
        console.warn(`[parentReports] unit reading skipped: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }),
  );
  return results.filter((r): r is UnitReading => r !== null);
}
