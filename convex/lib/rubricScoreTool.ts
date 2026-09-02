import { AUTOMATED_COMPLETION_CLOSING_GUIDANCE } from "./tutorClosingGuidance";

// The `update_rubric_score` tool contract — name + judgment guidance,
// extracted so the live tutor session (convex/lib/tutorSessionTools.ts) and
// the evals/rubric-integrity harness bind the byte-identical tool. Same
// discipline as activityCompletionTool.ts for `mark_activity_complete`: the
// eval imports these constants instead of re-typing the guidance, so it
// cannot silently drift from what production actually ships.
//
// The judgment text lives here (not just the schema): it is what stops an
// unanswered tutor probe about a criterion from silently becoming full-credit
// evidence once the artifact merely looks complete (see
// review/experiment-detective-tutor-audit.html, Moment F). The fuller version
// of this same rule lives in the RUBRIC_TOOL_GUIDANCE / buildAdvanceRubricSection
// prompt sections in convex/sessionHelpers.ts — this is the short echo the
// model reads immediately before every call.

export const RUBRIC_SCORE_TOOL_NAME = "update_rubric_score" as const;

export const RUBRIC_SCORE_TOOL_DESCRIPTION =
  `Record where the scholar's work lands on your private rubric map (the scholar cannot see this map or these verdicts). Decide the verdicts, then call this tool FIRST whenever they changed. Mandatory check before marking ANY criterion full: did you ask something specific about that exact criterion earlier, and if so, did they actually work through it in their own words? HARD RULE: an explicitly dodged probe ('I don't know', 'can you just tell me?') stays open through the scholar's next submission. The artifact alone cannot close it, even if it contains a polished matching answer. On that submission turn, the verdict MUST remain half/not and your reply must bring back the SAME unresolved question, not switch to another criterion. It may become full only after a later scholar turn works through that question in their own words. (If you never asked about a criterion, there's nothing to check — judge it normally from what they've written or said, same as always.) Score honestly: full only when a criterion is genuinely, amazingly met — earned flair means something because 'full' is real; half/not are recorded for the teacher and for minting flair, and the scholar never sees a fraction, a level, or a count. The API response content array containing this call must have exactly ONE tool_use block and ZERO text blocks. Forbidden: writing an assessment such as '[name] just demonstrated...' before the tool. Put the assessment only in the verdicts JSON. For a DOCUMENT rubric, a criterion hitting full mints its flair but does NOT complete the activity, and unearned criteria are not a debt; completion uses mark_activity_complete separately. When a check earns NEW flair, follow the tool result by naming it warmly and specifically in chat — recognition, not '[criterion] met'. If a criterion is below full, follow with a brief acknowledgement and one Socratic, craft-framed question about the biggest gap ('what would make this land from the back row?'), never a checklist deficiency. For a CONVERSATION ready-to-advance rubric, every criterion full still completes the activity: ${AUTOMATED_COMPLETION_CLOSING_GUIDANCE} Completion does not close the chat; respond normally if the scholar messages later. Never recite the rubric, list criteria, enumerate what's unearned, mention counts or 'N of M', or provide a worked template. Pass one verdict per criterion using the IDs exactly as shown in [brackets]. For a DOCUMENT rubric, pass artifact_id (and don't call before document content exists). For a CONVERSATION ready-to-advance rubric, OMIT artifact_id.`;

/**
 * Static tail of the tool-result guidance fed back to the model after a
 * successful `update_rubric_score` call, when at least one criterion is still
 * below `full`. Production prepends a dynamic `Updated N verdicts. Overall:
 * X.` prefix (convex/lib/tutorSessionTools.ts) — extracted here so the eval's
 * tool-result feedback matches production's judgment guidance verbatim
 * without needing to duplicate the dynamic bookkeeping.
 */
export const RUBRIC_SCORE_BELOW_FULL_GUIDANCE =
  "Now briefly name what's genuinely working, then ask one Socratic, craft-framed question about the single biggest thing that would make it land — not a checklist of what's missing.";

/**
 * Guidance fed back after every criterion in a conversation
 * ready-to-advance rubric scores `full` for the first time (no pre-tool text
 * this turn) — the activity completes and the tutor must not add model text
 * after the app-authored close.
 */
export const RUBRIC_SCORE_COMPLETE_GUIDANCE =
  `Every criterion is full, so the activity is now complete, and the app has already written its closing sentence. Do not emit any text now. If the scholar messages later, continue the conversation normally.`;

/**
 * Fed back when the model wrote non-empty text BEFORE calling the tool (a
 * tool-first violation) and that pre-tool text was not itself a valid
 * closing sentence, on a call that would otherwise have passed every
 * criterion. Production (convex/lib/tutorSessionTools.ts) rejects the score
 * entirely in this case — nothing is recorded — rather than letting an
 * invalid pre-tool ramble stand in as the closing response. Reused by the
 * eval so its harness mirrors this rejection path instead of always treating
 * a tool call as recorded regardless of what text preceded it.
 */
export const RUBRIC_SCORE_REJECTED_GUIDANCE =
  "The rubric update was not recorded because the text before the tool was not a valid closing sentence. Continue without claiming completion. On a later turn, call the tool before any text.";

/**
 * Fed back instead of RUBRIC_SCORE_COMPLETE_GUIDANCE when every criterion in
 * a conversation ready-to-advance rubric scores `full` AND the model already
 * wrote a valid closing sentence before the tool call.
 */
export const RUBRIC_SCORE_COMPLETE_SUPPRESS_FOLLOWUP_GUIDANCE =
  "Every criterion is full, so the activity is now complete. The scholar has already seen the closing response; stop now.";

/** Successful document-rubric feedback does not complete the activity. */
export const RUBRIC_SCORE_DOCUMENT_FULL_GUIDANCE =
  "This review does NOT complete the activity, and no further flair is owed; continue naturally unless the learning arc is independently ready for mark_activity_complete.";

export function rubricScoreFlairGuidance(labels: string[]): string {
  if (labels.length === 0) return "";
  return ` New flair earned: ${labels.join(", ")}. Name it warmly and specifically in chat — recognition of what they actually did, not "[criterion] met."`;
}
