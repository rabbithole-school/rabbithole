/**
 * staticRadicals — conservative, framework-free recognition of the one radical
 * notation practice currently ships in ordinary prose: `√18`, `3√7`, `∛8`,
 * `2∛3`, and bracketed integer-index roots such as `√[4]16`.
 *
 * This is deliberately not an expression parser. It only turns a self-contained
 * integer-index root into the constrained LaTex that the existing static math
 * engines consume; every unsupported shape remains ordinary text.
 */

export type StaticRadicalSegment =
  | { type: "text"; value: string }
  | {
      type: "radical";
      latex: string;
      speech: string;
      /** Sentence punctuation stays Hanken prose, but native keeps it in the
       * same flex item as the preceding math so it cannot wrap by itself. */
      trailingPunctuation?: string;
    };

// The word guards reject identifiers (`x√18`, `√18x`) and decimal-looking
// radicands (`√18.5`). A coefficient is an optional run of integer digits.
const STATIC_RADICAL = /(?<![\w])(\d+)?(√(?:\[([2-9]\d*|1\d+)\])?|∛)(\d+)(?![\w]|\.\d)/g;
const SENTENCE_PUNCTUATION = /^[.!?]/;

function radicalLatex(
  coefficient: string | undefined,
  symbol: string,
  explicitIndex: string | undefined,
  radicand: string,
): string {
  const index = symbol === "∛" ? "3" : explicitIndex;
  return `${coefficient ?? ""}\\sqrt${index ? `[${index}]` : ""}{${radicand}}`;
}

function ordinal(index: string): string {
  const value = Number(index);
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** A root index is a canonical base-10 safe integer no smaller than two.
 * Leading zeroes are deliberately rejected: each index has one visual,
 * spoken, and serialized representation. */
export function parseRootIndex(index: string): number | null {
  if (!/^(?:[2-9]\d*|1\d+)$/.test(index)) return null;
  const value = Number(index);
  return Number.isSafeInteger(value) ? value : null;
}

/** Human-readable root name for static prose and editor accessibility. */
export function rootIndexName(index: string | null | undefined): string | null {
  if (!index || index === "2") return "square";
  if (index === "3") return "cube";
  if (parseRootIndex(index) === null) return null;
  return ordinal(index);
}

function radicalSpeech(
  coefficient: string | undefined,
  symbol: string,
  explicitIndex: string | undefined,
  radicand: string,
): string {
  const index = symbol === "∛" ? "3" : explicitIndex;
  const rootName = rootIndexName(index);
  if (!rootName) return "";
  const root = `the ${rootName} root of ${radicand}`;
  return coefficient ? `${coefficient} times ${root}` : root;
}

/**
 * Split prose into ordinary text and simple, renderable radical fragments.
 * It never throws and returns one text segment when no supported radical exists.
 */
export function scanStaticRadicals(input: string): StaticRadicalSegment[] {
  const out: StaticRadicalSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  STATIC_RADICAL.lastIndex = 0;
  while ((match = STATIC_RADICAL.exec(input))) {
    // The regular expression keeps prose scanning cheap, while this shared
    // contract rejects root indices that cannot be represented safely.
    if (match[3] && parseRootIndex(match[3]) === null) continue;
    if (match.index > last) out.push({ type: "text", value: input.slice(last, match.index) });
    let next = match.index + match[0].length;
    const punctuation = input.slice(next).match(SENTENCE_PUNCTUATION)?.[0];
    if (punctuation) next += punctuation.length;
    out.push({
      type: "radical",
      latex: radicalLatex(match[1], match[2], match[3], match[4]),
      speech: radicalSpeech(match[1], match[2], match[3], match[4]),
      ...(punctuation ? { trailingPunctuation: punctuation } : null),
    });
    last = next;
    STATIC_RADICAL.lastIndex = next;
  }
  if (last < input.length) out.push({ type: "text", value: input.slice(last) });
  return out.length ? out : [{ type: "text", value: input }];
}

/** True only when ordinary practice prose contains a supported static radical. */
export function hasStaticRadical(input: string): boolean {
  return scanStaticRadicals(input).some((segment) => segment.type === "radical");
}

/** Screen-reader-friendly speech for the supported static radical fragments. */
export function staticRadicalsToSpeech(input: string): string {
  return scanStaticRadicals(input)
    .map((segment) =>
      segment.type === "text"
        ? segment.value
        : `${segment.speech}${segment.trailingPunctuation ?? ""}`,
    )
    .join("");
}
