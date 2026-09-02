/**
 * The GAME CATALOG — every game the platform knows about, and the server-owned
 * plan for interpreting the evidence each one emits.
 *
 * WHY THIS IS CODE AND NOT A CONVEX TABLE. The whole premise of the games
 * platform is that a game is code, not data: a spec generates variation *within*
 * a mechanic and can never produce a *new* mechanic. That argument applies one
 * level up too. A fleet iPad can only run the games its BINARY contains, so a
 * database row describing a game that isn't in the build is not configuration —
 * it is drift waiting to be discovered by a scholar. Keeping the catalog beside
 * the modules means the CI conformance test can prove the two agree, and a
 * vendored copy means the native host and the server read the SAME declaration.
 *
 * THE EVIDENCE PLAN IS SERVER-OWNED. A game emits `eventKey`s; this file decides
 * what each one MEANS. That separation is the anti-injection boundary: a game
 * cannot label its own evidence for the tutor, cannot invent a role, and cannot
 * get raw game state into a model prompt. The server rejects any eventKey with
 * no plan entry, then builds a deterministic digest (`lib/games/digest.ts`) and
 * only the digest travels onward.
 *
 * NOTE WHAT AN `EvidencePlanEntry` CANNOT HOLD: no score, no weight, no
 * threshold, no credit formula, no unlock, no streak effect, no mastery target.
 * That is not an oversight and not a convention — the type has three fields and
 * `evidencePlanEntryError()` rejects a fourth. A game's outcome never touches
 * mastery. Skill credit comes from ordinary practice, full stop. A game is
 * deliberately adjacent to the skills it touches (a practice beat is bound to
 * skillKeys, and the scheduler keeps serving fresh, cold, unassisted items on
 * those same skills), so the practice engine is already the transfer
 * instrument — green is minted only by later bare reps. There is no separate
 * "transfer item" mechanism, and none is planned: building one would duplicate
 * the scheduler.
 */

import {
  type GamePlatform,
  HOST_EVENT_KEYS,
  MAX_EVENT_KEY_LEN,
  isHostEventKey,
} from "./contract";

/**
 * How the digest should PRESENT one kind of event to a human (or, later, to a
 * deterministic prompt builder). Not a weight and not a grade — a filing label.
 *
 * `ignore` is first-class and expected: a game emits plenty of book-keeping that
 * matters for resume and nothing else. Ignoring it in the digest is cheaper and
 * more honest than not recording it.
 */
export type TutorRole =
  /** Scene-setting. What was going on. */
  | "context"
  /** The scholar committed before knowing. */
  | "prediction"
  /** What actually happened, against that commitment. */
  | "contrast"
  /** The moment the scholar's model changed. */
  | "turning-point"
  /** The game's guess at an approach. Always shown as an inference. */
  | "strategy"
  /** Recorded, never surfaced. */
  | "ignore";

export interface EvidencePlanEntry {
  /** Human phrasing for this event in a digest. Written for a teacher to read. */
  label: string;
  /** How the digest files it. */
  tutorRole: TutorRole;
  /** Optional concept tag. A LABEL for a human, never a mastery target (D-3). */
  concept?: string;
}

export type EvidencePlan = Readonly<Record<string, EvidencePlanEntry>>;

/** Fields that must never appear on a plan entry. Enforced at runtime + in CI. */
const FORBIDDEN_PLAN_FIELDS = [
  "score",
  "points",
  "weight",
  "threshold",
  "credit",
  "mastery",
  "masteryTarget",
  "unlock",
  "unlocks",
  "streak",
  "xp",
  "grade",
  "correct",
] as const;

const ALLOWED_PLAN_FIELDS = new Set(["label", "tutorRole", "concept"]);

const TUTOR_ROLES: readonly TutorRole[] = [
  "context",
  "prediction",
  "contrast",
  "turning-point",
  "strategy",
  "ignore",
];

