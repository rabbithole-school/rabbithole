/**
 * Grapheme-team annotation — pure logic (the "reading ramp" instrumentation).
 *
 * The young-learners reading ramp (`review/young-learners-plan.html` §10) colors
 * grapheme teams (digraphs / vowel teams / doubled letters like "sh", "th", "ea",
 * "oo") inside on-screen tutor text as Mentava-style training wheels, so a
 * pre-reader sees the letters of a team as one sound-unit. English
 * grapheme→phoneme mapping is context-dependent ("ch" = /tʃ/ chair, /k/ school,
 * /ʃ/ chef; "ea" splits bread/bead/break; "sh" in *mishap* is a syllable boundary,
 * not a digraph), so the annotator is a CHEAP-MODEL judgment pass, not a rule
 * engine (see `convex/graphemeActions.ts`).
 *
 * This module is deliberately plain (NOT "use node") so the eval harness
 * (`evals/grapheme-pass/`) and unit tests can import the EXACT prompt-building +
 * validation logic the production action uses — the eval can never drift from
 * what ships. (Same split as `convex/lib/observerShared.ts`.)
 *
 * ── Contract (v1) ────────────────────────────────────────────────────────────
 * • A **grapheme team** is a contiguous multi-letter spelling (digraph, trigraph,
 *   vowel team, or doubled letters) that a beginning reader learns as ONE
 *   sound-unit. The team string is the letters, lowercased (e.g. "sh", "th",
 *   "ch", "ea", "oo", "ll", "ck").
 * • annotate({ text, teams }) → { start, end, team }[] — character offsets into
 *   `text` where an occurrence of a team's letters TRULY functions as that team's
 *   single **target sound**.
 * • An occurrence is FALSE (not annotated) when either:
 *     (1) it straddles a syllable / morpheme boundary — the letters belong to
 *         different syllables and are pronounced separately (e.g. "sh" in
 *         mis·hap, "th" in hot·house, "oo" in co·operate); OR
 *     (2) the letters make a DIFFERENT sound than the team's target phoneme
 *         (e.g. with "ch" trained as /tʃ/ as in *chair*, the "ch" in *school*
 *         (/k/) and *chef* (/ʃ/) are FALSE). "th" is the one team whose target
 *         covers BOTH the voiced (*then*) and unvoiced (*thin*) dental
 *         fricative — a beginning reader learns "th" as one team.
 * • Empty inventory → return [] WITHOUT calling the model. Likewise, if no
 *   inventory team's letters literally appear in the text, there is nothing to
 *   judge → return [] without a call.
 * • Offsets are computed HERE from the source text; the model only chooses which
 *   pre-enumerated candidate occurrences are true. So the pass can never alter
 *   the text, and every emitted span provably matches the team's letters.
 * • Out of scope for v1: the split/discontinuous **silent-e (magic-e)** pattern
 *   (vowel … consonant … silent "e"), which is not a contiguous [start, end)
 *   substring and would need a different span shape. Documented, deferred.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isPreReader } from "./readingLevels";
import type { GraphemeStage } from "../../shared/graphemeSegments";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A validated annotation: `text.slice(start, end)` are the letters of `team`. */
export interface GraphemeSpan {
  start: number;
  end: number;
  team: string;
}

/**
 * A literal occurrence of a team's letters in the text — a place the model must
 * judge true-or-false. `id` is a stable index used as the model's currency
 * (it returns the ids it deems true), so WE own offset arithmetic, not the model.
 */
export interface GraphemeCandidate {
  id: number;
  team: string;
  start: number;
  end: number;
}

// ─── Team inventory normalization ────────────────────────────────────────────

/**
 * Canonicalize a scholar's declared team inventory: trim, lowercase, keep only
 * letter-strings of length ≥ 2 (a single letter is not a "team"), dedupe while
 * preserving first-seen order. Non-conforming entries are dropped rather than
 * throwing — an upstream inventory is best-effort, and a junk entry must never
 * fail the whole pass.
 */
