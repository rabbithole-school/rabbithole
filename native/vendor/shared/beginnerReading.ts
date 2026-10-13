/**
 * Beginner-reader mode (read level `beginner`, TRA-504): the pure helpers both
 * clients and the tutor prompt share. No framework imports, so web, native (a
 * vendored copy under native/vendor/shared/, refreshed by
 * native/scripts/sync-vendor.js) and Convex run the same code.
 *
 * A beginner decodes but isn't fluent (e.g. "short a and i, ck, sh"). Their
 * tutor replies are read aloud with each word lit up as it is spoken, any word
 * can be tapped to hear it, and now and then the tutor adds ONE short line
 * built only from sounds they know, for them to read themselves. Three pieces
 * live here:
 *
 *   1. The YOUR-TURN MARKER — `<your-turn>Can a pig dig?</your-turn>` — how the
 *      tutor marks that line, how a client splits a reply around it, and how
 *      the voice keeps it out of the read-aloud (the child reads it, not the
 *      voice).
 *   2. DECODABILITY — the letters and letter teams a beginner can sound out,
 *      and a mechanical check of a line against them. The client only styles a
 *      line as "your turn" when it passes, so a line the child can't decode is
 *      never presented as one they can; the prompt eval uses the same check.
 *   3. WORD TIMING — which word of a message is being spoken right now. The
 *      `/tts` voice returns audio with no word timings, so the position is
 *      ESTIMATED inside each utterance from the player's clock: every word gets
 *      a share of the clip in proportion to its syllables, plus a pause share
 *      after a comma or a sentence end. Sentences are short (the voice speaks a
 *      reply sentence by sentence), so the estimate can only drift within one
 *      short clip, and it never changes the voice.
 */

// ── 0. Who gets what ─────────────────────────────────────────────────────────

/**
 * Read-along: each word of a settled tutor reply lights up as the voice says
 * it, and a tapped word is spoken. For the two levels that are read to:
 * `listener` and `beginner`. Only `beginner` also gets the your-turn line
 * (the clients pass a decoding alphabet only for a beginner).
 */
export function readsAlong(readLevel: string | null | undefined): boolean {
  return readLevel === "listener" || readLevel === "beginner";
}

/**
 * How many steps larger a young reader's conversation text is set (the tutor's
 * replies, their own messages, the your-turn card and the composer): two for a
 * `listener`, one for a `beginner`, none for a `reader`. A step is one notch on
 * each client's own type scale (native `lib/chatType`, web Chakra font-size
 * tokens), applied on top of the device's text-size setting.
 */
export function conversationTextSteps(readLevel: string | null | undefined): 0 | 1 | 2 {
  return readLevel === "listener" ? 2 : readLevel === "beginner" ? 1 : 0;
}

/**
 * How a practice question reaches the scholar (TRA-514), on both clients:
 *  - `auto`: read aloud on its own as it appears, words lit as they're said
 *    (iPad) — a `listener`, who can't read it;
 *  - `tap`: a speaker to tap — a `beginner`, or any scholar on a
 *    kindergarten item (the old grade-K rule, kept for readers);
 *  - `none`: unchanged, a reader on any other item.
 */
export function practiceQuestionVoice(
  readLevel: string | null | undefined,
  kindergartenItem: boolean,
): "auto" | "tap" | "none" {
  if (readLevel === "listener") return "auto";
  if (readLevel === "beginner" || kindergartenItem) return "tap";
  return "none";
}

// ── 1. The your-turn marker ──────────────────────────────────────────────────

export const YOUR_TURN_OPEN = "<your-turn>";
export const YOUR_TURN_CLOSE = "</your-turn>";

/** A piece of a tutor reply: ordinary text, or a line for the child to read.
 *  `start` is where `text` begins in the raw reply, so offsets into the reply
 *  (grapheme spans) can be mapped onto the part. */
export type ReplyPart = { kind: "text" | "yourTurn"; text: string; start: number };