/** Returns null when the entry is well-formed, else a human-readable reason. */
export function evidencePlanEntryError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "plan entry must be an object";
  const entry = value as Record<string, unknown>;
  if (typeof entry.label !== "string" || entry.label.length === 0) {
    return "plan entry must have a non-empty label";
  }
  if (typeof entry.tutorRole !== "string" || !TUTOR_ROLES.includes(entry.tutorRole as TutorRole)) {
    return `plan entry has unknown tutorRole "${String(entry.tutorRole)}"`;
  }
  if (entry.concept !== undefined && typeof entry.concept !== "string") {
    return "plan entry concept must be a string";
  }
  for (const key of Object.keys(entry)) {
    if (ALLOWED_PLAN_FIELDS.has(key)) continue;
    const forbidden = (FORBIDDEN_PLAN_FIELDS as readonly string[]).includes(key);
    return forbidden
      ? `plan entry carries forbidden scoring field "${key}" — a game's outcome never touches mastery`
      : `plan entry carries unknown field "${key}"`;
  }
  return null;
}

/**
 * The plan for the events the HOST emits on every game's behalf. Merged into
 * each game's effective plan, so a game neither declares nor can suppress them.
 */
export const HOST_EVIDENCE_PLAN: EvidencePlan = {
  [HOST_EVENT_KEYS.help]: {
    label: "Asked for help",
    tutorRole: "context",
  },
};

export interface GameCatalogEntry {
  gameId: string;
  /** Shown to scholars and teachers. Also the subject of the web capability notice. */
  title: string;
  /** One line, teacher-facing: what a scholar actually does. */
  blurb: string;
  /**
   * Where it can be played. Read by the web capability notice AND by the
   * teacher's authoring/assignment UI — one declaration, two readers, so the
   * requirement is visible at assign time rather than at discovery time (D-5).
   */
  platform: GamePlatform;
  /** Must equal the module's `manifest.version` (asserted in CI). */
  version: number;
  /** Used when an activity does not author one. Must satisfy the module's config codec. */
  defaultConfig: unknown;
  /** eventKey → meaning. Must cover every key in the module's `manifest.eventKeys`. */
  evidencePlan: EvidencePlan;
}

/**
 * Every game id, as a closed tuple. Adding a game means adding an id here, a
 * catalog entry below, and a registry entry in
 * `native/src/games/registry.ts` — the conformance test fails on any two of the
 * three disagreeing.
 */
export const GAME_IDS = ["toy-warmer-colder", "factor-game", "studio"] as const;

export type GameId = (typeof GAME_IDS)[number];

export function isGameId(value: string): value is GameId {
  return (GAME_IDS as readonly string[]).includes(value);
}

/**
 * `toy-warmer-colder` is a DELIBERATELY TRIVIAL, DISPOSABLE proof of the
 * contract. It exists to exercise every seam — seeded state, phases, per-move
 * checkpointing, each evidence kind, digest pairing — and for no other reason.
 * It is not a good game and is not meant to become one.
 *
 * The flow: guess which half hides the token → tap a tile → warmer/colder →
 * optionally revise the guess → tap again → done.
 */
const TOY_WARMER_COLDER: GameCatalogEntry = {
  gameId: "toy-warmer-colder",
  title: "Warmer or Colder (toy)",
  blurb:
    "Guess which half of a strip hides a token, take one probe, read the warmer/colder signal, then commit to a second probe.",
  platform: "ipad",
  version: 1,
  defaultConfig: { tiles: 8 },
  evidencePlan: {
    phase: { label: "Moved to a new part of the game", tutorRole: "ignore" },
    guess_half: {
      label: "Guessed which half hides the token",
      tutorRole: "prediction",
      concept: "narrowing a search space",
    },
    first_tap: { label: "Took the first probe", tutorRole: "context" },
    feedback_shown: {
      label: "Saw the warmer/colder signal",
      tutorRole: "contrast",
      concept: "reading feedback",
    },
    half_revised: {
      label: "Changed their mind about which half",
      tutorRole: "turning-point",
      concept: "revising a guess from evidence",
    },
    probe_read: {
      label: "How the probe was chosen",
      tutorRole: "strategy",
      concept: "search strategy",
    },
    second_tap: { label: "Took the second probe", tutorRole: "context" },
    round_ended: { label: "Finished the round", tutorRole: "ignore" },
  },
};

/**
 * The Factor Game — a Math-Circle classic, and the platform's first REAL game.
 *
 * It arrived here from `ManipulativeKind`, where its own source comment called
 * it "Model B: a game (internal stages + carried state)" sitting beside two
 * incompatible grading models. The move is not primarily about the switch-case
 * tax: as a manipulative this was GRADED — `factorGameSolved` returned true iff
 * the scholar out-scored the AI, and that boolean fed skill mastery. Beating a
 * greedy heuristic is not evidence of understanding factors. Here the same
 * round produces evidence a teacher reads and no credit at all.
 *
 * Read the evidence plan as the argument for what a factor round is worth
 * watching FOR: which number they took, what it cost them, and whether they can
 * say why. Not the score.
 */
