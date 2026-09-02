import { readabilityStats } from "./readability";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReadingTrendMessage {
  content: string;
  createdAt: number;
}

export interface ReadingTrendBucket {
  startAt: number;
  endAt: number;
  meanGradeLevel: number | null;
  messageCount: number;
  wordCount: number;
}

export interface ReadingTrendResult {
  buckets: ReadingTrendBucket[];
  sampledMessageCount: number;
  availableMessageCount: number;
  wordCount: number;
  windowDays: number;
  bucketDays: number;
  minWordsPerMessage: number;
  latestAt: number | null;
}

export interface ReadingTrendOptions {
  now?: number;
  windowDays?: number;
  bucketDays?: number;
  minWordsPerMessage?: number;
}

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_BUCKET_DAYS = 7;
const DEFAULT_MIN_WORDS_PER_MESSAGE = 3;

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

export function isSyntheticStartMessage(content: string): boolean {
  return content.trim() === "<start>";
}

export function buildScholarReadingTrend(
  messages: ReadingTrendMessage[],
  options: ReadingTrendOptions = {},
): ReadingTrendResult {
  const now = options.now ?? Date.now();
  const windowDays = Math.max(1, Math.trunc(options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const bucketDays = Math.max(1, Math.trunc(options.bucketDays ?? DEFAULT_BUCKET_DAYS));
  const minWordsPerMessage = Math.max(
    1,
    Math.trunc(options.minWordsPerMessage ?? DEFAULT_MIN_WORDS_PER_MESSAGE),
  );
  const windowMs = windowDays * DAY_MS;
  const bucketMs = bucketDays * DAY_MS;
  const windowStart = now - windowMs;
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));

  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const startAt = windowStart + index * bucketMs;
    return {
      startAt,
      endAt: Math.min(now, startAt + bucketMs),
      gradeTotal: 0,
      messageCount: 0,
      wordCount: 0,
    };
  });

  let availableMessageCount = 0;
  let sampledMessageCount = 0;
  let latestAt: number | null = null;

  for (const message of messages) {
    if (message.createdAt < windowStart || message.createdAt > now) continue;
    if (isSyntheticStartMessage(message.content)) continue;

    availableMessageCount += 1;
    const stats = readabilityStats(message.content);
    if (stats.wordCount < minWordsPerMessage) continue;

    const bucketIndex = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((message.createdAt - windowStart) / bucketMs)),
    );
    const bucket = buckets[bucketIndex];
    bucket.gradeTotal += stats.fleschKincaidGrade;
    bucket.messageCount += 1;
    bucket.wordCount += stats.wordCount;
    sampledMessageCount += 1;
    latestAt = Math.max(latestAt ?? message.createdAt, message.createdAt);
  }

  return {
    buckets: buckets.map((bucket) => ({
      startAt: bucket.startAt,
      endAt: bucket.endAt,
      meanGradeLevel:
        bucket.messageCount > 0
          ? roundOneDecimal(bucket.gradeTotal / bucket.messageCount)
          : null,
      messageCount: bucket.messageCount,
      wordCount: bucket.wordCount,
    })),
    sampledMessageCount,
    availableMessageCount,
    wordCount: buckets.reduce((total, bucket) => total + bucket.wordCount, 0),
    windowDays,
    bucketDays,
    minWordsPerMessage,
    latestAt,
  };
}