/**
 * Split a reply into ordinary text and your-turn lines. The parts' texts are
 * the reply minus the tags. An unclosed opening tag runs to the end (a reply
 * cut off mid-line still shows it as the child's line); an empty line drops
 * out; a stray closing tag is removed.
 */
export function splitYourTurn(content: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  const pushText = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const stray = content.indexOf(YOUR_TURN_CLOSE, i);
      const end = stray === -1 || stray >= to ? to : stray;
      if (end > i) parts.push({ kind: "text", text: content.slice(i, end), start: i });
      i = end === to ? to : end + YOUR_TURN_CLOSE.length;
    }
  };
  let i = 0;
  while (i < content.length) {
    const open = content.indexOf(YOUR_TURN_OPEN, i);
    if (open === -1) {
      pushText(i, content.length);
      break;
    }
    pushText(i, open);
    const innerStart = open + YOUR_TURN_OPEN.length;
    const close = content.indexOf(YOUR_TURN_CLOSE, innerStart);
    const innerEnd = close === -1 ? content.length : close;
    const raw = content.slice(innerStart, innerEnd);
    const text = raw.trim();
    if (text) {
      parts.push({
        kind: "yourTurn",
        text,
        start: innerStart + (raw.length - raw.trimStart().length),
      });
    }
    i = close === -1 ? content.length : close + YOUR_TURN_CLOSE.length;
  }
  return parts;
}

/** The spans (offsets into the raw reply) that fall inside `part`, shifted to
 *  offsets into `part.text`. */
export function partSpans<T extends { start: number; end: number }>(
  part: ReplyPart,
  spans: readonly T[],
): T[] {
  const end = part.start + part.text.length;
  return spans
    .filter((s) => s.start >= part.start && s.end <= end)
    .map((s) => ({ ...s, start: s.start - part.start, end: s.end - part.start }));
}

/**
 * The reply as plain text — tags removed, the line's words kept. For any
 * surface that doesn't style the line (copy, a streaming bubble, a teacher
 * view). A tag cut off at the very end ("…<your-tu", mid-stream) is dropped
 * too, so streamed text only ever grows.
 */
export function stripYourTurnMarkers(content: string): string {
  const hold = Math.max(
    partialTagSuffix(content, YOUR_TURN_OPEN),
    partialTagSuffix(content, YOUR_TURN_CLOSE),
  );
  const body = hold >= 2 ? content.slice(0, content.length - hold) : content;
  if (!body.includes("<your-turn") && !body.includes("</your-turn")) {
    return body;
  }
  return splitYourTurn(body)
    .map((p) => p.text)
    .join("");
}