export function normalizeTeams(teams: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of teams) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (t.length < 2) continue;
    if (!/^[a-z]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ─── Reading-ramp inventory + annotation gate ────────────────────────────────

/**
 * One entry in a scholar's grapheme confidence map (`graphemeInventories`): a
 * team and how far its training-wheel color has faded. `stage` reuses the render
 * layer's `GraphemeStage` so the gate here and the paint downstream can never
 * disagree about the vocabulary.
 */
export interface GraphemeInventoryTeam {
  team: string;
  stage: GraphemeStage;
}

/**
 * The teams whose training wheels are still on — i.e. NOT yet `graduated`.
 * Normalized (trim/lowercase/letters-only/deduped) so the value handed to the
 * annotator is exactly the candidate-scan vocabulary. This is the ONLY team
 * list the model should ever judge: graduated teams render as plain ink, so
 * coloring them would be noise (and text-as-rainbow-soup — see §10).
 */
export function nonGraduatedTeams(teams: GraphemeInventoryTeam[]): string[] {
  return normalizeTeams(
    teams.filter((t) => t && t.stage !== "graduated").map((t) => t.team),
  );
}

/**
 * Canonicalize a teacher-authored inventory before it's stored: lowercase/trim
 * each team, drop entries whose team isn't a valid letter-team (≥2 letters —
 * same rule as `normalizeTeams`), and dedupe by team keeping the FIRST stage
 * seen. Stage strings themselves are validated declaratively at the mutation
 * boundary (the `graphemeInventories` schema union), so they're trusted here.
 */
export function normalizeInventoryTeams(
  teams: GraphemeInventoryTeam[],
): GraphemeInventoryTeam[] {
  const seen = new Set<string>();
  const out: GraphemeInventoryTeam[] = [];
  for (const entry of teams) {
    if (!entry || typeof entry.team !== "string") continue;
    const [team] = normalizeTeams([entry.team]);
    if (!team) continue;
    if (seen.has(team)) continue;
    seen.add(team);
    out.push({ team, stage: entry.stage });
  }
  return out;
}

/**
 * The pre-stream decision: should this turn's tutor text be grapheme-annotated
 * for this reader? True iff BOTH hold:
 *   • the resolved reading level is the pre-reader tier (`isPreReader`), AND
 *   • the scholar's inventory has ≥1 team not yet `graduated`.
 * Everyone else — every grade band, and a pre-reader who has graduated every
 * team — gets no annotation and no model call. Pure + total so the streaming
 * hook can gate on it without a DB read of its own.
 */
export function shouldAnnotateGraphemes(
  readingLevel: string | null | undefined,
  teams: GraphemeInventoryTeam[],
): boolean {
  if (!isPreReader(readingLevel)) return false;
  return nonGraduatedTeams(teams).length > 0;
}

/**
 * Find every case-insensitive literal occurrence of each inventory team in the
 * text. Per team the scan is left-to-right and non-overlapping (so "sh" in
 * "shush" yields one candidate at each of the two "sh"es). Across teams, matches
 * MAY overlap (e.g. "ch" and "tch" both present) — that's resolved later in
 * `validateSpans`.
 *
 * Candidates are ordered by (start asc, longer team first, team asc) and given
 * sequential ids in that order, so the id↔offset mapping is deterministic and
 * the model sees them in reading order.
 */
export function findCandidates(
  text: string,
  teams: string[],
): GraphemeCandidate[] {
  const normalized = normalizeTeams(teams);
  if (normalized.length === 0) return [];
  const lower = text.toLowerCase();

  const raw: Array<{ team: string; start: number; end: number }> = [];
  for (const team of normalized) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(team, from);
      if (idx === -1) break;
      raw.push({ team, start: idx, end: idx + team.length });
      from = idx + team.length; // non-overlapping per team
    }
  }

  raw.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) || // longer team first
      (a.team < b.team ? -1 : a.team > b.team ? 1 : 0),
  );

  return raw.map((c, id) => ({ id, ...c }));
}

// ─── Model surface: system prompt + forced tool ──────────────────────────────

/**
 * The model's contract. It receives the text and an enumerated candidate list;
 * it returns only the ids of candidates that truly function as their team's
 * sound-unit. It never edits text and never invents offsets.
 */
