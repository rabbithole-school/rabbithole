import { tokenizeWords } from "./readability";
import { isSyntheticStartMessage, type ReadingTrendMessage } from "./readingTrend";

export interface VocabularyWin {
  word: string;
  firstSeenAt: number;
  snippet: string;
  useCount: number;
}

export interface VocabularyOptions {
  limit?: number;
  minLength?: number;
  now?: number;
  windowDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_LENGTH = 8;
const DEFAULT_WINDOW_DAYS = 90;

const COMMON_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "almost",
  "already",
  "always",
  "another",
  "around",
  "because",
  "before",
  "between",
  "connects",
  "different",
  "doesnt",
  "during",
  "every",
  "everyone",
  "everything",
  "favorite",
  "getting",
  "happened",
  "having",
  "inside",
  "instead",
  "little",
  "message",
  "nothing",
  "outside",
  "people",
  "playground",
  "probably",
  "really",
  "remember",
  "school",
  "should",
  "someone",
  "something",
  "started",
  "teacher",
  "through",
  "together",
  "without",
  "would",
]);

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[’']/g, "").replace(/[^a-z]/g, "");
}

function isSophisticatedWord(word: string, minLength: number): boolean {
  return word.length >= minLength && !COMMON_WORDS.has(word);
}

function snippetAround(content: string, word: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(word.toLowerCase());
  if (index < 0) return normalized.slice(0, 96);

  const start = Math.max(0, index - 36);
  const end = Math.min(normalized.length, index + word.length + 36);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

export function vocabularyWins(
  messages: ReadingTrendMessage[],
  options: VocabularyOptions = {},
): VocabularyWin[] {
  const now = options.now ?? Date.now();
  const windowDays = Math.max(1, Math.trunc(options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const windowStart = now - windowDays * DAY_MS;
  const minLength = Math.max(1, Math.trunc(options.minLength ?? DEFAULT_MIN_LENGTH));
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));
  const seen = new Map<string, VocabularyWin>();

  const chronological = messages
    .filter((message) =>
      message.createdAt >= windowStart &&
      message.createdAt <= now &&
      !isSyntheticStartMessage(message.content)
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const message of chronological) {
    const uniqueWordsInMessage = new Set<string>();
    for (const token of tokenizeWords(message.content)) {
      const word = normalizeWord(token);
      if (!isSophisticatedWord(word, minLength)) continue;
      uniqueWordsInMessage.add(word);
    }

    for (const word of uniqueWordsInMessage) {
      const existing = seen.get(word);
      if (existing) {
        existing.useCount += 1;
        continue;
      }

      seen.set(word, {
        word,
        firstSeenAt: message.createdAt,
        snippet: snippetAround(message.content, word),
        useCount: 1,
      });
    }
  }

  return [...seen.values()]
    .sort((a, b) => {
      const recency = b.firstSeenAt - a.firstSeenAt;
      if (recency !== 0) return recency;
      const length = b.word.length - a.word.length;
      if (length !== 0) return length;
      return a.word.localeCompare(b.word);
    })
    .slice(0, limit);
}
