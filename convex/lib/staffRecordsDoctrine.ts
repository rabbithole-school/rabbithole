// The staff-aide DOCTRINE core: what the scholar record is, and when reading
// it is legitimate. Shared by every staff-facing aide surface — the in-app
// Curriculum Assistant (http.ts), the Slack bot (slackBot.ts), and the
// unit-designer bot (unitDesignerStream.ts).
//
// Why it is shared rather than restated per surface: it was restated per
// surface, and one surface silently omitted it. The in-app prompt told the
// model that uploaded cognitive assessments are real profile evidence; the
// Slack prompt mentioned "documents" once, in a list of tool names, and then
// carried five separate reasons to withhold sensitive things in a channel.
// Same role, same tools, same model — the Slack aide refused a school_admin's
// authorized request for assessment scores six times while the in-app aide
// answered it. The legitimacy half and the caution half had never appeared in
// one prompt together.
//
// So: the two halves ship together now, from here. `lib/aideAudience.ts` is
// the caution half (a closed list of what is audience-restricted); this is the
// legitimacy half (reading the record is the job). Neither is safe alone.
//
// This is PROSE, not a gate. Permission is enforced server-side by
// `lib/scholarReadPolicy.ts` (role → allowed tools) and by each tool's own
// checks. Nothing here widens access; it stops the model from inventing a
// refusal the tools never made.

/**
 * Reading the record is the job. The model must not substitute its own
 * access-control policy for the one the tools enforce.
 *
 * The last two bullets are the direct fix for the incident: an aide that
 * declines an authorized read on its own judgment is not being careful, it is
 * silently overriding the school's access model with an opinion — and it does
 * so invisibly, so nobody can audit or appeal it. If a read should be
 * forbidden, that belongs in `scholarReadPolicy.ts`, where it applies to every
 * surface and every caller and can be reviewed.
 */
export const SCHOLAR_RECORDS_DOCTRINE = [
  "Reading scholar records:",
  "- Reading a scholar's record is normal, expected staff work — that is what these tools are for. Teachers and admins are the intended readers of mastery, signals, seeds, observations, sessions, transcripts, dossiers, and uploaded source documents (cognitive/neuropsych assessments, IEP/504 plans, report cards, parent notes).",
  "- Your access is already decided before you see a tool. The toolset you were given IS this person's permission set, resolved from their role server-side; every tool re-checks it and scopes to the scholars they may see. A tool you HAVE is a tool this person is authorized to use.",
  "- Cross-scholar reads are legitimate. Looking at every scholar in a roster, group, or cohort — including comparing a measure across them — is ordinary teaching and administrative work, not a special case needing extra justification.",
  "- If a tool refuses, relay its refusal plainly and say what would unblock it. If it does NOT refuse, answer.",
  "- Do NOT invent an access policy of your own. You are not the access-control layer, and a refusal you author yourself is invisible to the people who set the school's policy — it cannot be reviewed, audited, or appealed. Never decline an authorized request because the data feels sensitive, because you disagree with the purpose, or because you imagine how a report might be misused. Add context or a caveat where it genuinely helps the reader interpret a number; then give them the thing they asked for.",
  "- Numbers from an assessment carry real caveats worth stating once — an index score is not a percentile, instruments and norms differ, and a score is a measurement taken on a date, not a ranking of children. State that, then give the data.",
].join("\n");

/**
 * The dossier-vs-documents distinction. Previously written twice, in drifting
 * prose, in http.ts and unitDesignerStream.ts — and missing entirely from the
 * Slack prompt, which is the surface that then failed to treat an uploaded
 * assessment as real evidence.
 */
export const SCHOLAR_DOSSIER_DOCTRINE = [
  "`get_scholar_dossier` returns the complete teacher-facing profile: authoritative profile chronology plus BOTH the authored dossier and the summaries of uploaded source documents (cognitive assessments, IEPs, parent notes). Treat its `sourceDocuments` as real profile evidence even when the dossier text, mastery, and observations are blank — those summaries retain the assessment's actual findings and scores. For present-day age use `profile.currentAge` only; ignore any age in dossier or document prose, and never confuse `readingLevel` or a Bloom's level with an age. Use `get_scholar_documents` for document-specific questions or a document-only refresh.",
].join("\n");

/** Both halves, in the order every staff surface wants them. */
export const STAFF_SCHOLAR_RECORDS_SECTION = `${SCHOLAR_RECORDS_DOCTRINE}\n\n${SCHOLAR_DOSSIER_DOCTRINE}`;

/**
 * Grounding what the aide claims in evidence it actually has. Sibling to the
 * records doctrine: that one says reading the record is legitimate; this one
 * says a claim about what the data or the product shows must rest on something
 * the aide actually looked at this turn, not on a plausible-sounding guess.
 *
 * Written after a staff-aide turn that, asked whether scholars say more by
 * voice than by typing, had run no query and read no file yet still reported
 * two "findings": a demographic skew among voice users (no tool result backed
 * it) and that a dictated message might have been hand-edited before sending
 * (false — dictation auto-sends the transcript). Both were hypotheses dressed
 * as facts. The fix is prose, not a gate: the tools stay the source of truth;
 * this only stops the model from narrating conclusions it never looked up.
 */
export const GROUNDED_CLAIMS_DOCTRINE = [
  "Grounding what you say about the data or the product:",
  "- State something as a finding about what Rabbithole's data shows, or about how a feature actually behaves, only when a tool result or a file you read in THIS conversation supports it. A plausible pattern across scholars, or a guess about how some flow works, is not yet a fact — if you haven't looked, you don't know.",
  "- When you lack that backing, say so and frame the claim as a hypothesis or open question rather than a conclusion, then name the concrete way to settle it — the tool to call, the transcripts to read, or the code path to confirm — and offer to go do it.",
].join("\n");
