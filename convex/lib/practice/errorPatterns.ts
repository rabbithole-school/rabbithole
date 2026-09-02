// Canonical list of the six documented buggy-arithmetic patterns (Ashlock
// error-pattern taxonomy). The single source of truth for the literal set —
// the `ErrorPattern` union is derived from it, and downstream validators /
// exhaustive maps (e.g. describeMisconception in curriculumSimShared) key off
// the same list so a new pattern can't silently drift out of sync.
export const ERROR_PATTERNS = [
  "SMALLER_FROM_LARGER",
  "DROPPED_CARRY",
  "PLACE_MISALIGNMENT",
  "OFF_BY_ONE_SKIP",
  "REMAINDER_IGNORED",
  "REVERSED_OPERANDS",
] as const;

export type ErrorPattern = (typeof ERROR_PATTERNS)[number];

type Operation = "add" | "subtract" | "multiply" | "divide";

type ParsedStem = {
  leftRaw: string;
  rightRaw: string;
  left: number;
  right: number;
  operation: Operation;
};

type ClassifyInput = {
  skillKey: string;
  stem: string;
  learnerAnswer: string;
  correctAnswer: string;
};

const EPSILON = 1e-9;

// Multi-match priority: operand reversal and remainder-dropping are explicit
// operation confusions, then place-value layout bugs, then column bugs, then the
// skill-key-only skip/counting slip.
const DETECTION_PRIORITY = [
  "REVERSED_OPERANDS",
  "REMAINDER_IGNORED",
  "PLACE_MISALIGNMENT",
  "SMALLER_FROM_LARGER",
  "DROPPED_CARRY",
  "OFF_BY_ONE_SKIP",
] as const satisfies readonly ErrorPattern[];

export function classifyError(input: ClassifyInput): ErrorPattern | null {
  if (answersEqual(input.learnerAnswer, input.correctAnswer)) {
    return null;
  }

  const parsed = parseStem(input.stem);
  const detectors: Record<ErrorPattern, () => boolean> = {
    REVERSED_OPERANDS: () => detectsReversedOperands(parsed, input.learnerAnswer),
    REMAINDER_IGNORED: () => detectsRemainderIgnored(parsed, input.learnerAnswer),
    PLACE_MISALIGNMENT: () => detectsPlaceMisalignment(parsed, input.learnerAnswer),
    SMALLER_FROM_LARGER: () => detectsSmallerFromLarger(parsed, input.learnerAnswer),
    DROPPED_CARRY: () => detectsDroppedCarry(parsed, input.learnerAnswer),
    OFF_BY_ONE_SKIP: () => detectsOffByOneSkip(input),
  };

  for (const pattern of DETECTION_PRIORITY) {
    if (detectors[pattern]()) return pattern;
  }
  return null;
}

