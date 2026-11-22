/**
 * Parent reports — the reading pass (pure; no Convex imports, so a script can
 * bundle this file on its own with esbuild).
 *
 * Before a class report is drafted, a model reads ONE child's own turns across
 * ONE unit's sessions, together with what the unit asked of them, and returns
 * a few notes: a habit of mind shown at two or more dated moments, a change
 * from an earlier moment to a later one, or something the unit asked for that
 * is unfinished. Every note must carry the child's exact words. Those quotes
 * are checked here, in code, against the turns the reader was shown, and the
 * date on each moment comes from the turn's own timestamp, never the model.
 * Only verified notes reach the drafting prompt (`buildParentReportUserPrompt`).
 *
 * Gathered by `parentReports.unitReadingInput`; called from
 * `parentReportActions.draftOne`.
 */

export type ReadingTurn = { role: "scholar" | "ai"; text: string; at: number };

export type ReadingSession = { startedAt: number; title?: string; turns: ReadingTurn[] };

/** One child × one unit, within the report's term. */
export type UnitReadingInput = {
  unitTitle: string;
  /** The class the report is for ("Math"), so the reader looks for thinking in that subject. */
  subject?: string;
  /** What the unit asked of the child: its design text, compact. */
  unitAsked: string;
  sessions: ReadingSession[];
};

export type UnitExtract = {
  /** The dated text the reader is given. */
  text: string;
  /** Scholar turns in the sessions kept. */
  scholarTurns: number;
  sessionsKept: number;
  sessionsTotal: number;
};

export type ReadingNoteKind = "habit" | "change" | "unfinished";

export type VerifiedMoment = {
  /** "Nov 13", from the turn's own timestamp. */
  date: string;
  at: number;
  /** The scholar turn's number in the extract. */
  turn: number;
  quote: string;
};

export type UnitReadingNote = { kind: ReadingNoteKind; note: string; moments: VerifiedMoment[] };

export const DEFAULT_EXTRACT_BUDGET = 28_000;
const AI_CONTEXT_CHARS = 300;
const SCHOLAR_TURN_CHARS = 600;
const UNIT_ASKED_CHARS = 2_500;
const MAX_NOTES = 3;
const MAX_MOMENTS_PER_NOTE = 4;
const MAX_NOTE_CHARS = 400;
/** A quote longer than this is not a quote of a moment; the prompt asks for ~25. */
const MAX_QUOTE_WORDS = 40;

/** "Nov 13" (UTC), the format the report evidence uses. */
export function readingDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Keep the start of a long text. */
function clipStart(text: string, max: number): string {
  const t = oneLine(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Keep the END of a long text: the AI's question is usually its last line. */
function clipEnd(text: string, max: number): string {
  const t = oneLine(text);
  return t.length > max ? `…${t.slice(t.length - (max - 1))}` : t;
}

/** A numbered scholar turn, with the AI message just before it (if any). */
type NumberedTurn = { n: number; text: string; at: number; aiBefore: string | null };
type NumberedSession = { startedAt: number; title?: string; turns: NumberedTurn[] };

/**
 * Sessions oldest first, turns in time order, every scholar turn numbered
 * from 1 across the whole unit. The numbering depends only on the input, so
 * the parser can rebuild it without the extract.
 */
function numberTurns(input: UnitReadingInput): NumberedSession[] {
  let n = 0;
  return [...input.sessions]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => {
      const turns: NumberedTurn[] = [];
      let aiBefore: string | null = null;
      for (const t of [...s.turns].sort((a, b) => a.at - b.at)) {
        if (!t.text.trim()) continue;
        if (t.role === "ai") {
          aiBefore = t.text;
          continue;
        }
        n += 1;
        turns.push({ n, text: t.text, at: t.at, aiBefore });
        // Two scholar turns in a row: the second answers no new AI message.
        aiBefore = null;
      }
      return { startedAt: s.startedAt, title: s.title, turns };
    });
}

function renderSession(s: NumberedSession, index: number, turns: NumberedTurn[] = s.turns): string {
  const title = s.title?.trim() ? ` "${clipStart(s.title, 80)}"` : "";
  const lines = [`### Session ${index + 1}, ${readingDate(s.startedAt)}${title}`];
  for (const t of turns) {
    if (t.aiBefore) lines.push(`AI: ${clipEnd(t.aiBefore, AI_CONTEXT_CHARS)}`);
    lines.push(`[${t.n}] Child (${readingDate(t.at)}): ${clipStart(t.text, SCHOLAR_TURN_CHARS)}`);
  }
  return lines.join("\n");
}

/** Evenly spread `k` indices over 0..n-1, always including both ends. */
function spread(n: number, k: number): number[] {
  if (k >= n) return [...Array(n).keys()];
  if (k <= 1) return [0];
  const out = new Set<number>();
  for (let i = 0; i < k; i++) out.add(Math.round((i * (n - 1)) / (k - 1)));
  return [...out].sort((a, b) => a - b);
}

/**
 * The reader's extract: every scholar turn, numbered, each after the AI
 * message just before it, grouped by dated session. Over the character
 * budget, whole sessions are kept spread across the unit's span (always the
 * first and the last) rather than cutting the newest or stopping mid-session.
 * Only when the first and last alone overflow are their later turns dropped.
 */
export function buildUnitExtract(
  input: UnitReadingInput,
  opts: { budget?: number } = {},
): UnitExtract {
  const budget = opts.budget ?? DEFAULT_EXTRACT_BUDGET;
  // Sessions with no scholar turn say nothing about the child.
  const all = numberTurns(input)
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.turns.length > 0);
  const blocks = all.map(({ s, i }) => renderSession(s, i));
  const size = (idx: number[]) => idx.reduce((sum, j) => sum + blocks[j].length + 2, 0);

  let keep: number[] = [];
  for (let k = all.length; k >= 1; k--) {
    const idx = spread(all.length, k);
    if (size(idx) <= budget) {
      keep = idx;
      break;
    }
  }
  let parts: string[];
  let turnsKept: number;
  if (keep.length > 0 || all.length === 0) {
    parts = keep.map((j) => blocks[j]);
    turnsKept = keep.reduce((sum, j) => sum + all[j].s.turns.length, 0);
  } else {
    // Even one session is over budget: keep the first and the last, each
    // trimmed to its share by dropping its later turns.
    const ends = spread(all.length, 2);
    const share = Math.floor(budget / ends.length) - 2;
    parts = [];
    turnsKept = 0;
    for (const j of ends) {
      const { s, i } = all[j];
      let turns = s.turns;
      while (turns.length > 1 && renderSession(s, i, turns).length > share) turns = turns.slice(0, -1);
      parts.push(renderSession(s, i, turns));
      turnsKept += turns.length;
    }
    keep = ends;
  }
  return {
    text: parts.join("\n\n"),
    scholarTurns: turnsKept,
    sessionsKept: keep.length,
    sessionsTotal: all.length,
  };
}

