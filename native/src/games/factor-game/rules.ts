/**
 * `factor-game` — the rules. Framework-free, and the only place they live.
 *
 * The Factor Game is a Math-Circle classic. The board is 1..boardSize. On your
 * turn you claim an unclaimed number that still has at least one unclaimed
 * proper factor; your opponent immediately claims every one of those remaining
 * factors. When no legal pick is left, unclaimed numbers score for nobody and
 * the higher total wins. Primes are cheap to give away and expensive to take;
 * highly-composite numbers are the reverse. That tension IS the mathematics.
 *
 * ## Why this is a game module and no longer a `ManipulativeKind`
 *
 * These rules used to live in `lib/manipulative/logic.ts`, where a comment
 * labelled them "Model B: a game (internal stages + carried state)" beside two
 * other, incompatible grading models. Each of them paid a case in four parallel
 * switch statements. The decisive part, though, is not the tax — it is that the
 * manipulative layer GRADED this: `factorGameSolved` returned true iff the
 * scholar's total beat the AI's, and that boolean fed skill mastery. Whether a
 * child beat a greedy heuristic is not evidence that they understand factors,
 * and D-3 forbids a game's outcome touching mastery at all. Moving the rules
 * here is what makes that structural — nothing in this file can reach a mastery
 * writer, because nothing in the games platform can.
 *
 * ## What is deliberately NOT here
 *
 * No verifier, and no server-side copy. The server publishes no conclusion
 * about this game — a round is an ungraded experience whose output is evidence
 * for a teacher — so there is nothing for it to reconstruct. (The rule that
 * does bind: the server must be able to reconstruct any conclusion it
 * publishes. A game that claimed a budget total would need its price table
 * server-side. This one claims nothing.)
 *
 * Must stay importable in plain Node: the CI conformance test requires it
 * through `module.ts`. No react, no react-native, no reanimated.
 */

export type FactorPlayer = "scholar" | "opponent";

export interface FactorMove {
  picker: FactorPlayer;
  /** The number picked. */
  number: number;
  /** Its remaining unclaimed proper factors, auto-claimed by the OTHER player. */
  factorsGivenToOpponent: number[];
}

export interface FactorConfig {
  /** The board is 1..boardSize. */
  boardSize: number;
  /** Who picks first. */
  firstTurn: FactorPlayer;
}

export interface FactorState {
  /** 1..boardSize → who claimed it, or absent if still unclaimed. */
  claimedBy: Record<number, FactorPlayer | undefined>;
  /** Whose turn it is to pick next. */
  turn: FactorPlayer;
  /** Every move played so far, in order — doubles as the progress log. */
  moveLog: FactorMove[];
}

export const MIN_BOARD_SIZE = 12;
export const MAX_BOARD_SIZE = 100;

/** Proper factors of n (divisors other than n itself), ascending. Excludes n. */
export function properFactors(n: number): number[] {
  if (!Number.isInteger(n) || n < 1) return [];
  const out: number[] = [];
  for (let f = 1; f < n; f++) if (n % f === 0) out.push(f);
  return out;
}

export function initialState(config: FactorConfig): FactorState {
  return { claimedBy: {}, turn: config.firstTurn, moveLog: [] };
}

/** Legal iff unclaimed AND it still has ≥1 unclaimed proper factor. */
export function isLegalMove(config: FactorConfig, s: FactorState, n: number): boolean {
  if (!Number.isInteger(n) || n < 1 || n > config.boardSize) return false;
  if (s.claimedBy[n] != null) return false;
  return properFactors(n).some((f) => s.claimedBy[f] == null);
}

/** Legality never depends on whose turn it is, so one scan answers for both. */
export function hasLegalMove(config: FactorConfig, s: FactorState): boolean {
  for (let n = 1; n <= config.boardSize; n++) if (isLegalMove(config, s, n)) return true;
  return false;
}

/** Every number that could be picked right now — the option space, for evidence. */
export function legalMoves(config: FactorConfig, s: FactorState): number[] {
  const out: number[] = [];
  for (let n = 1; n <= config.boardSize; n++) if (isLegalMove(config, s, n)) out.push(n);
  return out;
}

export function isTerminal(config: FactorConfig, s: FactorState): boolean {
  return !hasLegalMove(config, s);
}

export function scores(s: FactorState): { scholar: number; opponent: number } {
  let scholar = 0;
  let opponent = 0;
  for (const [numStr, who] of Object.entries(s.claimedBy)) {
    if (who === "scholar") scholar += Number(numStr);
    else if (who === "opponent") opponent += Number(numStr);
  }
  return { scholar, opponent };
}