/** The reply with every your-turn line removed — what the voice reads. */
export function withoutYourTurn(content: string): string {
  if (!content.includes("<your-turn") && !content.includes("</your-turn")) {
    return content;
  }
  return splitYourTurn(content)
    .filter((p) => p.kind === "text")
    .map((p) => p.text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Streaming twin of `withoutYourTurn`: feed it a reply's deltas as they arrive
 * and it returns only the text the voice may speak. Text inside a your-turn
 * line never comes out, and a delta that ends partway into a tag
 * (`"<your-t"`) is held back until the next delta settles it.
 */
export class YourTurnSpeechFilter {
  private pending = "";
  private inside = false;
  private current = "";
  /** The your-turn lines this reply carried, in order (trimmed). A line cut
   *  off by the end of the reply counts too. */
  readonly lines: string[] = [];

  push(delta: string): string {
    this.pending += delta;
    let out = "";
    for (;;) {
      const tag = this.inside ? YOUR_TURN_CLOSE : YOUR_TURN_OPEN;
      const at = this.pending.indexOf(tag);
      if (at !== -1) {
        if (!this.inside) out += this.pending.slice(0, at);
        else this.closeLine(this.pending.slice(0, at));
        this.pending = this.pending.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // No whole tag: keep back any tail that could still become one.
      const hold = partialTagSuffix(this.pending, tag);
      const ready = this.pending.slice(0, this.pending.length - hold);
      if (!this.inside) out += ready;
      else this.current += ready;
      this.pending = this.pending.slice(this.pending.length - hold);
      return out;
    }
  }

  /** End of the reply: a held fragment that never became a tag is text. */
  flush(): string {
    const rest = this.inside ? "" : this.pending;
    if (this.inside) this.closeLine(this.pending);
    this.pending = "";
    this.inside = false;
    return rest;
  }

  private closeLine(tail: string): void {
    const line = (this.current + tail).trim();
    this.current = "";
    if (line) this.lines.push(line);
  }
}

function partialTagSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

// ── 2. Decodability ──────────────────────────────────────────────────────────

/**
 * The single letters every beginner is assumed to decode: the consonants and
 * the short vowels a and i that Mentava teaches in its "Letters" band, levels
 * 1–20 (a m s t f d g i n p h b l j c v w r k; see
 * .agents/skills/mentava-progress/references/standards-mapping.md §1). A
 * beginner is past that band by definition (`suggestedReadLevelForMentava`), so
 * this is the conservative floor: short-a and short-i words like "pig", "cat",
 * "dig". Nothing stores a scholar's own known letters yet, so this is the whole
 * single-letter set; letter TEAMS come from the scholar's grapheme inventory.
 */
export const BEGINNER_KNOWN_LETTERS = "abcdfghijklmnprstvw";

/** Longest your-turn line, in words. A 6-year-old decoder reads one short
 *  sentence; more is a passage. */
export const YOUR_TURN_MAX_WORDS = 8;

export type DecodableAlphabet = {
  /** Single letters, lowercase. */
  letters: string;
  /** Letter teams (from the grapheme inventory), lowercase, ≥ 2 letters. */
  teams: string[];
};

/**
 * The alphabet for a beginner: the cautious floor of known letters plus their
 * inventory teams, plus, when a scholar's phonics program says more
 * (`extra`: e.g. what their Mentava level has taught, TRA-507), those letters
 * and teams too. With no `extra` it is exactly the floor and the inventory.
 */
export function beginnerAlphabet(
  teams: readonly string[],
  extra?: { letters?: string; teams?: readonly string[] } | null,
): DecodableAlphabet {
  const clean = Array.from(
    new Set(
      [...teams, ...(extra?.teams ?? [])]
        .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
        .filter((t) => /^[a-z]{2,}$/.test(t)),
    ),
  );
  const extraLetters = (extra?.letters ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const letters = Array.from(new Set(BEGINNER_KNOWN_LETTERS + extraLetters)).join("");
  return { letters, teams: clean };
}

/**
 * Spellings a beginner can't sound out letter by letter. Each one is allowed
 * ONLY when it is itself one of the scholar's known teams (a teacher who adds
 * "sh" to the inventory unlocks "fish"):
 *  - digraphs and trigraphs, whose letters make one new sound (sh, th, ng, …);
 *  - r-controlled vowels (ar, ir; er/or/ur already fail on e/o/u);
 *  - vowel pairs (ai, ia, …), which are vowel teams, not two short vowels;
 *  - silent letters (kn, wr, mb, gn: knit, wrap, lamb, sign);
 *  - spellings where a short a or i stops being short: "wa" (was), "all",
 *    "alk", "alt", "alm", "alf" (ball, talk, salt, calm, half), "ind" and
 *    "ild" (kind, wild);
 *  - soft c and g: "ci", "gi", "gy", "ge" (city, gin, gym, gem). This also
 *    turns away a few hard-g words ("gift"); the floor is conservative.
 * Spellings with e, o, u, x, y, q or z (old, most, -ve, y as a vowel, ox)
 * already fail on their letters unless a known team supplies them.
 */
export const UNDECODABLE_SPELLINGS = [
  // one new sound from two or three letters
  "tch", "dge", "ch", "sh", "th", "wh", "ck", "ng", "nk", "qu", "ph", "gh",
  // silent letters
  "kn", "wr", "mb", "gn",
  // r-controlled and two-vowel spellings
  "ar", "ir", "ai", "ia", "aa", "ii",
  // a or i that stops being short: wa (was), all/alk/alt/alm/alf (ball,
  // talk, salt, calm, half), ind/ild (kind, wild)
  "wa", "all", "alk", "alt", "alm", "alf", "ind", "ild",
  // soft c and g (city, gin, gym, gem)
  "ci", "gi", "gy", "ge",
] as const;

/** Words a beginner reads on sight from day one. */
const SIGHT_WORDS = new Set(["a", "i"]);

/**
 * Can a beginner sound this word out with what they know? Phonics-aware and
 * deliberately conservative:
 *  - every letter is a known single letter or part of a known team;
 *  - no spelling in `UNDECODABLE_SPELLINGS` unless that exact team is known;
 *  - exactly ONE vowel sound (a bare a or i, or one known vowel team) — so a
 *    one-syllable word. "lava" and "rabbit" have more than one, and an
 *    unstressed "a" isn't the short a they learned;
 *  - not ending on a bare vowel ("hi", "pa"): an open syllable makes it long.
 * "a" and "I" are always fine. Case-insensitive; a word with a digit or an
 * apostrophe is not decodable.
 */
export function isDecodableWord(word: string, alphabet: DecodableAlphabet): boolean {
  const w = word.toLowerCase();
  if (!/^[a-z]+$/.test(w)) return false;
  if (SIGHT_WORDS.has(w)) return true;
  // Split into sound units, longest known team first.
  const teams = [...alphabet.teams].sort((a, b) => b.length - a.length);
  const units: { text: string; start: number; team: boolean }[] = [];
  for (let i = 0; i < w.length; ) {
    const team = teams.find((t) => w.startsWith(t, i));
    if (team) {
      units.push({ text: team, start: i, team: true });
      i += team.length;
    } else if (alphabet.letters.includes(w[i])) {
      units.push({ text: w[i], start: i, team: false });
      i += 1;
    } else {
      return false;
    }
  }
  // A tricky spelling is fine only where a known team covers all of it
  // ("ch" inside a known "tch", "gh" inside a known "igh").
  const coveredByTeam = (from: number, to: number) =>
    units.some((u) => u.team && u.start <= from && u.start + u.text.length >= to);
  for (const spelling of UNDECODABLE_SPELLINGS) {
    for (let at = w.indexOf(spelling); at !== -1; at = w.indexOf(spelling, at + 1)) {
      if (!coveredByTeam(at, at + spelling.length)) return false;
    }
  }
  const isVowel = (u: { text: string }) => /[aeiou]/.test(u.text);
  if (units.filter(isVowel).length !== 1) return false;
  const last = units[units.length - 1];
  if (!last.team && isVowel(last)) return false;
  return true;
}

export type DecodabilityResult = {
  ok: boolean;
  words: number;
  /** Words that use a letter outside the alphabet. */
  undecodable: string[];
  /** The line is longer than YOUR_TURN_MAX_WORDS. */
  tooLong: boolean;
};

/**
 * The mechanical check of a your-turn line: every word decodable, and short.
 * Punctuation between words is fine; a word with a digit or apostrophe fails.
 */
export function checkDecodable(
  line: string,
  alphabet: DecodableAlphabet,
): DecodabilityResult {
  const words = line
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, ""))
    .filter(Boolean);
  const undecodable = words.filter((w) => !isDecodableWord(w, alphabet));
  const tooLong = words.length > YOUR_TURN_MAX_WORDS;
  return {
    ok: words.length > 0 && undecodable.length === 0 && !tooLong,
    words: words.length,
    undecodable,
    tooLong,
  };
}

// ── 3. Words and timing ──────────────────────────────────────────────────────

/** A word in a text: its characters [start, end) and its comparison key. */
export type WordToken = { start: number; end: number; key: string };

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/** The words of a text, with offsets. Punctuation, emoji and markdown are
 *  skipped, so a reply and its spoken form tokenise to the same keys. */
export function wordTokens(text: string): WordToken[] {
  const out: WordToken[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    out.push({
      start,
      end: start + m[0].length,
      key: m[0].toLowerCase().replace(/’/g, "'"),
    });
  }
  return out;
}

function syllables(word: string): number {
  const groups = word.toLowerCase().match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = /[^aeiouy]e$/.test(word.toLowerCase()) && groups > 1 ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/**
 * Where each word of an utterance starts, as a fraction of the clip. A word's
 * share is 0.5 + its syllables (a number counts as a few syllables); a comma
 * adds 0.75 after it and a sentence end 1.25 — the voice pauses there.
 */
export function wordStartFractions(utterance: string): number[] {
  const tokens = wordTokens(utterance);
  if (tokens.length === 0) return [];
  const weights = tokens.map((t, i) => {
    const word = utterance.slice(t.start, t.end);
    const base = /\d/.test(word) ? 0.5 + 2 * word.length : 0.5 + syllables(word);
    const next = tokens[i + 1]?.start ?? utterance.length;
    const gap = utterance.slice(t.end, next);
    const pause = /[.!?…]/.test(gap) ? 1.25 : /[,;:—–]/.test(gap) ? 0.75 : 0;
    return { base, pause };
  });
  // The last word's pause is trailing silence, not part of any word's turn.
  const total =
    weights.reduce((s, w) => s + w.base + w.pause, 0) -
    weights[weights.length - 1].pause;
  const starts: number[] = [];
  let acc = 0;
  for (const w of weights) {
    starts.push(acc / total);
    acc += w.base + w.pause;
  }
  return starts;
}

/** The voice's audio has a little silence at each end; words fill the middle. */
const LEAD_SILENCE_S = 0.12;
const TRAIL_SILENCE_S = 0.2;

/** Which word of the utterance is being said `currentTime` seconds into a clip
 *  of `duration` seconds; null before the first word or when nothing is known. */
export function wordIndexAt(
  utterance: string,
  currentTime: number,
  duration: number,
): number | null {
  const starts = wordStartFractions(utterance);
  if (starts.length === 0 || !(duration > 0)) return null;
  const speech = Math.max(0.1, duration - LEAD_SILENCE_S - TRAIL_SILENCE_S);
  const p = (currentTime - LEAD_SILENCE_S) / speech;
  if (p < 0) return null;
  let idx = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= p) idx = i;
  return idx;
}

/**
 * Where an utterance's words sit inside a message's words: the index of the
 * message word the utterance starts at, or -1. The voice speaks a message one
 * sentence at a time (or all at once when the child taps the bubble), so the
 * utterance is a contiguous run of the message's words. The first match at or
 * after `from` wins.
 */
export function locateUtterance(
  messageKeys: readonly string[],
  utteranceKeys: readonly string[],
  from = 0,
): number {
  if (utteranceKeys.length === 0) return -1;
  outer: for (let i = Math.max(0, from); i + utteranceKeys.length <= messageKeys.length; i++) {
    for (let j = 0; j < utteranceKeys.length; j++) {
      if (messageKeys[i + j] !== utteranceKeys[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Where each word of an utterance sits in the message, starting the search at
 * message word `from`: an array of message word indices, or null. Speech
 * drops list numbers ("1. Mix…" is spoken "Mix…"), so a bare number in the
 * message may be skipped.
 */
export function alignUtterance(
  messageKeys: readonly string[],
  utteranceKeys: readonly string[],
  from = 0,
): number[] | null {
  if (utteranceKeys.length === 0) return null;
  for (let start = Math.max(0, from); start < messageKeys.length; start++) {
    if (messageKeys[start] !== utteranceKeys[0]) continue;
    const at: number[] = [];
    let i = start;
    let ok = true;
    for (const key of utteranceKeys) {
      while (i < messageKeys.length && messageKeys[i] !== key && /^\d+$/.test(messageKeys[i])) i++;
      if (messageKeys[i] !== key) {
        ok = false;
        break;
      }
      at.push(i++);
    }
    if (ok) return at;
  }
  return null;
}

/**
 * The message word to light up while `utterance` plays at `currentTime` of
 * `duration`, searching from message word `from` (the voice moves forward
 * through a reply, so a repeated sentence lights its own place): an index
 * into `wordTokens(message)` plus where the utterance ends, or null when the
 * utterance isn't from this message (or no word has started yet). Falls back
 * to a search from the start when nothing matches after `from`.
 */
export function spokenWordInMessage(
  message: string,
  utterance: string,
  currentTime: number,
  duration: number,
  from = 0,
): { index: number; end: number } | null {
  const msgKeys = wordTokens(message).map((t) => t.key);
  const uttKeys = wordTokens(utterance).map((t) => t.key);
  const at = alignUtterance(msgKeys, uttKeys, from) ?? alignUtterance(msgKeys, uttKeys, 0);
  if (!at) return null;
  const k = wordIndexAt(utterance, currentTime, duration);
  return k === null ? null : { index: at[k], end: at[at.length - 1] + 1 };
}

/** How far ahead a spoken word may find its shown word (skipped symbols). */
const SHOWN_LOOKAHEAD = 3;

/**
 * The shown word to light while `utterance` plays, for a text whose spoken
 * form isn't word for word what's on screen: a practice question read through
 * `stemToSpeech` says "4 over 9" for a stacked 4/9 and "blank" for a `?` box
 * (TRA-514, listener practice). Each spoken word is matched forward against
 * the shown words within a short look-ahead; a spoken-only word ("over")
 * lights nothing. An index into `wordTokens(shown)`, or null — also null when
 * fewer than half the shown words are heard, so another text's audio
 * never lights stray words here.
 */
export function spokenWordInText(
  shown: string,
  utterance: string,
  currentTime: number,
  duration: number,
): number | null {
  const shownKeys = wordTokens(shown).map((t) => t.key);
  const spokenKeys = wordTokens(utterance).map((t) => t.key);
  if (shownKeys.length === 0 || spokenKeys.length === 0) return null;
  const at: (number | null)[] = [];
  let next = 0;
  for (const key of spokenKeys) {
    let hit: number | null = null;
    for (let m = next; m < Math.min(shownKeys.length, next + SHOWN_LOOKAHEAD); m++) {
      if (shownKeys[m] === key) {
        hit = m;
        break;
      }
    }
    at.push(hit);
    if (hit !== null) next = hit + 1;
  }
  const matched = at.filter((x) => x !== null).length;
  if (matched * 2 < shownKeys.length) return null;
  const k = wordIndexAt(utterance, currentTime, duration);
  return k === null ? null : at[k];
}

/** A colored (or plain) run of text, as `toSegments` (shared/graphemeSegments)
 *  produces it. Typed structurally to keep this module import-free. */
export type TextSegment<S = string> = { text: string; team?: string; stage?: S };

/** A run of a rendered part, tagged with the word it belongs to (null for the
 *  spaces and punctuation between words). */
export type WordRun<S = string> = TextSegment<S> & { word: number | null };

/**
 * Cut grapheme-colored segments at word boundaries, so each word can be its
 * own tappable, highlightable span while keeping its letter-team colors. The
 * runs concatenate back to the segments' text; `word` indexes
 * `wordTokens(text)`.
 */
export function wordRuns<S>(segments: readonly TextSegment<S>[]): WordRun<S>[] {
  const text = segments.map((s) => s.text).join("");
  const words = wordTokens(text);
  const wordAt = (i: number) => {
    for (let w = 0; w < words.length; w++) {
      if (i >= words[w].start && i < words[w].end) return w;
      if (words[w].start > i) break;
    }
    return null;
  };
  // Cut points: every word boundary, inside each segment.
  const cuts = new Set<number>();
  for (const w of words) {
    cuts.add(w.start);
    cuts.add(w.end);
  }
  const runs: WordRun<S>[] = [];
  let offset = 0;
  for (const seg of segments) {
    let from = 0;
    for (let i = 1; i <= seg.text.length; i++) {
      if (i === seg.text.length || cuts.has(offset + i)) {
        const piece = seg.text.slice(from, i);
        if (piece) {
          const run: WordRun<S> = { text: piece, word: wordAt(offset + from) };
          if (seg.team) run.team = seg.team;
          if (seg.stage !== undefined) run.stage = seg.stage;
          runs.push(run);
        }
        from = i;
      }
    }
    offset += seg.text.length;
  }
  return runs;
}

// ── 4. The spoken cue and reading it back ────────────────────────────────────

/**
 * What the voice says after a reply that carries a your-turn line, so a child
 * who can't read the card yet knows it's theirs. Kid-voiced, short, and it
 * names the card by what they can see (the purple box with the mic). The voice
 * never reads the line itself.
 */
export const YOUR_TURN_CUES = [
  "Your turn! Can you read the purple box out loud?",
  "Now you try! Read the words in the purple box.",
  "Your turn to read! Tap the mic in the purple box and say it.",
] as const;

/** A cue for this line: varied across lines, stable for one line. */
export function yourTurnCue(line: string): string {
  let h = 0;
  for (let i = 0; i < line.length; i++) h = (h * 31 + line.charCodeAt(i)) >>> 0;
  return YOUR_TURN_CUES[h % YOUR_TURN_CUES.length];
}

/** The your-turn line a reply asks the child to read (its last), or null. */
export function lastYourTurnLine(content: string): string | null {
  const lines = splitYourTurn(content).filter((p) => p.kind === "yourTurn");
  return lines.length > 0 ? lines[lines.length - 1].text : null;
}

export type ReadingCheck = {
  /** Words in the line. */
  words: number;
  /** Line words the transcript matched, in order. */
  matched: number;
  /** Line words not matched: `heard` is the transcript word in their place,
   *  when there was exactly one. */
  misses: { word: string; heard?: string }[];
  /**
   * False when this wasn't a real try at the line: the child said they
   * can't ("I can't read that", "I don't know", "help") or nothing was heard
   * (see `READ_ATTEMPT_RULE`). A non-attempt is not reported as matched
   * words, so the tutor never praises "you read 'I'" out of "um I can't read
   * that"; a misread ("it is pig" for "It is big.") is still an attempt.
   */
  attempted: boolean;
};

/** A refusal or non-attempt, when the line itself doesn't say it. Straight
 *  or curly apostrophes. */
const REFUSAL =
  /\b(can['’]?t|cannot|can not) (read|do|say)\b|\bdon['’]?t know\b|\bdunno\b|\bi don['’]?t\b|\bhelp\b|\btoo hard\b|\bi can['’]?t\b/i;

/** The rule for "a real try": not a refusal (unless the line itself says
 *  it), and at least one word heard. */
export const READ_ATTEMPT_RULE =
  "a refusal (\"can't read\", \"don't know\", \"help\") that isn't in the line, or nothing heard";

/**
 * Compare a child's read-aloud (a speech-to-text transcript) with the line,
 * word by word, in order (longest common subsequence of word keys). Between
 * two matched words, line words and transcript words are paired one to one as
 * "came out as"; any left over were not heard. Extra transcript words (an "um",
 * a repeat) are ignored.
 *
 * Speech-to-text tidies what it hears, so a full match means the reading
 * SOUNDED right, not proof of every sound; a miss is stronger evidence. The
 * tutor is told both (convex/lib/projectStreamMessages.ts).
 */
export function compareReading(line: string, heard: string): ReadingCheck {
  const a = wordTokens(line).map((t) => t.key);
  const b = wordTokens(heard).map((t) => t.key);
  const display = wordTokens(line).map((t) => line.slice(t.start, t.end));
  // LCS table
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const misses: ReadingCheck["misses"] = [];
  let i = 0;
  let j = 0;
  let gapA: number[] = [];
  let gapB: string[] = [];
  const closeGap = () => {
    gapA.forEach((ai, k) => {
      const sub = gapA.length === gapB.length ? gapB[k] : undefined;
      misses.push(sub ? { word: display[ai], heard: sub } : { word: display[ai] });
    });
    gapA = [];
    gapB = [];
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      closeGap();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      gapA.push(i++);
    } else {
      gapB.push(b[j++]);
    }
  }
  while (i < a.length) gapA.push(i++);
  while (j < b.length) gapB.push(b[j++]);
  closeGap();

  // Positional (the alignment above): any line word matched in order, or any
  // word heard at all, counts as a try — unless it's a refusal.
  const refused = REFUSAL.test(heard) && !REFUSAL.test(line);
  return {
    words: a.length,
    matched: dp[0][0],
    misses,
    attempted: !refused && (dp[0][0] > 0 || b.length > 0),
  };
}

// ── 5. What a beginner sees ─────────────────────────────────────────────────

/** A pictographic emoji plus the joiners/selectors/skin tones riding on it. */
const EMOJI_UNIT = /\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/**
 * The reply text a BEGINNER sees, with a map from raw offsets to display
 * offsets (-1 = removed), so grapheme spans on the raw reply still land on
 * their letters.
 *
 * Removed: markdown syntax (bold/italic markers, heading hashes, inline-code
 * ticks, list bullets) — it's noise to a child sounding words out — and
 * DECORATIVE emoji: a lone emoji in a sentence ("Catch the 🧊 ice!") is not
 * text they can decode. KEPT: a row of two or more of the same emoji
 * (🍪🍪🍪), which is a picture to count, not decoration.
 */
export function beginnerDisplay(text: string): { text: string; map: number[] } {
  const remove = new Array<boolean>(text.length).fill(false);
  const drop = (start: number, end: number) => {
    for (let k = start; k < end; k++) remove[k] = true;
  };
  // Emoji: drop lone ones, keep runs of the same one.
  const units = [...text.matchAll(EMOJI_UNIT)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    key: m[0],
  }));
  for (let u = 0; u < units.length; u++) {
    const prev = units[u - 1];
    const next = units[u + 1];
    const inRun =
      (prev && prev.end === units[u].start && prev.key === units[u].key) ||
      (next && next.start === units[u].end && next.key === units[u].key);
    if (!inRun) {
      // also take one space before it, so "the 🧊 ice" reads "the ice"
      const start = units[u].start > 0 && text[units[u].start - 1] === " " ? units[u].start - 1 : units[u].start;
      drop(start, units[u].end);
    }
  }
  // Markdown markers.
  for (const m of text.matchAll(/\*\*|__|`/g)) drop(m.index ?? 0, (m.index ?? 0) + m[0].length);
  for (const m of text.matchAll(/(^|\n)(#{1,6} |[-*+] )/g)) {
    const start = (m.index ?? 0) + m[1].length;
    drop(start, start + m[2].length);
  }
  for (const m of text.matchAll(/(?<![*\w])\*(?=\S)([^*\n]+?)\*(?!\*)/g)) {
    const start = m.index ?? 0;
    drop(start, start + 1);
    drop(start + m[0].length - 1, start + m[0].length);
  }
  const map = new Array<number>(text.length);
  let out = "";
  for (let k = 0; k < text.length; k++) {
    if (remove[k]) {
      map[k] = -1;
    } else {
      map[k] = out.length;
      out += text[k];
    }
  }
  return { text: out, map };
}

/** Spans on a raw text, moved onto its `beginnerDisplay` text. Spans whose
 *  letters were removed are dropped. */
export function mapSpans<T extends { start: number; end: number }>(
  spans: readonly T[],
  map: readonly number[],
): T[] {
  const out: T[] = [];
  for (const sp of spans) {
    const start = map[sp.start];
    const last = map[sp.end - 1];
    if (start === undefined || last === undefined || start < 0 || last < 0) continue;
    out.push({ ...sp, start, end: last + 1 });
  }
  return out;
}