/** The unit's design text, capped (built by the caller from the unit row). */
export function capUnitAsked(text: string): string {
  const t = text.trim();
  return t.length > UNIT_ASKED_CHARS ? `${t.slice(0, UNIT_ASKED_CHARS - 1)}…` : t;
}

export function buildUnitReadingSystemPrompt(): string {
  return `You read one child's own words across one unit of school work and note what they show. A teacher at a school for gifted children will use your notes to write the child's end-of-term report for their parents. Your notes are the evidence the report is written from.

You get two things: what the unit asked of the child, and the child's turns from every session they had in the unit with Rabbithole, the school's AI. Each child turn is numbered, like [12], and dated. The AI message just before a turn is shown for context.

## What to look for
Find at most ${MAX_NOTES} notes. Each note is one of these kinds:
- "habit": one way of thinking or working that shows at two or more dated moments. Name the habit plainly ("checks an idea against a hard case", "asks why a rule works before using it").
- "change": something the child could not do, or said wrongly, at one dated moment, and did or said correctly at a later one. Both moments are required: the earlier one and the later one.
- "unfinished": something the unit asked for that the child has started and not finished, or has not attempted yet. Say what it is and where these sessions leave it; you only see the child's sessions with the AI, and work may have gone further in class. A quote is welcome when one shows where the work stopped, and not required.

A good note tells a parent something specific about how their child thinks. One clear note is better than three thin ones, and an empty list is a fine answer when the turns show no habit, no change and nothing unfinished.

## Quotes are the evidence
- Every moment needs a quote copied exactly from that numbered child turn: a contiguous run of the child's own words, at most about 25 words. Copy spelling and punctuation as they are.
- A habit or a change without two such quotes is not a note. Leave it out.
- The AI's messages are context only. Never credit the child with an idea the AI said first, and never quote the AI.
- Short replies like "yes" or "ok" are not evidence of anything.
- Many sessions have the child building an app with the AI. Requests about how the app looks, and reports that a button or screen doesn't work, show the child building software. They are evidence only when the request itself shows thinking in the class's subject, such as asking for both groups of plants to be measured the same way. A note should be about how the child thinks in the subject the request names. When the turns hold nothing like that, return no habit or change.
- Choose moments that show the child thinking. A turn where the child says they don't know or forgot is never a quote to use.

## How to write each note
- One or two plain sentences about what the child did, in everyday words a parent would understand.
- No education or internal terms (Bloom's, mastery, rubric, metacognition, scaffold, frontier). No diagnosis, no guesses about attention or feelings, no worry about behaviour, and nothing about any other child.
- Describe what the child did ("worked out why the pattern holds") and leave out praise words like "excellent" or "impressive".

## Output
Return strict JSON only, with no other text:
{ "notes": [ { "kind": "habit" | "change" | "unfinished", "note": "…", "moments": [ { "date": "Nov 13", "turn": 12, "quote": "exact words from turn 12" } ] } ] }
Order a note's moments from earliest to latest.`;
}