const FACTOR_GAME: GameCatalogEntry = {
  gameId: "factor-game",
  title: "The Factor Game",
  blurb:
    "Claim a number and your opponent takes all its leftover factors. Primes are cheap to give away; highly-composite numbers are expensive. Highest total wins the round.",
  platform: "ipad",
  version: 1,
  defaultConfig: { boardSize: 30, firstTurn: "scholar" },
  evidencePlan: {
    phase: { label: "Moved to a new part of the game", tutorRole: "ignore" },
    scholar_pick: {
      label: "Claimed a number",
      tutorRole: "prediction",
      concept: "weighing a number against its factors",
    },
    giveaway_seen: {
      label: "Saw what that number handed over",
      tutorRole: "contrast",
      concept: "proper factors",
    },
    opponent_pick: { label: "The opponent claimed a number", tutorRole: "context" },
    opponent_giveaway: {
      label: "What the opponent's pick handed back",
      tutorRole: "contrast",
      concept: "proper factors",
    },
    pick_rationale: {
      label: "Why that number was worth taking",
      tutorRole: "strategy",
      concept: "prime vs. composite structure",
    },
    no_moves_left: {
      label: "Noticed the board had run out of legal moves",
      tutorRole: "turning-point",
      concept: "numbers with no unclaimed factors",
    },
    round_ended: { label: "Finished the round", tutorRole: "ignore" },
  },
};

const STUDIO: GameCatalogEntry = {
  gameId: "studio",
  title: "Studio",
  blurb:
    "Write tiny JavaScript programs, run them against a robot world, and revise the code from what the world shows.",
  platform: "ipad",
  version: 1,
  defaultConfig: { levelIds: [] },
  evidencePlan: {
    run_result: {
      label: "Ran a Studio level",
      tutorRole: "contrast",
      concept: "debugging a program against a changing world",
    },
  },
};

export const GAME_CATALOG: Readonly<Record<GameId, GameCatalogEntry>> = {
  "toy-warmer-colder": TOY_WARMER_COLDER,
  "factor-game": FACTOR_GAME,
  studio: STUDIO,
};

export function getGame(gameId: string): GameCatalogEntry | null {
  return isGameId(gameId) ? GAME_CATALOG[gameId] : null;
}

/**
 * The plan the SERVER validates and digests against: the game's own plan plus
 * the host's reserved keys. Always use this rather than `entry.evidencePlan` —
 * the host keys are not in the latter by design.
 */
export function effectiveEvidencePlan(gameId: string): EvidencePlan | null {
  const entry = getGame(gameId);
  if (!entry) return null;
  return { ...HOST_EVIDENCE_PLAN, ...entry.evidencePlan };
}

/**
 * Structural check of one catalog entry, shared by the catalog test and the
 * native conformance test. Returns the list of problems (empty when clean).
 */
export function catalogEntryErrors(entry: GameCatalogEntry): string[] {
  const errors: string[] = [];
  if (!entry.gameId) errors.push("missing gameId");
  if (!entry.title) errors.push(`${entry.gameId}: missing title`);
  if (!entry.blurb) errors.push(`${entry.gameId}: missing blurb`);
  if (entry.platform !== "ipad") errors.push(`${entry.gameId}: platform must be "ipad"`);
  if (!Number.isInteger(entry.version) || entry.version < 1) {
    errors.push(`${entry.gameId}: version must be a positive integer`);
  }
  for (const [eventKey, planEntry] of Object.entries(entry.evidencePlan)) {
    if (eventKey.length === 0 || eventKey.length > MAX_EVENT_KEY_LEN) {
      errors.push(`${entry.gameId}: eventKey "${eventKey}" has an invalid length`);
    }
    if (isHostEventKey(eventKey)) {
      errors.push(
        `${entry.gameId}: eventKey "${eventKey}" uses the reserved host. prefix — the host owns those`,
      );
    }
    const entryError = evidencePlanEntryError(planEntry);
    if (entryError) errors.push(`${entry.gameId}.${eventKey}: ${entryError}`);
  }
  return errors;
}