export const GRAPHEME_SYSTEM_PROMPT = `You are a phonics annotator for a beginning-reader tool. You judge grapheme teams.

A "grapheme team" is a group of letters a new reader learns to read as ONE sound-unit — a digraph, a vowel team, or a doubled letter. Examples: sh, th, ch, ea, oo, ll, ck, ai, ay, ee, oa, igh, ng.

You will be given:
1. A short piece of text (a tutor's message shown on screen to the child).
2. A numbered list of CANDIDATE occurrences — every place where the letters of one of the child's training teams literally appear in the text, with the surrounding context. The matched letters are wrapped in «double angle brackets».

Your ONLY job: return the ids of the candidates where those letters TRULY act as that team's single sound-unit. Judge each candidate independently.

Capitalization is irrelevant: "Sh" in "She", "Th" in "The", "Ch" in "Chair" are the SAME teams as lowercase. Judge every candidate, including common words that begin a sentence — The, She, This, When, Which ARE teams and should be marked.

A candidate is TRUE only if BOTH hold:
• The letters belong to the SAME syllable and spell ONE sound together (a real digraph / team), NOT two separate letters split across a syllable or word-part boundary. Boundary examples that are FALSE: "sh" in mis·hap and dis·honest (s then h); "th" in hot·house, light·house, sweet·heart (t then h); "oo" in co·operate and co·ordinate (two separate o's); doubled letters split across a compound like "kk" in book·keeper.
• The team makes its TARGET sound (below). If the letters clearly make a DIFFERENT sound, the candidate is FALSE — but only exclude on this rule when you are confident the sound really differs.

Target sound per team (this is what the color teaches — do not color a look-alike that makes a different sound):
• sh → /ʃ/ as in ship, shore, wish.
• ch → /tʃ/ as in chair, cheese, lunch. FALSE when it is /k/ (school, ache, stomach) or /ʃ/ (chef, machine, chute).
• th → the "th" dental sound, EITHER voiced (then, this, mother) OR unvoiced (thin, bath, math) — both are TRUE.
• wh → /w/ (or /hw/) as in when, why. FALSE when /h/ (who, whole).
• ph → /f/ as in phone, graph.
• ck → /k/ as in duck, back.
• ng → /ŋ/ as in ring, song. FALSE when the n and g are separate (fin·ger has /ŋg/; still one team is debatable — treat clear /ŋ/ endings like -ing/-ang/-ong/-ung as TRUE).
• ea → /iː/ (long e) as in bead, team, each, read(present). FALSE when /ɛ/ (bread, head, dead) or /eɪ/ (break, great, steak).
• ee → /iː/ as in tree, see, feet.
• ai → /eɪ/ as in rain, train, sail.
• ay → /eɪ/ as in play, day, stay.
• oa → /oʊ/ as in boat, road, coat.
• oo → the "oo" vowel-team sound, EITHER /uː/ (moon, food) OR /ʊ/ (book, good) — both are TRUE. FALSE when the two o's are separate (co·operate).
• igh → /aɪ/ as in light, night, high.
• Doubled consonants (ll, ss, ff, zz, tt, dd, nn, mm, pp, rr, gg, bb) → the single consonant sound as in bell, kiss, off, buzz. TRUE when they spell one sound; FALSE when split across a word boundary in a compound.
• For any team not listed here, use its most common beginning-reader sound and apply the same two rules.

Unfamiliar words: for a name, place, or made-up word, decide from how an English reader would most naturally pronounce it. MOST names decode normally and ARE teams: Josh (sh /ʃ/), Beth (th /θ/), Rachel (ch /tʃ/), Shane (sh /ʃ/) are all TRUE. Mark a proper noun FALSE only for a known irregular where the letters plainly make a different sound: Thomas and Thailand (th = /t/), Chicago and Michigan (ch = /ʃ/), Christmas (ch = /k/). A made-up word usually decodes straight (a nonsense "choob" reads with /uː/, so its "oo" is TRUE).

Return the ids of the TRUE candidates. Return an empty list if none are true. Never change the text.`;

/** Forced structured output — mirrors the observer's tool_choice pattern. */
export const GRAPHEME_TOOL = {
  name: "mark_grapheme_teams" as const,
  description:
    "Record which candidate occurrences truly function as their grapheme team's sound-unit.",
  input_schema: {
    type: "object" as const,
    required: ["trueTeamIds"],
    properties: {
      trueTeamIds: {
        type: "array" as const,
        items: { type: "integer" as const },
        description:
          "Ids of the candidates that are TRUE grapheme-team occurrences. Empty array if none.",
      },
    },
  },
};

const CONTEXT_WINDOW = 16;

/**
 * Render the user message: the full text once, then each candidate on its own
 * line as `[id] "…left«match»right…" (in "word")`. The «» markers show the model
 * exactly which letters are under judgment without it having to count characters.
 */
