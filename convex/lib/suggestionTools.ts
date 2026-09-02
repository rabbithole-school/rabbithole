// The Workshop's staff-facing aide tools (review/scholar-meta-prep-time-
// plan.html §§5, 6). Three tools — read the idea queue, reply to an idea, and
// post a "What's new" changelog entry (with editorial credit) — composed into
// assembleCurriculumTools (lib/aideTools.ts), so every surface built on it (the
// in-app aide, the Slack bot, the MCP connector) gets them from one gating
// point.
//
// Gating: teacher+ ONLY (`isTeacherRole`) — the Workshop is an independent
// feature, NOT behind INTROSPECTION_ENABLED and NOT behind a flag of its own.
// It ships dark simply because no scholar UI exists until a later run. This
// is scholar-DATA-adjacent (an idea names a child), but the role gate is the
// same audience as every other scholar-write tool, so it's checked inline
// here (mirrors introspectionTools' inline gate), returning [] otherwise so
// callers can spread the result unconditionally.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, type Role } from "./roles";
import {
  INCLUDE_EXTENDED_EDUCATION_PROP,
  applyParticipationDefault,
  extendedEducationOmittedNote,
} from "./scholarParticipationTooling";
import type { AideEmit } from "./aideStream";

/** Human "how long ago" label for a filed idea (§6's digest shows age). */
function ageLabel(createdAt: number): string {
  const ms = Math.max(0, Date.now() - createdAt);
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Build the Workshop staff tools for one aide turn. Returns `[]` for a
 * non-teacher caller, so it can be spread unconditionally (mirrors
 * makeIntrospectionTools / makeScholarWriteTools).
 */
export async function makeSuggestionTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    // Institution-lens scoping for the scholar-facing reads/writes below. Same
    // shape as makeCustomAppTools / makeMasterScheduleTools: an explicit id set
    // scopes to those scholars, and `scholarLensResolved` distinguishes "no
    // lens supplied" from an admin's resolved unrestricted lens.
    allowedScholarIds?: Set<Id<"users">>;
    scholarLensResolved?: boolean;
  },
) {
  if (!isTeacherRole(opts.role)) return [];

  const { callerUserId } = opts;
  // The lens travels to the backing internal fns as an ARRAY (Convex validators
  // can't take a Set) plus the resolved flag, so those fns fail closed on a
  // caller that never resolved a lens. Mirrors the custom-app / master-schedule
  // tool factories.
  const allowedScholarIds = opts.allowedScholarIds
    ? [...opts.allowedScholarIds]
    : undefined;
  const scholarLensResolved = opts.scholarLensResolved;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const listSuggestionsTool = betaTool({
    name: "list_scholar_suggestions",
    description:
      "List ideas scholars filed about Rabbithole itself (\"the Workshop\"). Read-only. Optionally filter by a scholar's username and/or by `filter` — 'needs_reply' (nobody has written back yet), 'answered' (a human already replied), 'archived' (the SCHOLAR archived it; off their plate). With no filter, returns every idea, oldest first (the longest-waiting ones lead). Each result has the idea's title, the kid's own words, whether it has been answered or archived, and how long ago it was filed — plus a `refined` framing when a Workshop conversation reshaped the idea (the kid's own words still lead; refined is the wording they landed on). Results default to enrolled scholars' ideas; naming a scholarUsername always resolves them regardless of enrollment.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarUsername: {
          type: "string" as const,
          description: "Only this scholar's ideas (exact username).",
        },
        filter: {
          type: "string" as const,
          enum: ["needs_reply", "answered", "archived"] as const,
          description:
            "'needs_reply' = nobody has written back yet; 'answered' = a human replied; 'archived' = the scholar archived it themselves.",
        },
        ...INCLUDE_EXTENDED_EDUCATION_PROP,
      },
      required: [] as const,
    },
    run: async (input: {
      scholarUsername?: string;
      filter?: "needs_reply" | "answered" | "archived";
      includeExtendedEducation?: boolean;
    }) => {
      const fetched = await ctx.runQuery(
        internal.scholarSuggestions.listForStaffInternal,
        {
          scholarUsername: input.scholarUsername,
          filter: input.filter,
          allowedScholarIds,
          scholarLensResolved,
        },
      );
      // Enrolled-only default for the enumeration; NAMING a scholar is itself
      // the opt-in (scholarParticipationTooling.ts), so an explicit username
      // keeps resolving Extended Education scholars' ideas.
      const includeExtended =
        input.includeExtendedEducation === true ||
        !!input.scholarUsername?.trim();
      const { rows, extendedEducationOmitted } = applyParticipationDefault(
        fetched,
        includeExtended,
      );
      const note = extendedEducationOmittedNote(
        extendedEducationOmitted,
        (n) => `${n} idea${n === 1 ? "" : "s"} from Extended Education scholars`,
      );
      emit({
        toolComplete: {
          name: "list_scholar_suggestions",
          result: `${rows.length} idea(s)`,
        },
      });
      const ideas = rows.map((r) => ({
        id: r._id,
        scholar: r.scholarName,
        scholarUsername: r.scholarUsername,
        title: r.title,
        words: r.scholarWords,
        // The refined framing a thinking-partner chat landed on, when present —
        // staff see the kid's own words (above) AND this. Omitted when the idea
        // was sent as-is.
        ...(r.refined ? { refined: r.refined } : {}),
        answered: r.answered,
        ...(r.archivedAt ? { archivedByScholar: true } : {}),
        age: ageLabel(r.createdAt),
        ...(r.extendedEducation ? { extendedEducation: true } : {}),
      }));
      return JSON.stringify(note ? { ideas, note } : ideas);
    },
  });

  const respondTool = betaTool({
    name: "respond_to_suggestion",
    description:
      "Reply to a scholar's Workshop idea with a genuine, human comment. This is a REAL message a CHILD will read, delivered BY NAME (\"From Ms. Lehua\") — so write it warm, honest, and jargon-free, in the staff member's own words. NEVER attach a verdict or good/bad label (there is no such field, by design), and NEVER promise that something will ship — you are a COURIER, not a decision-maker (\"I'll pass this along\" / \"this made us think\" is the ceiling; \"we'll build that\" is banned). Confirm the wording with the staff member before sending unless their message already gives you the exact reply. Replying does NOT close or file the idea: only the scholar can put their own idea away, so never tell them (or a staff member) that answering closed it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        suggestionId: {
          type: "string" as const,
          description: "The idea's id (from list_scholar_suggestions).",
        },
        body: {
          type: "string" as const,
          description:
            "The reply, in the staff member's voice — warm, honest, no verdict, no shipping promise.",
        },
      },
      required: ["suggestionId", "body"] as const,
    },
    run: async (input: { suggestionId: string; body: string }) => {
      const result = await ctx.runMutation(internal.scholarSuggestions.respond, {
        suggestionId: input.suggestionId as Id<"scholarSuggestions">,
        authorId: callerUserId,
        body: input.body,
        allowedScholarIds,
        scholarLensResolved,
      });
      emit({
        toolComplete: { name: "respond_to_suggestion", result: "Replied" },
      });
      return JSON.stringify({
        ok: true,
        message: `Done — replied to "${result.title}". ${result.scholarFirstName} will see it the next time they open the Workshop, and it stays on their board until THEY archive it.`,
      });
    },
  });

  const createWhatsNewTool = betaTool({
    name: "create_whats_new_entry",
    description:
      "Write a \"What's new\" changelog entry — a class-visible release note in the Workshop, in KID language. The `kidBody` is read BY CHILDREN: plain, warm, no jargon, 1-3 sentences (say what changed and why it's good for them, not how it was built). Credit is a SEPARATE editorial act: pass `creditedScholarUsernames` (0..n) ONLY for scholars whose idea genuinely led to this — it is independent of any idea's status, and each credited scholar hears it personally at their next Prep Time. If a private proposals-repo PR carries a `Credits:` line, use those usernames; otherwise ask the staff member who (if anyone) to credit — NEVER guess credit. Confirm the body wording with the staff member before writing unless they've given you the exact words. You are still a courier: describe what shipped, don't promise what's next.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string" as const,
          description: "Short feature name (a few words).",
        },
        kidBody: {
          type: "string" as const,
          description:
            "The note children read — plain, warm, jargon-free, 1-3 sentences.",
        },
        creditedScholarUsernames: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Exact usernames of scholars to credit (0..n). Omit or leave empty when no one is credited. Never guess — credit only who the staff member (or a proposals-repo Credits: line) names.",
        },
      },
      required: ["title", "kidBody"] as const,
    },
    run: async (input: {
      title: string;
      kidBody: string;
      creditedScholarUsernames?: string[];
    }) => {
      // createEntry resolves the usernames and throws a friendly error on any
      // it can't find — surface that verbatim to the staff member (never guess).
      try {
        const result = await ctx.runMutation(internal.changelog.createEntry, {
          title: input.title,
          kidBody: input.kidBody,
          creditedScholarUsernames: input.creditedScholarUsernames,
          createdByUserId: callerUserId,
          allowedScholarIds,
          scholarLensResolved,
        });
        emit({
          toolComplete: {
            name: "create_whats_new_entry",
            result:
              result.creditedCount > 0
                ? `Posted (credited ${result.creditedCount})`
                : "Posted",
          },
        });
        const creditTail =
          result.creditedCount > 0
            ? ` ${result.creditedCount} scholar${result.creditedCount === 1 ? "" : "s"} will hear their credit at their next Prep Time.`
            : "";
        return JSON.stringify({
          ok: true,
          message: `Posted "${input.title.trim()}" to What's new.${creditTail}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          toolComplete: {
            name: "create_whats_new_entry",
            result: "Not posted",
          },
        });
        return JSON.stringify({ ok: false, error: message });
      }
    },
  });

  return [listSuggestionsTool, respondTool, createWhatsNewTool];
}

/**
 * System-prompt section for the Workshop staff tools (§6). Appended by
 * callers ONLY when `isTeacherRole(role)` — the same gate makeSuggestionTools
 * checks — so it never describes a capability the caller lacks.
 *
 * Encodes the courier stance (§5 + §9 "honest statuses" + anti-parasocial):
 * the reply reaches a child by name, so it must be warm and honest, carry no
 * verdict, and promise no shipping.
 */
export const SUGGESTION_SYSTEM_PROMPT_SECTION = `
## Responding to Workshop ideas (from scholars, about Rabbithole itself)

Scholars file ideas about Rabbithole in "the Workshop." Use \`list_scholar_suggestions\` to read the queue (filter by scholar, or by \`filter\`: needs_reply / answered / archived) and \`respond_to_suggestion\` to reply. Your reply is a real message a CHILD reads, delivered by the staff member's name ("From Ms. Lehua") — so keep it warm, honest, plain, and short, in that staff member's own voice; confirm the wording before sending unless they've given you the exact words. You are a COURIER, not a decision-maker: relay the human's response, never attach a verdict or good/bad label (there is no such field), and never promise a feature will ship ("I'll pass this along" / "this made us think" is the ceiling; "we'll build that" is not yours to say). Replying does not close or archive anything — an idea stays on the scholar's board until the SCHOLAR archives it, which is deliberate: the five-open limit is a prioritization lesson aimed at them, so they hold the lever. Never say or imply that your reply closed it.

When something actually SHIPS, use \`create_whats_new_entry\` to post a class-visible "What's new" note. The \`kidBody\` is read BY CHILDREN — plain, warm, no jargon, 1-3 sentences about what changed and why it's good for them, never how it was built; confirm the wording with the staff member unless they gave you the exact words. Credit is a SEPARATE editorial act, independent of any idea's status: pass \`creditedScholarUsernames\` (0..n) ONLY for scholars whose idea genuinely led to the feature — each hears it personally at their next Prep Time. If the staff member points you at a private proposals-repo PR with a \`Credits:\` line, use those usernames; otherwise ask who (if anyone) to credit. NEVER guess credit.
`;
