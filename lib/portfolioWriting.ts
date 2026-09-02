import { readabilityStats } from "./readability";

// ─── Portfolio writing samples ──────────────────────────────────────────
//
// A scholar's SCANNED work (portfolioItems.extractedText) is their own
// composed writing — arguably a better sample of "writing level" than short,
// informal tutor-chat messages. This module decides which scanned pieces are
// genuine PROSE (a story, a paragraph answer) versus a math worksheet whose
// extracted text is mostly digits/symbols, and scores the prose with the same
// Flesch–Kincaid reading formula the chat trend uses.
//
// Two hard truths shape the thresholds (kept here, not scattered):
//   1. OCR normalizes spelling — so this is a vocabulary/sentence-structure
//      signal only; a spelling-aware read would need the source image.
//   2. Genre matters — "3/4 + 1/2 = 5/4" is not writing; the alpha-share gate
//      keeps digit-dominated worksheets out.

const DAY_MS = 24 * 60 * 60 * 1000;

// Prose floor. Calibrated as heuristics against real scan shape (revisit with
// a labeled sample — see review/portfolio-writing-level-plan.html § Caveats):
//   - A composed piece is ≥ 20 real (letter-bearing) words. Below that FK is
//     noise and a scrap/label isn't "writing".
//   - Its letters must outweigh its digits ≥ 60/40, which excludes a math
//     worksheet ("12 × 3 = 36") while admitting a word problem or a story.
export const PORTFOLIO_MIN_PROSE_WORDS = 20;
export const PORTFOLIO_MIN_ALPHA_SHARE = 0.6;

const SNIPPET_MAX_CHARS = 140;

export interface PortfolioProseCandidate {
  /** Stable id of the source item (a Convex id, stringly-typed here). */
  id: string;
  /** The extracted/transcribed text of the scan. */
  text: string;
  /** AI caption of the piece, if any. */
  caption?: string | null;
  /** When the scan was ingested (ms epoch); used as the sample's timestamp. */
  createdAt: number;
}

export interface PortfolioWritingSample {
  id: string;
  /** The full transcribed text — stripped before the trend query returns it. */
  text: string;
  caption: string | null;
  snippet: string;
  gradeLevel: number;
  wordCount: number;
  createdAt: number;
}

export interface PortfolioProseStats {
  isProse: boolean;
  wordCount: number;
  alphaShare: number;
  fleschKincaidGrade: number;
}

export interface PortfolioWritingOptions {
  now?: number;
  windowDays?: number;
  limit?: number;
}

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_LIMIT = 8;

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function alphaShareOf(text: string): number {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const digits = (text.match(/[0-9]/g) ?? []).length;
  const denom = letters + digits;
  return denom === 0 ? 0 : letters / denom;
}

function makeSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…`;
}

/**
 * Classify a scan's extracted text: is it composed PROSE worth scoring, and
 * (if so) at what Flesch–Kincaid grade?
 */
export function portfolioProseStats(text: string): PortfolioProseStats {
  const stats = readabilityStats(text);
  const alphaShare = alphaShareOf(text);
  const isProse =
    stats.wordCount >= PORTFOLIO_MIN_PROSE_WORDS &&
    alphaShare >= PORTFOLIO_MIN_ALPHA_SHARE;
  return {
    isProse,
    wordCount: stats.wordCount,
    alphaShare,
    fleschKincaidGrade: stats.fleschKincaidGrade,
  };
}

/**
 * Filter candidates to in-window prose, score each, and return the most recent
 * `limit` samples (newest first). The `text` field is retained so the AI
 * estimate can read it; the teacher-facing trend query strips it.
 */
export function buildPortfolioWritingSamples(
  candidates: PortfolioProseCandidate[],
  options: PortfolioWritingOptions = {},
): PortfolioWritingSample[] {
  const now = options.now ?? Date.now();
  const windowDays = Math.max(1, Math.trunc(options.windowDays ?? DEFAULT_WINDOW_DAYS));
  const limit = Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT));
  const windowStart = now - windowDays * DAY_MS;

  const samples: PortfolioWritingSample[] = [];
  for (const candidate of candidates) {
    if (candidate.createdAt < windowStart || candidate.createdAt > now) continue;
    const text = candidate.text?.trim() ?? "";
    if (!text) continue;
    const stats = portfolioProseStats(text);
    if (!stats.isProse) continue;
    samples.push({
      id: candidate.id,
      text,
      caption: candidate.caption?.trim() || null,
      snippet: makeSnippet(text),
      gradeLevel: roundOneDecimal(stats.fleschKincaidGrade),
      wordCount: stats.wordCount,
      createdAt: candidate.createdAt,
    });
  }

  return samples.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
