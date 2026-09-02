// Special Delivery — the editorial model call (tool schema, prompt builder,
// response parser). A plain (non-"use node") module, same reason as
// convex/lib/specialDeliveryInsertShared.ts and convex/lib/observerShared.ts:
// keep the tool schema + parsing logic in one place any eval/test harness can
// import verbatim, so a test can never quietly drift from what production
// sends the model.
//
// WHERE THIS SITS IN THE PIPELINE. Code has already done every judgment code
// can make: `shared/specialDeliveryCandidates.ts` produced RANKED, VETTED
// candidates for the two reflection sections (look-back and tomorrow-clue),
// with provenance guaranteed, staleness/quote-length vetoed, and — critically
// — teacher-facing analysis STRUCTURALLY stripped (a `LetterCandidate` has no
// `teacherAnalysis` field at the type level). This module builds the prompt
// that asks a model to do ONLY the judgments code cannot: pick among the
// survivors and WRITE the finished line, or explicitly DECLINE. Declining is a
// first-class option, as easy to express as choosing — the whole design is
// that a blank section beats a filler one.
//
// ─── CRITICAL SAFETY INVARIANT ────────────────────────────────────────────
// THIS MODEL CAN ONLY EVER MAKE A SECTION BLANK, NEVER UNSAFE.
//
// Two structural facts enforce that, and both are load-bearing:
//   1. The model only ever selects from candidates code already vetted as safe
//      to quote; it is never handed teacher-facing analysis to leak (the
//      prompt renders only the whitelisted safe fields — subject, verbatim,
//      sourceKind, datedToday — never the whole candidate object).
//   2. Every line the model returns is re-checked by `validateGeneratedLine`
//      (word budget + AI-tell rails) AND by `checkLineGrounding` (the printed
//      line must actually be anchored in the SELECTED candidate —
//      `candidateIndex` names one candidate, and only that candidate's own
//      subject/verbatim can ground the line) INSIDE `parseEditorialToolResponse`,
//      and the prose is re-checked AGAIN by `finalizeSection` before printing.
//      A failure at either point drops the section to a blank, never to a
//      guess. A model-supplied string must never bypass `validateGeneratedLine`
//      or `checkLineGrounding` on its way to print.
// Any out-of-range index, malformed payload, missing field, fabricated quote,
// ungrounded line, or unsupported number likewise degrades to DECLINE. There is
// no code path by which a bad model output can make a letter unsafe — only
// quieter.
//
// The prompt must NEVER contain teacher-facing analysis: candidates exclude it
// structurally, and this builder only renders safe fields. Do not reintroduce
// it.

import { PROSE_STYLE_GUIDE } from "../prompts";

import {
  type LetterCandidate,
  type LetterSection,
  SECTION_WORD_BUDGET,
  extractQuotedSpans,
  normalizeTypography,
  validateGeneratedLine,
} from "../../shared/specialDeliveryCandidates";

/** Bump when the prompt, tool schema, or choice semantics change materially,
 * so a frozen editorial output can be traced to the rules that produced it —
 * mirrors SPECIAL_DELIVERY_INSERT_VERSION's role for the insert call and
 * SPECIAL_DELIVERY_COPY_VERSION's for the deterministic letter body. */
export const SPECIAL_DELIVERY_EDITORIAL_VERSION = "editorial-v5";


// ─── Public result shape ──────────────────────────────────────────────────

/** The vetted candidates for both sections, as produced upstream by
 * `selectLetterCandidates`. Read-only: this module never mutates them. */
export type EditorialCandidates = {
  lookBack: readonly LetterCandidate[];
  clue: readonly LetterCandidate[];
};

/**
 * A single section's editorial outcome. `write` carries a chosen candidate
 * index (into that section's list) and a line that has ALREADY passed
 * `validateGeneratedLine`. `decline` carries a short, private reason (never
 * shown to the scholar). There is no third state — a section is either a
 * safety-checked written line or an explicit blank.
 */
export type EditorialSectionResult =
  | { kind: "write"; candidateIndex: number; line: string }
  | { kind: "decline"; reason: string };