/**
 * Stage 1 of a move: the current picker claims `n` for itself. The fan-out has
 * NOT happened and the turn does NOT yet pass.
 *
 * A move is split in two so a scholar sees the CAUSE before the CONSEQUENCE —
 * the picked cell claims a beat before the factors it hands over paint.
 * `aiTurn.ts` drives the two stages across its `revealing` and `settling`
 * beats; the scholar's own tap applies both at once. Illegal picks return the
 * state unchanged: the reducer guards itself, independent of any UI disabling.
 */
export function applyChoice(config: FactorConfig, s: FactorState, n: number): FactorState {
  if (!isLegalMove(config, s, n)) return s;
  return {
    claimedBy: { ...s.claimedBy, [n]: s.turn },
    turn: s.turn,
    moveLog: s.moveLog,
  };
}

/**
 * Stage 2: the OTHER player claims all of `n`'s still-unclaimed proper factors,
 * the turn passes, and the completed move is logged. Precondition: `applyChoice`
 * has already claimed `n` for `s.turn`.
 */
export function applyFactors(config: FactorConfig, s: FactorState, n: number): FactorState {
  const picker = s.turn;
  const other: FactorPlayer = picker === "scholar" ? "opponent" : "scholar";
  const factorsGivenToOpponent = properFactors(n).filter((f) => s.claimedBy[f] == null);
  const claimedBy = { ...s.claimedBy };
  for (const f of factorsGivenToOpponent) claimedBy[f] = other;
  return {
    claimedBy,
    turn: other,
    moveLog: [...s.moveLog, { picker, number: n, factorsGivenToOpponent }],
  };
}

/** One whole move — both stages, atomically. */
export function applyMove(config: FactorConfig, s: FactorState, n: number): FactorState {
  if (!isLegalMove(config, s, n)) return s;
  return applyFactors(config, applyChoice(config, s, n), n);
}

/** What a pick is worth right now: the number, minus what it hands away. */
export function netValue(s: FactorState, n: number): number {
  const given = properFactors(n).filter((f) => s.claimedBy[f] == null);
  return n - given.reduce((sum, f) => sum + f, 0);
}

/**
 * A beatable heuristic opponent: greedily take the best net value available.
 *
 * Deliberately not optimal. It will not blunder a large number away for
 * nothing, so it is a real opponent, but a scholar who reasons about primes and
 * near-primes (small giveaway, big score) can out-think it — which is the
 * point. A perfect opponent would teach a child only that they lose.
 */
export function chooseOpponentMove(config: FactorConfig, s: FactorState): number | null {
  let best: number | null = null;
  let bestNet = -Infinity;
  for (let n = 1; n <= config.boardSize; n++) {
    if (!isLegalMove(config, s, n)) continue;
    const net = netValue(s, n);
    if (net > bestNet) {
      bestNet = net;
      best = n;
    }
  }
  return best;
}

/**
 * How a finished round turned out.
 *
 * A KEY, not a grade. The catalog's evidence plan files it as book-keeping and
 * the digest quotes it as a claim; nothing reads it into mastery, credit or
 * difficulty. That distinction is the whole reason this game moved off
 * `ManipulativeKind`, where the same fact was the pass/fail of a practice item.
 */
export type FactorOutcome = "scholar_ahead" | "opponent_ahead" | "tied";

export function outcomeOf(s: FactorState): FactorOutcome {
  const { scholar, opponent } = scores(s);
  if (scholar > opponent) return "scholar_ahead";
  if (opponent > scholar) return "opponent_ahead";
  return "tied";
}

/** The giveaway, as a readable list. Pure, so the digest can quote it safely. */
export function describeGiveaway(factors: readonly number[]): string {
  if (factors.length === 0) return "nothing";
  return factors.join(", ");
}

/**
 * The game's GUESS at why a pick was worth taking — an INFERENCE, and labelled
 * as one wherever it surfaces. It reads the board, not the child: it cannot
 * know whether they reasoned it out or tapped the biggest number they saw.
 *
 * Kept here rather than in the renderer so it is unit-testable, and so the one
 * sentence a teacher may end up reading about a move is covered by tests.
 */
export function rationaleFor(config: FactorConfig, s: FactorState, n: number): string {
  const given = properFactors(n).filter((f) => s.claimedBy[f] == null);
  const net = netValue(s, n);
  const bestNet = (() => {
    let best = -Infinity;
    for (let k = 1; k <= config.boardSize; k++) {
      if (isLegalMove(config, s, k)) best = Math.max(best, netValue(s, k));
    }
    return best;
  })();

  if (net < 0) {
    return `took ${n}, which handed over more (${given.reduce((a, b) => a + b, 0)}) than it scored`;
  }
  if (given.length === 1 && given[0] === 1) {
    return `took ${n}, a prime — it only cost 1 to claim`;
  }
  if (net === bestNet) {
    return `took ${n}, the best-value number left on the board`;
  }
  return `took ${n} while a better-value number was available`;
}
