// The label a star on a kid's own Sky shows (TRA-699): the kid's words, tidied
// the least amount that makes them readable. Pure: no server imports.
//
// What it changes:
//   - stray spacing: runs of whitespace become one space, the ends are
//     trimmed, and a space before closing punctuation goes ("why ?" → "why?");
//   - a label typed in ALL CAPITALS becomes sentence case, with a lone "i"
//     written "I" ("WHY IS THE SKY BLUE" → "Why is the sky blue").
// What it never changes: the kid's spelling, and the capitals of a label that
// already mixes cases.
// What it hides: text that looks like random letters (a keyboard run, no
// vowels, odd consonant clusters: "asdfghjkl", "jjjjjjj"), or an empty label.
// Never numbers and symbols ("1 + 1 = ?"). The star keeps its row (`hidden`)
// and the Sky leaves it out.

export type TidiedSkyLabel = { label: string; hidden: boolean };

/** A label typed in capitals has at least this many letters before it is
 *  recased, so a short acronym ("DNA", "UFO") keeps its capitals. */
const CAPS_MIN_LETTERS = 4;
/** A plain Latin word is judged only from this length. */
const MASH_MIN_LENGTH = 5;
/** This many keys in a row along one keyboard row ("asdfg", "lkjhg"). Five,
 *  because four appear inside real words ("prop-erty", "lib-erty"). */
const MASH_KEY_RUN = 5;
/** A whole word that is one run of at least this many keys ("asdf", "hjkl"). */
const MASH_WHOLE_KEY_RUN = 4;
/** A word this long made of at most two different letters ("jjjjjj",
 *  "hahahaha") is not a question. */
const MASH_REPEAT_LENGTH = 6;
/** At least this many letter pairs, and at least this share of all pairs, are
 *  two consonants that English rarely puts together ("sd", "kj", "fh"). */
const MASH_ODD_PAIRS = 3;
const MASH_ODD_PAIR_SHARE = 0.5;
const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
/** Consonant pairs common in English words. Any consonant before a final
 *  "s" (plurals: "cats", "months") counts as common too. */
const COMMON_CONSONANT_PAIRS = new Set(
  (
    "bb bl br cc ch ck cl cr ct dd dg dr ff fl fr ft gg gh gl gn gr ht kn ld lf lk ll lm lp lt lv " +
    "mb mm mn mp nc nd nf ng nk nn ns nt ph pl pp pr ps pt rb rc rd rf rg rh rk rl rm rn rp rr rs " +
    "rt rv sc sh sk sl sm sn sp ss st sw tc th tr ts tt tw wh wl wn wr ws xt zz"
  ).split(" "),
);

const LETTER_RE = /\p{L}/u;
const PLAIN_WORD_RE = /^[a-z]+$/;
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

/** Runs of whitespace to one space, trimmed, and no space between a word and
 *  the punctuation closing it ("why ?" → "why?"). A sum keeps its spaces
 *  ("1 + 1 = ?"): only a space after a letter or digit goes. */
function compactSpacing(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<=[\p{L}\p{N}]) ([?!.,;:)\]}])/gu, "$1")
    .replace(/([([{]) (?=[\p{L}\p{N}])/gu, "$1");
}

function letters(text: string): string[] {
  return Array.from(text).filter((ch) => LETTER_RE.test(ch));
}

/** Every cased letter is a capital, and there are enough letters to tell. */
function isAllCaps(text: string): boolean {
  const cased = letters(text).filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
  if (cased.length < CAPS_MIN_LETTERS) return false;
  return cased.every((ch) => ch === ch.toUpperCase());
}

/** "WHY CAN I SEE IT" → "Why can I see it". */
function sentenceCase(text: string): string {
  const lower = text.toLowerCase().replace(/(^|[^\p{L}])i(?=$|[^\p{L}])/gu, "$1I");
  const chars = Array.from(lower);
  const first = chars.findIndex((ch) => LETTER_RE.test(ch));
  if (first >= 0) chars[first] = chars[first].toUpperCase();
  return chars.join("");
}

function keyRuns(length: number): string[] {
  const runs: string[] = [];
  for (const row of KEY_ROWS) {
    const reversed = [...row].reverse().join("");
    for (let i = 0; i + length <= row.length; i++) {
      runs.push(row.slice(i, i + length), reversed.slice(i, i + length));
    }
  }
  return runs;
}
const KEY_RUNS = keyRuns(MASH_KEY_RUN);
const ROW_TEXT = KEY_ROWS.flatMap((row) => [row, [...row].reverse().join("")]);

/** Is this one word a keyboard mash? Only plain a–z words are judged: a word
 *  in another script or with an accent is never called a mash. */
export function isMashWord(word: string): boolean {
  const w = word.toLowerCase();
  if (!PLAIN_WORD_RE.test(w)) return false;
  // The whole word is one run along a keyboard row: "asdf", "hjkl".
  if (w.length >= MASH_WHOLE_KEY_RUN && ROW_TEXT.some((row) => row.includes(w))) {
    return true;
  }
  if (w.length < MASH_MIN_LENGTH) return false;
  if (![...w].some((ch) => VOWELS.has(ch))) return true;
  if (KEY_RUNS.some((run) => w.includes(run))) return true;
  if (w.length >= MASH_REPEAT_LENGTH && new Set(w).size <= 2) return true;
  let odd = 0;
  for (let i = 0; i + 1 < w.length; i++) {
    const a = w[i];
    const b = w[i + 1];
    if (VOWELS.has(a) || VOWELS.has(b)) continue;
    if (b === "s" && i + 2 === w.length) continue;
    if (!COMMON_CONSONANT_PAIRS.has(a + b)) odd++;
  }
  return odd >= MASH_ODD_PAIRS && odd >= MASH_ODD_PAIR_SHARE * (w.length - 1);
}

/** A label is a mash when mashed words hold at least half of its letters.
 *  Text with no letters ("1 + 1 = ?") is numbers and symbols, a real
 *  question, and never a mash. */
export function isKeyboardMash(text: string): boolean {
  const total = letters(text).length;
  if (total === 0) return false;
  const words = text.split(/[^\p{L}]+/u).filter(Boolean);
  const mashed = words
    .filter(isMashWord)
    .reduce((sum, word) => sum + Array.from(word).length, 0);
  return mashed * 2 >= total;
}

/** The star's label from the kid's own words (a wonder's question, a Quest's
 *  title). Deterministic. */
export function tidySkyLabel(raw: string): TidiedSkyLabel {
  const spaced = compactSpacing(raw);
  const label = isAllCaps(spaced) ? sentenceCase(spaced) : spaced;
  // An empty label has nothing to show.
  return { label, hidden: label === "" || isKeyboardMash(label) };
}