export type EditorialResult = {
  lookBack: EditorialSectionResult;
  clue: EditorialSectionResult;
};

// ─── Tool schema ────────────────────────────────────────────────────────────
//
// Per section, the model returns EITHER a chosen candidate index + the finished
// line, OR an explicit decline with a reason. Decline is a first-class option:
// its enum value sits right beside "write", and the tool + section descriptions
// say plainly that a blank section beats a filler one. Never make declining
// harder to express than choosing.

const EDITORIAL_SECTION_INPUT_SCHEMA = {
  type: "object" as const,
  required: ["decision"],
  properties: {
    decision: {
      type: "string" as const,
      enum: ["write", "decline"],
      description:
        "'write' ONLY if a listed candidate genuinely earns a place in the letter today; 'decline' whenever nothing here clearly earns print. Declining is a first-class, fully-honest choice — a blank section always beats a filler one, so choose 'decline' as readily as 'write'.",
    },
    candidateIndex: {
      type: "integer" as const,
      description:
        "REQUIRED when decision is 'write', and ONLY meaningful then: the 0-based index of the chosen candidate from THIS section's numbered list. Never invent an index outside that list.",
    },
    line: {
      type: "string" as const,
      description:
        "REQUIRED when decision is 'write': the finished, scholar-facing sentence(s) for this section — the exact words that will be printed. Stay within the word budget stated for this section in the prompt. Write it in the child's own frame about the chosen candidate; never mention scores, rubric verdicts, teacher notes, or anything not shown to you.",
    },
    reason: {
      type: "string" as const,
      description:
        "REQUIRED when decision is 'decline': a brief, PRIVATE note (never shown to the scholar) on why nothing here earns print — e.g. 'both sections chased the same idea; kept the stronger in look-back' or 'the only quote would land as a gotcha'.",
    },
  },
};

export const SPECIAL_DELIVERY_EDITORIAL_TOOL = {
  name: "write_special_delivery",
  description:
    "For each of the two sections of today's Special Delivery letter — the look-back and the tomorrow-clue — either choose ONE of the listed, pre-vetted candidates and WRITE the finished line, or DECLINE that section. Declining is fully honest and often the right call: a blank section beats a filler one. You are choosing among material already checked as safe to quote; your job is the editorial judgment and the writing — never inventing facts, never adding anything not shown to you.",
  input_schema: {
    type: "object" as const,
    required: ["lookBack", "clue"],
    properties: {
      lookBack: EDITORIAL_SECTION_INPUT_SCHEMA,
      clue: EDITORIAL_SECTION_INPUT_SCHEMA,
    },
  },
};

// ─── Prompt assembly ────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Render one section's candidates by STABLE index, showing ONLY the
 * whitelisted safe fields (subject, verbatim, sourceKind, datedToday). Never
 * dumps the whole candidate — provenance, ranks, and internals stay out of the
 * prompt so nothing teacher-facing can leak. */
function renderCandidates(candidates: readonly LetterCandidate[]): string[] {
  if (candidates.length === 0) {
    return ["  (no candidates survived vetting for this section)"];
  }
  const lines: string[] = [];
  candidates.forEach((c, i) => {
    const quote =
      typeof c.scholarVerbatim === "string" && c.scholarVerbatim.trim()
        ? `their exact words: "${clip(c.scholarVerbatim, 300)}"`
        : "no direct quote — activity-supplied subject only";
    lines.push(`  [${i}] kind: ${c.sourceKind} · touched today: ${c.datedToday ? "yes" : "no"}`);
    lines.push(`      about: ${clip(c.subject, 220)}`);
    lines.push(`      ${quote}`);
  });
  return lines;
}

