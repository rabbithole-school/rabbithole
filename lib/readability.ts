const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
const CLOSING_PUNCTUATION_RE = /["'”’)]/;
const VOWEL_GROUP_RE = /[aeiouy]+/g;
const ABBREVIATION_RE = /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e)\.$/;

const SYLLABLE_OVERRIDES = new Map<string, number>([
  ["business", 2],
  ["every", 2],
  ["hour", 1],
  ["one", 1],
  ["once", 1],
  ["people", 2],
  ["queue", 1],
]);

export interface ReadabilityStats {
  sentenceCount: number;
  wordCount: number;
  syllableCount: number;
  fleschKincaidGrade: number;
  fleschReadingEase: number;
}

export interface FKResult {
  gradeLevel: number;
  level: string;
  wordCount: number;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char === "\n") return true;
  if (char !== "." && char !== "!" && char !== "?") return false;

  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (char === "." && /\d/.test(previous) && /\d/.test(next)) return false;

  const prefix = text.slice(Math.max(0, index - 12), index + 1).toLowerCase();
  if (ABBREVIATION_RE.test(prefix)) return false;

  let lookahead = index + 1;
  while (lookahead < text.length && CLOSING_PUNCTUATION_RE.test(text[lookahead] ?? "")) {
    lookahead += 1;
  }
  return lookahead >= text.length || /\s/.test(text[lookahead] ?? "");
}

/** Split text into sentence-like spans for readability formulas. */
export function segmentSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    if (!isSentenceBoundary(normalized, i)) continue;

    let end = i + 1;
    while (end < normalized.length && CLOSING_PUNCTUATION_RE.test(normalized[end] ?? "")) {
      end += 1;
    }

    const sentence = normalized.slice(start, end).replace(/\s+/g, " ").trim();
    if (tokenizeWords(sentence).length > 0) sentences.push(sentence);

    while (end < normalized.length && /\s/.test(normalized[end] ?? "")) end += 1;
    start = end;
    i = end - 1;
  }

  const remainder = normalized.slice(start).replace(/\s+/g, " ").trim();
  if (tokenizeWords(remainder).length > 0) sentences.push(remainder);

  return sentences;
}

/** Return word tokens containing letters, preserving contractions as one token. */
export function tokenizeWords(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/^[^a-z]+|[^a-z]+$/g, "");
}

/**
 * Count syllables with a standard vowel-group heuristic.
 * Handles common silent-e, consonant+-le, and silent -es/-ed endings.
 */
export function countSyllables(word: string): number {
  const normalized = normalizeWord(word);
  if (!normalized) return 0;

  const override = SYLLABLE_OVERRIDES.get(normalized);
  if (override !== undefined) return override;
  if (normalized.length <= 3) return 1;

  let syllables = (normalized.match(VOWEL_GROUP_RE) ?? []).length;

  if (/[aeiouy]ing$/.test(normalized) && /[^aeiouy][aeiouy][^aeiouy]ing$/.test(normalized)) {
    syllables += 1;
  }

  if (/[^aeiouy]le$/.test(normalized)) {
    // The final e is pronounced as part of an -le syllable: table, little, syllable.
  } else if (/e$/.test(normalized) && !/(?:ee|ye)$/.test(normalized)) {
    syllables -= 1;
  }

  if (/(?:[^aeiouy]ed)$/.test(normalized) && !/(?:ted|ded)$/.test(normalized)) {
    syllables -= 1;
  }

  if (/(?:[^aeiouy]es)$/.test(normalized) && !/(?:ses|xes|zes|ches|shes)$/.test(normalized)) {
    syllables -= 1;
  }

  return Math.max(1, syllables);
}

export function readabilityStats(text: string): ReadabilityStats {
  const words = tokenizeWords(text);
  if (words.length === 0) {
    return {
      sentenceCount: 0,
      wordCount: 0,
      syllableCount: 0,
      fleschKincaidGrade: 0,
      fleschReadingEase: 0,
    };
  }

  const sentenceCount = Math.max(1, segmentSentences(text).length);
  const syllableCount = words.reduce((total, word) => total + countSyllables(word), 0);
  const wordsPerSentence = words.length / sentenceCount;
  const syllablesPerWord = syllableCount / words.length;

  const grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
  const ease = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;

  return {
    sentenceCount,
    wordCount: words.length,
    syllableCount,
    fleschKincaidGrade: roundTo(Math.max(0, grade), 2),
    fleschReadingEase: roundTo(clamp(ease, 0, 100), 2),
  };
}

export function fleschKincaidGrade(text: string): number {
  return readabilityStats(text).fleschKincaidGrade;
}

export function fleschReadingEase(text: string): number {
  return readabilityStats(text).fleschReadingEase;
}

function gradeToLevel(gradeLevel: number): string {
  if (gradeLevel < 1) return "K";
  if (gradeLevel >= 13) return "college";
  const rounded = roundTo(gradeLevel, 1);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Backward-compatible wrapper for older UI code that scored a batch of texts. */
export function fleschKincaid(texts: string[]): FKResult | null {
  const text = texts.join(" ").trim();
  const stats = readabilityStats(text);
  if (stats.wordCount < 10) return null;
  return {
    gradeLevel: roundTo(stats.fleschKincaidGrade, 1),
    level: gradeToLevel(stats.fleschKincaidGrade),
    wordCount: stats.wordCount,
  };
}