export function buildUnitReadingRequest(input: UnitReadingInput, extract: UnitExtract): string {
  const lines = [`## The unit: ${oneLine(input.unitTitle)}`];
  if (input.subject?.trim())
    lines.push(`This unit is part of the child's ${oneLine(input.subject)} class. The report is about ${oneLine(input.subject)}.`);
  const asked = capUnitAsked(input.unitAsked);
  lines.push("", "## What the unit asked", asked || "(no description recorded; judge from the sessions)");
  lines.push("", "## The child's turns, by session");
  if (extract.sessionsKept < extract.sessionsTotal)
    lines.push(
      `(${extract.sessionsKept} of ${extract.sessionsTotal} sessions are shown, spread from the first to the last. Turn numbers skip the sessions left out.)`,
    );
  lines.push("", extract.text, "", "Return the JSON now.");
  return lines.join("\n");
}

/** Lowercased, straight quotes and dashes, single spaces: for matching only. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/** The quote as written, without wrapping quote marks or an ellipsis. */
function cleanQuote(q: string): string {
  return oneLine(q)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "")
    .trim();
}

function parseJson(raw: string): unknown {
  let t = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // A sentence around the object: take the outermost braces.
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const KINDS = new Set<ReadingNoteKind>(["habit", "change", "unfinished"]);

/**
 * The reader's notes, verified against the turns: each moment's turn must
 * exist and its quote must appear in that turn's text (ignoring case,
 * whitespace and curly-versus-straight quotes). A habit or a change needs two
 * verified moments on different turns; an unfinished note may have none.
 * Dates come from the turns' timestamps. Bad output gives [], never a throw.
 */
export function parseUnitReadingNotes(raw: string, input: UnitReadingInput): UnitReadingNote[] {
  try {
    const parsed = parseJson(raw) as { notes?: unknown } | null;
    const notes = parsed && Array.isArray(parsed.notes) ? parsed.notes : [];
    const turns = new Map<number, NumberedTurn>();
    for (const s of numberTurns(input)) for (const t of s.turns) turns.set(t.n, t);
    const out: UnitReadingNote[] = [];
    for (const n of notes) {
      if (out.length >= MAX_NOTES) break;
      if (!n || typeof n !== "object") continue;
      const { kind, note, moments } = n as { kind?: unknown; note?: unknown; moments?: unknown };
      if (typeof kind !== "string" || !KINDS.has(kind as ReadingNoteKind)) continue;
      if (typeof note !== "string" || !note.trim()) continue;
      const verified: VerifiedMoment[] = [];
      const used = new Set<number>();
      for (const m of Array.isArray(moments) ? moments : []) {
        if (!m || typeof m !== "object") continue;
        const { turn, quote } = m as { turn?: unknown; quote?: unknown };
        const num = typeof turn === "number" ? turn : typeof turn === "string" ? Number(turn.replace(/[^\d]/g, "")) : NaN;
        const t = Number.isInteger(num) ? turns.get(num) : undefined;
        if (!t || used.has(num) || typeof quote !== "string") continue;
        const q = cleanQuote(quote);
        const nq = normalize(q);
        if (nq.length < 2 || q.split(/\s+/).length > MAX_QUOTE_WORDS) continue;
        if (!normalize(t.text).includes(nq)) continue;
        used.add(num);
        verified.push({ date: readingDate(t.at), at: t.at, turn: num, quote: q });
      }
      verified.sort((a, b) => a.at - b.at || a.turn - b.turn);
      const moments2 = verified.slice(0, MAX_MOMENTS_PER_NOTE);
      if (kind !== "unfinished" && moments2.length < 2) continue;
      out.push({
        kind: kind as ReadingNoteKind,
        // Square brackets are teacher placeholders downstream.
        note: clipStart(note, MAX_NOTE_CHARS).replace(/\[/g, "(").replace(/\]/g, ")"),
        moments: kind === "unfinished" ? moments2.slice(0, 1) : moments2,
      });
    }
    return out;
  } catch {
    return [];
  }
}

const KIND_LABEL: Record<ReadingNoteKind, string> = {
  habit: "A habit",
  change: "A change",
  unfinished: "Not finished yet",
};

/** Lines for the drafting prompt: each note, then its dated quotes. */
export function formatUnitNotes(unitTitle: string, notes: UnitReadingNote[]): string[] {
  if (notes.length === 0) return [];
  const lines = [`### ${oneLine(unitTitle)}`];
  for (const n of notes) {
    lines.push(`- ${KIND_LABEL[n.kind]}: ${n.note}`);
    for (const m of n.moments) lines.push(`  - ${m.date}: "${m.quote.replace(/"/g, "'")}"`);
  }
  return lines;
}