export function buildEditorialUserPrompt(args: {
  scholarFirstName: string;
  readingLevel: string | null;
  candidates: EditorialCandidates;
}): string {
  const { scholarFirstName, readingLevel, candidates } = args;

  const ageFit =
    typeof readingLevel === "string" && readingLevel.trim()
      ? `Write for this reader's level: ${clip(readingLevel, 160)}. Introduce any specialist word with a plain gloss the first time it appears.`
      : "Write for a young reader: short, concrete sentences, and gloss any specialist word the first time it appears.";

  const lookBackBudget = SECTION_WORD_BUDGET.lookBack;
  const clueBudget = SECTION_WORD_BUDGET.clue;

  const lines: string[] = [
    `Today's Special Delivery letter is for ${scholarFirstName}. It has two short reflection sections: a LOOK-BACK (what shifted in their thinking today) and a TOMORROW-CLUE (one thread to pull tomorrow). For each section, either choose ONE candidate below and write the finished line, or decline the section.`,
    "",
    "LOOK-BACK candidates (choose by index, or decline):",
    ...renderCandidates(candidates.lookBack),
    "",
    "TOMORROW-CLUE candidates (choose by index, or decline):",
    ...renderCandidates(candidates.clue),
    "",
    "Rules you must apply. Code has already handled provenance, staleness, and quote length; these are the judgments only you can make, and each is a reason to DECLINE when in doubt:",
    "1. Idea-shape — judged SILENTLY. Quote a candidate's exact words ONLY when they are a genuine idea the child generated. Apply this test in your head — is it a claim, a rule, an analogy, a coined term, or a distinction? — but treat those category words as YOUR private selection criteria, NEVER as vocabulary for the page. A stated preference (a like/dislike/favourite), a bare answer to a question, or a mere observation is NOT quotable — it is not a standing idea; decline rather than quote it. A subject-only candidate can still anchor a line without a quote, but never manufacture an idea the child did not have.",
    "1a. NEVER name the category of the child's idea on the page, and NEVER append a clause that grades, certifies, or knowingly summarises the idea. The line states the idea and asks the question — nothing else. These exact moves are forbidden (real specimens from a prior run): \"That's a real claim about representation.\" · \"That's a real rule for how a group could decide.\" · \"That's a real distinction.\" · \"That's a real problem to sit with.\" · \"worth testing further\" · \"you were really onto something.\" Each appends a knowing stamp that grades the child's thinking. Cut the stamp: say the idea, then ask the question.",
    "1b. Paraphrase a young child's nonstandard spelling — NEVER quote it. When the words you would quote carry a standalone lowercase \"i\", a long ALL-CAPS run, or invented spelling, restate the idea in clean prose instead of reproducing the orthography. Quoting a child's spelling exposes them; it is not attention, it is a spotlight on the wrong thing. Real specimen, do NOT reproduce: quoting \"You would need to think HARD and i mean HARD\" — instead paraphrase the weight the child felt in that choice, unquoted.",
    "2. No narrator, no companion (anti-parasocial). The letter is a method, not a character a child could bond with. It contains NO first person and no togetherness language — never I, me, my, we, us, or let's — and no bonding aside like \"your line stuck with me\" or \"Tomorrow, let's dig into…\". Address the child with an imperative or a question. (The child's own quoted words are the ONLY exception; quote them verbatim.)",
    "2a. Address the child ONLY as \"you\". NEVER write the child's own name, and NEVER refer to them in the third person. The letter is TO the child; a name or a \"…, <Name> said\" reference breaks that and reads as a case note about them. Real specimen (wrong): \"…takes a super long time, Lily said.\" — rewrite so the child is \"you\": \"…takes a super long time, you noticed.\"",
    "3. Parent-proof read. Picture a parent reading the line over the child's shoulder. It must be accurate and warm, and must never feel surveillant or like the school was watching too closely. If it couldn't survive that read, decline.",
    "4. Defended misconception vs. testable model. Do NOT quote or celebrate a wrong idea the child is attached to as though it were correct. DO surface a genuine, self-generated model they could actually go and test — even a tentative one.",
    "5. Quote-as-attention, never gotcha. Quoting the child's own words should feel like being noticed and taken seriously, never like being caught out or graded. If the only usable quote would land as a gotcha, decline.",
    "6. Register: intellectual warmth, not counselling. Never slip into a wellness, therapy, or counselling tone — no processing of feelings, no reassurance-speak, no \"sit with\" it. Notice the thinking.",
    "7. The surprise test. Only surface something that would genuinely surprise and delight THIS specific child because it is unmistakably about their own idea. A line any child could have received is filler — decline it.",
    "8. Coherence. If both sections would chase the same idea, keep the stronger one and DECLINE the other. The two sections must not echo each other.",
    `9. Age-fit. ${ageFit}`,
    `10. Compression — prefer LESS text at higher quality (founder directive). The look-back must be at most ${lookBackBudget} words and the tomorrow-clue at most ${clueBudget} words, but aim WELL under that: one sentence is often enough, telegram-grade. Cut every scaffolding opener — no "Today you noticed…", no "Tomorrow, try…" as filler. Start AT the idea. Target register (24 words): "You noticed a planet farther away sees Earth's past. What would a planet see if it were close enough to see Earth right now?"`,
    "11. The closing question must ask the child to PRODUCE something — an example, a boundary, a counter-case, a reason, a prediction — NEVER to render a yes/no verdict. A question answerable \"yes\" or \"no\" invites a verdict and ends the thought; a production question opens one. Forbidden (real specimens): \"Is that fair?\" · \"Is fast always the same as good?\". Rewrite as production questions: \"What would a fairer split look like?\" · \"When would fast NOT be good enough?\".",
    "11a. A tomorrow-clue must name a CONCRETE anchor — a specific thing to try, watch, count, build, or test — not a category. The anchor is what makes the clue this child's and not any child's: it points at a definite experiment tomorrow. Golden exemplar: \"Three towns of 10, 5, and 2 people, one vote each — who really decides?\" — a specific setup the child can go run. A bare \"Where else does that same problem show up?\" / \"Where else could that trade-off show up tomorrow?\" names no anchor: it is generic, filler-adjacent, and could be pasted onto any letter. If the strongest clue you can write has no concrete anchor, DECLINE the clue rather than print the generic version.",
    "12. Read-aloud test. Every line must survive an adult reading it aloud to the child in a normal voice: plain, natural word order, no inverted or compressed grammar for effect. If it only works on the page, rewrite it straight. Real specimen (clunky): \"A council with no more ideas is not failed: …\" — say it in natural order instead.",
    "",
    "Write the way this guide describes — do not write like a language model:",
    PROSE_STYLE_GUIDE,
    "",
    "Declining either or both sections is a first-class, fully-honest outcome — often the RIGHT one. When the only quotable material is minimal or hedged engagement, a blank IS the letter respecting the child: it refuses to manufacture a reflection the day did not earn. When the child's ONLY quotable material is hedged one-liners AND the day shows minimal engagement, the respectful move is BLANK — do not print merely to fill the slot. Worked example — Ryder: a starved day whose material is only hedged fragments should blank rather than reach for filler. (If you can genuinely write a line that earns its place even on such a day, that is acceptable — what is never acceptable is printing to avoid an empty section.) A blank section always beats a manufactured one. Never invent a fact, an index, or a quote that was not given to you.",
  ];

  return lines.join("\n");
}

