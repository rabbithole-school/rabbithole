/**
 * Pure helpers for the voice-first pipeline: stripping markdown for speech
 * and incrementally segmenting streamed tutor text into speakable sentences.
 * No React, no network — covered by plain Vitest tests
 * (lib/__tests__/sentenceStream.test.ts).
 */

/** Drop markdown syntax so TTS reads prose, not punctuation soup. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/#{1,6}\s/g, "") // headers
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold
    .replace(/\*(.*?)\*/g, "$1") // italic
    .replace(/```[a-z]*\n[\s\S]*?```/g, "") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code → keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label
    .replace(/^[-*+]\s/gm, "") // list bullets
    .replace(/^\d+\.\s/gm, "") // numbered lists
    .replace(/\n{2,}/g, "\n") // collapse blank lines
    .replace(/\n/g, ". ") // newlines → sentence pause
    .replace(/\.\.\s/g, ". ") // collapse double periods
    .trim();
}

/**
 * Below this many characters a "sentence" is treated as a fragment and held
 * until more text arrives — avoids cutting at "1. " or "Dr. " while still
 * letting short real sentences ("Aloha Kai!") through.
 */
const MIN_SENTENCE_CHARS = 8;

// A sentence boundary: terminal punctuation (plus optional closing quotes /
// brackets) followed by whitespace, or a newline run. End-of-input is NOT a
// boundary — the stream may continue; flush() handles the tail.
const BOUNDARY = /(?:[.!?…]["”'’)\]]*\s+|\n+)/g;

/**
 * Incremental sentence segmenter for streamed text. Feed deltas with
 * push(); it returns sentences as they complete. Call flush() at
 * end-of-stream for the remainder.
 */
export class SentenceAccumulator {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let lastCut = 0;
    BOUNDARY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(this.buf))) {
      const end = m.index + m[0].length;
      const candidate = this.buf.slice(lastCut, end).trim();
      if (candidate.length >= MIN_SENTENCE_CHARS) {
        out.push(candidate);
        lastCut = end;
      }
      // Too short: leave lastCut alone so the fragment rides along with the
      // next sentence ("1. Mix the flour." comes out whole).
    }
    this.buf = this.buf.slice(lastCut);
    return out;
  }

  /** End of stream: whatever remains is the final utterance. */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest.length > 0 ? rest : null;
  }
}