function parseStem(stem: string): ParsedStem | null {
  const normalized = stem.replace(/[−–—]/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
  const number = String.raw`[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`;
  const match = normalized.match(new RegExp(String.raw`(${number})\s*([+\-*/])\s*(${number})`));
  if (!match) return null;

  const [, leftRaw, operator, rightRaw] = match;
  if (!leftRaw || !operator || !rightRaw) return null;

  const left = parseScalarNumber(leftRaw);
  const right = parseScalarNumber(rightRaw);
  if (left === null || right === null) return null;

  const operation = operationFromSymbol(operator);
  if (!operation) return null;

  return { leftRaw, rightRaw, left, right, operation };
}

function operationFromSymbol(operator: string): Operation | null {
  switch (operator) {
    case "+":
      return "add";
    case "-":
      return "subtract";
    case "*":
      return "multiply";
    case "/":
      return "divide";
    default:
      return null;
  }
}

function detectsSmallerFromLarger(parsed: ParsedStem | null, learnerAnswer: string): boolean {
  if (!parsed || parsed.operation !== "subtract") return false;
  const leftDigits = unsignedIntegerDigits(parsed.leftRaw);
  const rightDigits = unsignedIntegerDigits(parsed.rightRaw);
  if (!leftDigits || !rightDigits) return false;

  const width = Math.max(leftDigits.length, rightDigits.length);
  const top = leftDigits.padStart(width, "0");
  const bottom = rightDigits.padStart(width, "0");
  let sawBorrowColumn = false;
  let buggyDigits = "";

  for (let i = 0; i < width; i++) {
    const topDigit = digitAt(top, i);
    const bottomDigit = digitAt(bottom, i);
    if (topDigit < bottomDigit) sawBorrowColumn = true;
    buggyDigits += String(Math.abs(topDigit - bottomDigit));
  }

  return sawBorrowColumn && answerEqualsNumber(learnerAnswer, Number(canonicalInteger(buggyDigits)));
}

function detectsDroppedCarry(parsed: ParsedStem | null, learnerAnswer: string): boolean {
  if (!parsed || parsed.operation !== "add") return false;
  const leftDigits = unsignedIntegerDigits(parsed.leftRaw);
  const rightDigits = unsignedIntegerDigits(parsed.rightRaw);
  if (!leftDigits || !rightDigits) return false;

  const width = Math.max(leftDigits.length, rightDigits.length);
  const left = leftDigits.padStart(width, "0");
  const right = rightDigits.padStart(width, "0");
  let sawCarry = false;
  let buggyDigits = "";

  for (let i = 0; i < width; i++) {
    const columnSum = digitAt(left, i) + digitAt(right, i);
    if (columnSum >= 10) sawCarry = true;
    buggyDigits += String(columnSum % 10);
  }

  return sawCarry && answerEqualsNumber(learnerAnswer, Number(canonicalInteger(buggyDigits)));
}

function detectsPlaceMisalignment(parsed: ParsedStem | null, learnerAnswer: string): boolean {
  if (!parsed || (parsed.operation !== "add" && parsed.operation !== "subtract")) return false;
  const leftDigits = unsignedIntegerDigits(parsed.leftRaw);
  const rightDigits = unsignedIntegerDigits(parsed.rightRaw);
  if (!leftDigits || !rightDigits || leftDigits.length === rightDigits.length) return false;

  const width = Math.max(leftDigits.length, rightDigits.length);
  const leftAligned = Number(leftDigits.padEnd(width, "0"));
  const rightAligned = Number(rightDigits.padEnd(width, "0"));
  const buggyAnswer =
    parsed.operation === "add" ? leftAligned + rightAligned : leftAligned - rightAligned;

  return answerEqualsNumber(learnerAnswer, buggyAnswer);
}

function detectsRemainderIgnored(parsed: ParsedStem | null, learnerAnswer: string): boolean {
  if (!parsed || parsed.operation !== "divide") return false;
  if (!Number.isInteger(parsed.left) || !Number.isInteger(parsed.right)) return false;
  if (parsed.left < 0 || parsed.right <= 0) return false;
  if (parsed.left % parsed.right === 0) return false;

  return answerEqualsNumber(learnerAnswer, Math.floor(parsed.left / parsed.right));
}

function detectsReversedOperands(parsed: ParsedStem | null, learnerAnswer: string): boolean {
  if (!parsed) return false;
  if (parsed.operation === "subtract") {
    return answerEqualsNumber(learnerAnswer, parsed.right - parsed.left);
  }
  if (parsed.operation === "divide" && parsed.left !== 0) {
    return answerEqualsNumber(learnerAnswer, parsed.right / parsed.left);
  }
  return false;
}

function detectsOffByOneSkip(input: ClassifyInput): boolean {
  const steps = skipSteps(input.skillKey, input.stem);
  if (steps.length === 0) return false;

  const learner = parseScalarNumber(input.learnerAnswer);
  const correct = parseScalarNumber(input.correctAnswer);
  if (learner === null || correct === null) return false;

  return steps.some((step) => numbersEqual(Math.abs(learner - correct), step));
}

function skipSteps(skillKey: string, stem: string): number[] {
  const normalizedKey = skillKey.toLowerCase().replace(/[_-]+/g, " ");
  if (!/\b(skip|skipcount|count|counting)\b/.test(normalizedKey)) return [];

  const source = `${normalizedKey} ${stem}`;
  const steps = new Set<number>();
  const patterns = [
    /\b(?:skip|count|counting)\s+by\s+(\d+)\b/gi,
    /\b(?:by|step)\s+(\d+)\b/gi,
    /\b(\d+)s\b/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const step = Number(match[1]);
      if (Number.isInteger(step) && step > 0) steps.add(step);
    }
  }

  steps.add(1);
  return [...steps];
}

function answersEqual(a: string, b: string): boolean {
  const aNumber = parseScalarNumber(a);
  const bNumber = parseScalarNumber(b);
  if (aNumber !== null && bNumber !== null) {
    return numbersEqual(aNumber, bNumber);
  }
  return normalizeTextAnswer(a) === normalizeTextAnswer(b);
}

function answerEqualsNumber(answer: string, expected: number): boolean {
  const answerNumber = parseScalarNumber(answer);
  return answerNumber !== null && numbersEqual(answerNumber, expected);
}

function parseScalarNumber(input: string): number | null {
  const normalized = input.trim().replace(/,/g, "");
  if (!/^[+-]?(?:(?:\d+)(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function unsignedIntegerDigits(input: string): string | null {
  const normalized = input.trim().replace(/,/g, "");
  return /^\d+$/.test(normalized) ? normalized : null;
}

function canonicalInteger(digits: string): string {
  return digits.replace(/^0+(?=\d)/, "");
}

function digitAt(digits: string, index: number): number {
  return digits.charCodeAt(index) - "0".charCodeAt(0);
}

function normalizeTextAnswer(answer: string): string {
  return answer.trim().replace(/\s+/g, " ").toLowerCase();
}

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON;
}