// ─── Grounding validation ───────────────────────────────────────────────────
//
// `validateGeneratedLine` only checks the PROSE (word budget, AI-tells,
// parasocial rails, the name + spelling rails) — it has no idea whether the
// line is actually ABOUT the candidate the model claimed to choose. A model
// can satisfy every prose rail while quoting words the child never said, or
// writing a fluent line about a completely different day. `checkLineGrounding`
// is the counterpart safety rail: given the SELECTED candidate (the one
// `candidateIndex` named), it verifies the line is actually anchored to that
// candidate's own material, never to invented content.
//
// Four checks, all conservative (a false positive only blanks a section):
//   1. Every quoted span in the line must be an exact, normalized substring of
//      the candidate's `scholarVerbatim` — a model may compress/select from
//      the child's own words, but never invent or misattribute a quote.
//   2. A quote is rejected outright when the candidate has no verbatim at all
//      (an activity-supplied, subject-only candidate) — there is nothing to
//      quote, so any quoted span is fabricated by construction.
//   3. The line (its prose, quotes aside) must share at least one meaningful
//      word with the candidate's own subject/verbatim — otherwise nothing
//      ties the printed line to the material the model was actually shown.
//   4. Any numeral the line states must appear in the candidate's own
//      subject/verbatim — a model must never invent a count, a quantity, or a
//      date that was not in its source material.