export function buildAnnotationUserMessage(
  text: string,
  candidates: GraphemeCandidate[],
): string {
  const lines: string[] = [];
  lines.push("TEXT:");
  lines.push(text);
  lines.push("");
  lines.push("CANDIDATES (judge each; return the ids that are TRUE teams):");
  for (const c of candidates) {
    const leftStart = Math.max(0, c.start - CONTEXT_WINDOW);
    const rightEnd = Math.min(text.length, c.end + CONTEXT_WINDOW);
    const left = text.slice(leftStart, c.start);
    const match = text.slice(c.start, c.end);
    const right = text.slice(c.end, rightEnd);
    const lead = leftStart > 0 ? "…" : "";
    const trail = rightEnd < text.length ? "…" : "";
    const word = wordAround(text, c.start, c.end);
    lines.push(
      `[${c.id}] team "${c.team}": ${lead}${left}«${match}»${right}${trail} (in "${word}")`,
    );
  }
  return lines.join("\n");
}

/** The whitespace-delimited token containing [start,end). Purely for context. */
function wordAround(text: string, start: number, end: number): string {
  let l = start;
  while (l > 0 && !/\s/.test(text[l - 1])) l--;
  let r = end;
  while (r < text.length && !/\s/.test(text[r])) r++;
  return text.slice(l, r);
}

// ─── Response parsing ────────────────────────────────────────────────────────

/** Minimal structural shape of an Anthropic response content block. */
type ResponseContentBlock = { type: string; input?: unknown };

/**
 * Pull the chosen ids out of the model's forced tool_use block. Returns null
 * when no tool block is present (caller treats that as "annotate nothing").
 * Non-integer / junk entries are filtered defensively.
 */
export function parseGraphemeToolResponse(
  content: ResponseContentBlock[],
): number[] | null {
  const toolBlock = content.find((b) => b.type === "tool_use");
  if (!toolBlock) return null;
  const input = toolBlock.input as { trueTeamIds?: unknown } | undefined;
  const ids = input?.trueTeamIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter(
    (n): n is number => typeof n === "number" && Number.isInteger(n),
  );
}

// ─── Span selection + hard validation ────────────────────────────────────────

/** Map the model's chosen candidate ids back to raw (unvalidated) spans. */
export function selectSpans(
  candidates: GraphemeCandidate[],
  trueIds: number[],
): GraphemeSpan[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chosen = new Set(trueIds);
  const spans: GraphemeSpan[] = [];
  for (const id of chosen) {
    const c = byId.get(id);
    if (c) spans.push({ start: c.start, end: c.end, team: c.team });
  }
  return spans;
}

/**
 * The hard guarantee. Given any list of proposed spans, keep only the ones that
 * are genuinely valid against the source text, resolve overlaps, and sort:
 *   • drop out-of-range / inverted spans (`0 ≤ start < end ≤ text.length`);
 *   • drop any span whose `text.slice(start,end)` letters do not exactly match a
 *     normalized team string (the "never alter the text" + "provably matches"
 *     guarantee — a mismatched-letters span is discarded, never rendered);
 *   • resolve overlaps greedily in reading order, longer span first, dropping
 *     any later span that overlaps an already-kept one;
 *   • return sorted by start.
 *
 * Pure and total — this is the offset-validation seam the unit tests hit
 * directly, and every model-produced span passes through it before it can ship.
 */
export function validateSpans(
  text: string,
  spans: GraphemeSpan[],
): GraphemeSpan[] {
  const valid = spans.filter((s) => {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) return false;
    if (s.start < 0 || s.end > text.length || s.start >= s.end) return false;
    const team = s.team.trim().toLowerCase();
    if (normalizeTeams([team]).length === 0) return false;
    return text.slice(s.start, s.end).toLowerCase() === team;
  });

  // Deterministic order for greedy overlap resolution: start asc, longer first.
  valid.sort((a, b) => a.start - b.start || b.end - a.end);

  const kept: GraphemeSpan[] = [];
  let lastEnd = -1;
  for (const s of valid) {
    if (s.start >= lastEnd) {
      kept.push({ start: s.start, end: s.end, team: s.team.toLowerCase() });
      lastEnd = s.end;
    }
  }
  return kept;
}

/**
 * Convenience: candidates + the model's chosen ids → final validated spans.
 * Used by both the production action and the eval so they share one path.
 */
export function annotateFromToolResult(
  text: string,
  candidates: GraphemeCandidate[],
  trueIds: number[],
): GraphemeSpan[] {
  return validateSpans(text, selectSpans(candidates, trueIds));
}