export type GroundingFailure =
  | { kind: "quote-not-in-candidate"; quote: string }
  | { kind: "quote-without-verbatim"; quote: string }
  | { kind: "no-lexical-grounding" }
  | { kind: "unsupported-number"; token: string };

export type GroundingValidation = {
  ok: boolean;
  reasons: GroundingFailure[];
};

// Common short words that carry no topical meaning — excluded from the
// lexical-overlap check so two unrelated sentences don't "match" merely by
// sharing function words.
const GROUNDING_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "could",
  "each",
  "even",
  "ever",
  "every",
  "from",
  "have",
  "into",
  "just",
  "much",
  "never",
  "noticed",
  "other",
  "same",
  "shore",
  "some",
  "spend",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "time",
  "today",
  "took",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "wondered",
  "would",
  "your",
]);

function normalizeGroundingText(text: string): string {
  return normalizeTypography(text).toLowerCase();
}

/** A crude, deliberately conservative singular/plural fold — enough to match
 * "pools" against "pool" or "waves" against "wave" without any real stemming
 * library. A missed fold only costs a true positive (over-rejects toward
 * blank), never lets a fabricated line through. */
function foldPlural(word: string): string {
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function significantWords(text: string): Set<string> {
  const words = normalizeGroundingText(text)
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !GROUNDING_STOPWORDS.has(w));
  return new Set(words.map(foldPlural));
}

function numberTokens(text: string): Set<string> {
  const matches = normalizeGroundingText(text).match(/\d+/g) ?? [];
  return new Set(matches);
}

/**
 * Verify a finished line is actually grounded in the SELECTED candidate — the
 * one `candidateIndex` named — never in invented or misattributed material.
 * The caller (parseSection) only reaches this after the index has already
 * been bounds-checked, so `candidate` is always the model's actual choice.
 */
export function checkLineGrounding(
  line: string,
  candidate: LetterCandidate,
): GroundingValidation {
  const reasons: GroundingFailure[] = [];
  const normalizedLine = normalizeTypography(line);
  const verbatim = candidate.scholarVerbatim ?? "";
  const normalizedVerbatim = normalizeGroundingText(verbatim);

  // 1 + 2: every quoted span must be an exact substring of the candidate's own
  // verbatim; a quote is fabricated by construction when there is no verbatim.
  for (const quote of extractQuotedSpans(normalizedLine)) {
    const normalizedQuote = normalizeGroundingText(quote).trim();
    if (!normalizedQuote) continue;
    if (!normalizedVerbatim) {
      reasons.push({ kind: "quote-without-verbatim", quote: normalizedQuote });
      continue;
    }
    if (!normalizedVerbatim.includes(normalizedQuote)) {
      reasons.push({ kind: "quote-not-in-candidate", quote: normalizedQuote });
    }
  }

  // 3: the line as a whole (quotes included — an exact quote inherently
  // grounds a line) must share at least one meaningful word with the
  // candidate's subject/verbatim. A quote already validated by check 1/2
  // above naturally satisfies this; a wholly invented, unquoted line will not.
  const source = `${candidate.subject} ${verbatim}`;
  const sourceWords = significantWords(source);
  const lineWords = significantWords(normalizedLine);
  const hasOverlap = [...lineWords].some((w) => sourceWords.has(w));
  if (!hasOverlap) {
    reasons.push({ kind: "no-lexical-grounding" });
  }

  // 4: any numeral in the line must be traceable to the candidate's own
  // source material — never an invented count, quantity, or date.
  const sourceNumbers = numberTokens(source);
  for (const token of numberTokens(normalizedLine)) {
    if (!sourceNumbers.has(token)) {
      reasons.push({ kind: "unsupported-number", token });
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// ─── Response parsing ─────────────────────────────────────────────────────────
//
// Defensive like `parseInsertToolResponse`: every field is re-validated here
// regardless of what the tool schema "asked" for — the schema guides the model,
// it does not enforce it. An out-of-range index, a malformed payload, a missing
// field, a line that fails `validateGeneratedLine`, or a line that fails
// `checkLineGrounding` against the SELECTED candidate all degrade to DECLINE,
// never to a guess. This is where the safety invariant is enforced for a
// `write`: the returned line has provably passed the word-budget + AI-tell
// rails AND is provably anchored to the candidate the model actually chose, so
// a model-supplied string can never reach print unchecked or ungrounded.

type ResponseContentBlock = { type?: unknown; input?: unknown };

type RawSection = {
  decision?: unknown;
  candidateIndex?: unknown;
  line?: unknown;
  reason?: unknown;
};

type RawEditorialResponse = {
  lookBack?: unknown;
  clue?: unknown;
};

const DECLINE_MALFORMED = "malformed-or-missing-response";
const MAX_DECLINE_REASON = 240;

function declineResult(reason: string): EditorialSectionResult {
  const cleaned = clip(reason, MAX_DECLINE_REASON);
  return { kind: "decline", reason: cleaned || DECLINE_MALFORMED };
}

function parseSection(
  section: LetterSection,
  rawSection: unknown,
  candidates: readonly LetterCandidate[],
  scholarFirstName: string,
): EditorialSectionResult {
  if (rawSection === null || typeof rawSection !== "object") {
    return declineResult(DECLINE_MALFORMED);
  }
  const s = rawSection as RawSection;

  if (s.decision === "write") {
    const index = s.candidateIndex;
    const line = typeof s.line === "string" ? s.line.trim() : "";
    const indexOk =
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < candidates.length;

    // The line is admitted ONLY if it passes the same safety rails that run
    // again before printing, AND is provably grounded in the SELECTED
    // candidate — candidateIndex constrains the printed line to actually be
    // about the candidate it named, never any candidate, never invented.
    if (
      indexOk &&
      line.length > 0 &&
      validateGeneratedLine(line, section, scholarFirstName).ok &&
      checkLineGrounding(line, candidates[index as number]).ok
    ) {
      return { kind: "write", candidateIndex: index as number, line };
    }
    return declineResult(DECLINE_MALFORMED);
  }

  if (s.decision === "decline") {
    const reason =
      typeof s.reason === "string" && s.reason.trim()
        ? s.reason.trim()
        : "model-declined";
    return declineResult(reason);
  }

  return declineResult(DECLINE_MALFORMED);
}

/**
 * Parse + fully sanitize the model's tool-call response into a safe
 * `EditorialResult`. Any missing/malformed/out-of-range shape — including no
 * tool block at all — degrades that section to `decline` rather than throwing.
 *
 * @param content    the model response content blocks.
 * @param candidates the ACTUAL candidate arrays each section was shown — the
 *                    same `EditorialCandidates` the prompt was built from, so
 *                    `candidateIndex` can be bounds-checked AND the selected
 *                    candidate can be looked up for `checkLineGrounding`. An
 *                    index only ever selects one candidate from this list; it
 *                    never merely counts how many existed.
 * @param scholarFirstName the child's first name, threaded into
 *                    `validateGeneratedLine` so the name rail (finding #1)
 *                    fires here too, not only at print time.
 */
export function parseEditorialToolResponse(
  content: ResponseContentBlock[],
  candidates: EditorialCandidates,
  scholarFirstName: string = "",
): EditorialResult {
  const toolBlock = Array.isArray(content)
    ? content.find((b) => b && b.type === "tool_use")
    : undefined;
  const raw = (toolBlock && typeof toolBlock.input === "object" && toolBlock.input !== null
    ? toolBlock.input
    : {}) as RawEditorialResponse;

  return {
    lookBack: parseSection("lookBack", raw.lookBack, candidates.lookBack, scholarFirstName),
    clue: parseSection("clue", raw.clue, candidates.clue, scholarFirstName),
  };
}
