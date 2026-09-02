/**
 * The FROZEN contract for a GAME — the sibling primitive to manipulatives.
 *
 * Games are NOT a `ManipulativeKind`. `lib/manipulative/` stays closed and gains
 * no case for any of this; the two systems sit beside each other and games
 * borrow the manipulative system's best parts (`kit.tsx` game-feel, `aiTurn.ts`
 * choreography, the generated-art theme layer, and the server-is-authoritative
 * rule from `lib/manipulative/practiceContract.ts`).
 *
 * Shared by four surfaces (this file is the source of truth; the others code
 * against it):
 *   • the native host        — native/src/components/games/GameHost.tsx
 *   • a game module          — native/src/games/<gameId>/
 *   • the server             — convex/games.ts
 *   • the web review surface — components/ActivitySessionsCard.tsx
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1 · EVIDENCE, NEVER CONCLUSIONS. A game may assert what the scholar DID —
 *     phases, choices, predictions, observations, revisions, typed explanations,
 *     its own outcome key. It may never assert correctness, mastery, streak
 *     impact, unlocks or a grade. Note what is deliberately ABSENT from
 *     `GameHostApi` below: no `awardMastery`, no `recordCorrect`, no
 *     `incrementStreak`. A game cannot reach the network at all — it asks the
 *     host, and the host's whole vocabulary is right here.
 *
 * 2 · THE SERVER RE-DERIVES. The games shape of the `practiceContract.ts` rule:
 *     anything a game computes about its own session is OPTIMISTIC UI only. The
 *     authoritative record is the server re-deriving a `GameSessionDigest` from
 *     the append-only event log (`lib/games/digest.ts`), never a client-supplied
 *     summary. `outcomeKey` is stored as a *claim*, and a claim is not a grade —
 *     skill credit comes from ordinary practice, full stop. A game is
 *     deliberately adjacent to the skills it touches (a practice beat is bound
 *     to skillKeys, and the scheduler keeps serving fresh, cold, unassisted
 *     items on those same skills), so the practice engine is already the
 *     transfer instrument — green is minted only by later bare reps. There is
 *     no separate "transfer item" mechanism, and none is planned: building one
 *     would duplicate the scheduler.
 *
 *     Game evidence DOES enter the learning record — but the entry is LAYERED.
 *     A completed game's server-derived digest is our STRONGEST evidence (it is
 *     rebuilt from an append-only log, not typed by a kid), so it flows into the
 *     record through the OBSERVER as portrait observations
 *     (`masteryObservations`, anchored on the game session, nodeKey optional —
 *     see `convex/gameObserver.ts`). It NEVER flows through SR
 *     (`practiceAttempts`/`practiceMastery`): green stays the practice engine's
 *     monopoly because green = decaying, re-probed SR state, and a game round is
 *     not that probe. Strongest evidence, portrait layer; SR credit, practice
 *     engine only.
 *
 * 3 · WORKLETS MAY COMPUTE PRESENTATION, NEVER TRUTH. Reanimated worklets cannot
 *     call imported JS functions, so per-frame game logic gets copied inline and
 *     that copy silently drifts (see `NumberLine.native.tsx`). Anything that
 *     reaches this contract — state a checkpoint persists, any value inside a
 *     `GameEventInput` — stays on the JS thread. This is also why a game module
 *     is split: the framework-free half owns truth, the `Screen` owns pixels.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── North star: the host is the platform; "game" is its first tenant ──────────
 * The durable asset here is NOT games — it is the host + evidence + digest
 * layer: session lifecycle, append-only provenance-stamped evidence, a
 * deterministic server digest, crash containment. Rabbithole has three tiers of
 * interactive experience (tutor-conjured `create_code` artifacts: zero evidence;
 * manipulatives: a one-bit grade; games: this contract), and the intended
 * direction is CONVERGENCE: when a future need is "observe what happened inside
 * an interactive experience," extend THIS capture layer rather than growing a
 * second evidence channel beside it. Manipulative sessions digesting through
 * this contract is the expected first convergence; a webview bridge for
 * tutor-built interactives is the horizon. Two capture vocabularies for "what
 * the kid did in the interactive thing" is the fork this paragraph exists to
 * prevent.
 */

/**
 * Where a game can be played. Games are iPad-only, as POLICY and not as an
 * exception — there is no web renderer and no per-game fallback (a degraded
 * substitute is less honest than a plain statement of fact). A browser renders a
 * capability notice from this declaration, and the SAME declaration is read by
 * the teacher's authoring/assignment UI so the requirement is visible when a
 * game is assigned rather than when a scholar opens it.
 *
 * Reviewing is not playing: submissions and evidence stay web-readable, so a
 * teacher on a laptop keeps their review workflow.
 */
export type GamePlatform = "ipad";

/** Human copy for the capability notice. One sentence, no apology, no fallback. */
export function platformNotice(title: string, platform: GamePlatform): string {
  if (platform === "ipad") return `${title} runs on your iPad.`;
  return `${title} runs on another device.`;
}

// ── The closed evidence vocabulary ───────────────────────────────────────────

/**
 * The complete set of things a game may say happened. Closed on purpose: a game
 * can be as bespoke as it likes in its RULES, but it speaks about a scholar in
 * exactly these ten shapes. Widening this union is a substrate change, not a
 * game change.
 *
 * The provenance split is encoded in the kind itself rather than a flag, so it
 * cannot be mis-set: `choice_made` / `prediction_recorded` / `scholar_explained`
 * are things the SCHOLAR did; `observation_recorded` / `local_rule_result` are
 * things the GAME showed; `strategy_inferred` is explicitly the game guessing.
 */
export type GameEventPayload =
  /** The game moved to a new internal phase. Feeds per-phase active time. */
  | { kind: "phase_changed"; phase: string }
  /** The scholar picked something. `among` records what was on offer. */
  | { kind: "choice_made"; choice: string; among?: readonly string[] }
  /** The scholar committed to a prediction BEFORE seeing the consequence. */
  | { kind: "prediction_recorded"; value: string }
  /**
   * What the world then showed. `predictsSeq` explicitly answers an earlier
   * `prediction_recorded` event; when omitted the digest pairs chronologically.
   */
  | { kind: "observation_recorded"; value: string; predictsSeq?: number }
  /** The scholar's model changed. The single most valuable thing a game emits. */
  | { kind: "model_revised"; before: string; after: string; triggeredBySeq?: number }
  /** The game's GUESS at a strategy. Always rendered as an inference, never a fact. */
  | { kind: "strategy_inferred"; strategy: string }
  /** A local rule fired. Explicitly NOT verified correctness — the server grades nothing here. */
  | { kind: "local_rule_result"; passed: boolean; detail?: string }
  /** Words the scholar typed. Their reasoning, in their own words. */
  | { kind: "scholar_explained"; text: string }
  /** The scholar tapped the Hint door. Host-emitted — a game can neither forge nor suppress it. */
  | { kind: "help_requested"; note?: string }
  /** The game's own outcome key. A CLAIM about its own rules, never a grade. */
  | { kind: "outcome_claimed"; outcomeKey: string };

export type GameEventKind = GameEventPayload["kind"];

/** Every member of the union, for runtime validation. Kept total by the assertion below. */
export const GAME_EVENT_KINDS = [
  "phase_changed",
  "choice_made",
  "prediction_recorded",
  "observation_recorded",
  "model_revised",
  "strategy_inferred",
  "local_rule_result",
  "scholar_explained",
  "help_requested",
  "outcome_claimed",
] as const satisfies readonly GameEventKind[];

// Compile-time totality: a new payload member that never lands in the runtime
// list resolves to `never` here and fails the build — the same guard shape
// `nativeManipulativeKinds.ts` uses over `ManipulativeKind`.
type UncoveredEventKind = Exclude<GameEventKind, (typeof GAME_EVENT_KINDS)[number]>;
const _assertEventKindsTotal: UncoveredEventKind extends never ? true : never = true;
void _assertEventKindsTotal;

export function isGameEventKind(value: string): value is GameEventKind {
  return (GAME_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * eventKeys the HOST emits on behalf of every game. Reserved: the `host.` prefix
 * is rejected in a game's own evidence plan, so a game can never shadow one.
 * These are why the Hint affordance is host chrome — the game is not asked
 * to report it and therefore cannot decline to.
 */
export const HOST_EVENT_KEYS = {
  help: "host.help",
} as const;

export const HOST_EVENT_KEY_PREFIX = "host.";

export function isHostEventKey(eventKey: string): boolean {
  return eventKey.startsWith(HOST_EVENT_KEY_PREFIX);
}

// ── The three tiers of an event ──────────────────────────────────────────────
//
// Each tier adds exactly what the layer below it is not allowed to assert. The
// separation is the whole point: identity, ordering and time are host- and
// server-supplied and are NOT overridable by a game.

/**
 * Who did the thing. Defaults to `scholar` when absent, which is the only
 * honest default for a single-player game.
 *
 * This exists because a game with an opponent (a bot taking a turn) would
 * otherwise log the opponent's move indistinguishably from the scholar's, and
 * every downstream reading — the digest, a teacher's review, anything a tutor
 * is later told — would attribute the machine's choice to the child. That is
 * not a formatting problem; it is a false claim about a kid's thinking.
 */
export type GameActor = "scholar" | "opponent" | "system";

export const GAME_ACTORS = ["scholar", "opponent", "system"] as const satisfies readonly GameActor[];

/** Tier 1 — what a GAME may assert. No identity, no sequence, no time. */
export type GameEventInput = {
  /** Game-specific key, declared in the server-owned evidence plan. */
  eventKey: string;
  payload: GameEventPayload;
  /** Defaults to `scholar`. See `GameActor`. */
  actor?: GameActor;
};

/**
 * Tier 2 — what the HOST submits: the game's assertion plus host-derived ACTIVE
 * time (wall-clock since the session opened, minus time the app spent
 * backgrounded). A game never asserts elapsed time; it does not have the
 * AppState signal that makes the number honest.
 */
export type GameEventSubmission = GameEventInput & { atActiveMs: number };

/** Tier 3 — what the SERVER stores. `seq` is 1-based, contiguous, server-assigned. */
export type GameEvent = GameEventSubmission & { seq: number; receivedAt: number };

// ── Bounds ───────────────────────────────────────────────────────────────────
//
// Small, boring caps. They exist so a looping game cannot fill a table, and so
// no single payload can grow into a channel for smuggling instructions into a
// later model prompt.

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_EVENTS_PER_SESSION = 2_000;
export const MAX_EVENT_TEXT_LEN = 500;
export const MAX_EVENT_KEY_LEN = 64;
/**
 * `among` records what was on offer, so it is sized by the game's board, not by
 * a UI menu. 24 was a guess made before any real game existed, and the first one
 * blew past it on move 1 (a Factor Game board of 30 offers 29 legal numbers).
 * The bound that actually does the work is {@link MAX_EVENT_PAYLOAD_BYTES};
 * this one only stops a runaway array. Sized to clear the largest legal board.
 */
export const MAX_CHOICE_OPTIONS = 128;
/**
 * Whole-payload cap, in BYTES. The per-field text limits above bound each
 * string, but not their sum — 24 options of 500 characters is a legal
 * `choice_made` under those alone. This is the backstop.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 8 * 1024;
/** The final state snapshot kept as a forensic record. Never loaded back. */
export const MAX_FINAL_STATE_JSON_BYTES = 64 * 1024;
/** Authored config, frozen onto a session at start. */
export const MAX_CONFIG_JSON_BYTES = 32 * 1024;

/**
 * Size in BYTES, not UTF-16 code units. `"🚀".length` is 2 but it costs 4
 * bytes; a cap measured in `.length` is a cap a determined payload walks past.
 */
export function byteLength(value: string): number {
  // TextEncoder is present in every runtime this ships to (Convex, Hermes,
  // Node ≥11, browsers). The fallback keeps the function total rather than
  // letting a bound silently disappear on an exotic host.
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

/**
 * Validate one game-asserted event, structurally. Returns null when fine, or a
 * human-readable reason. Shared so the native host can fail fast in dev and the
 * server can reject authoritatively — one implementation, no drift.
 *
 * This checks SHAPE only. Whether the `eventKey` is declared in the game's
 * evidence plan is a server-side check (the plan is server-owned).
 */
/**
 * The fields each payload kind may carry, `kind` aside. Used to REJECT unknown
 * fields rather than store them: without this, `{kind:"choice_made", choice:"a",
 * mastery:true}` validates and is persisted verbatim, and the union is a
 * compile-time fiction the moment anything reads a stored payload back.
 */
const PAYLOAD_FIELDS: Record<GameEventKind, readonly string[]> = {
  phase_changed: ["phase"],
  choice_made: ["choice", "among"],
  prediction_recorded: ["value"],
  observation_recorded: ["value", "predictsSeq"],
  model_revised: ["before", "after", "triggeredBySeq"],
  strategy_inferred: ["strategy"],
  local_rule_result: ["passed", "detail"],
  scholar_explained: ["text"],
  help_requested: ["note"],
  outcome_claimed: ["outcomeKey"],
};

export function gameEventInputError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "event must be an object";
  const ev = value as Partial<GameEventInput>;
  if (typeof ev.eventKey !== "string" || ev.eventKey.length === 0) {
    return "event.eventKey must be a non-empty string";
  }
  if (ev.eventKey.length > MAX_EVENT_KEY_LEN) {
    return `event.eventKey exceeds ${MAX_EVENT_KEY_LEN} characters`;
  }
  if (ev.actor !== undefined && !(GAME_ACTORS as readonly string[]).includes(ev.actor)) {
    return `unknown actor "${String(ev.actor)}"`;
  }
  const payload = ev.payload as GameEventPayload | undefined;
  if (!payload || typeof payload !== "object") return "event.payload must be an object";
  if (Array.isArray(payload)) return "event.payload must be an object, not an array";
  const kind = (payload as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !isGameEventKind(kind)) {
    return `unknown event kind "${String(kind)}"`;
  }

  // Closed by field, not just by kind. An unknown field is an error, never a
  // silently-stored extra — see PAYLOAD_FIELDS.
  const allowed = PAYLOAD_FIELDS[kind];
  for (const field of Object.keys(payload)) {
    if (field === "kind") continue;
    if (!allowed.includes(field)) return `${kind} carries unknown field "${field}"`;
  }

  let payloadBytes = 0;
  try {
    payloadBytes = byteLength(JSON.stringify(payload));
  } catch {
    return "event.payload is not serializable";
  }
  if (payloadBytes > MAX_EVENT_PAYLOAD_BYTES) {
    return `${kind} payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`;
  }

  const text = (field: string, v: unknown, required: boolean): string | null => {
    if (v === undefined) return required ? `${kind}.${field} is required` : null;
    if (typeof v !== "string") return `${kind}.${field} must be a string`;
    if (v.length === 0) return `${kind}.${field} must not be empty`;
    if (v.length > MAX_EVENT_TEXT_LEN) {
      return `${kind}.${field} exceeds ${MAX_EVENT_TEXT_LEN} characters`;
    }
    return null;
  };

  switch (payload.kind) {
    case "phase_changed":
      return text("phase", payload.phase, true);
    case "choice_made": {
      const err = text("choice", payload.choice, true);
      if (err) return err;
      if (payload.among !== undefined) {
        if (!Array.isArray(payload.among)) return "choice_made.among must be an array";
        if (payload.among.length > MAX_CHOICE_OPTIONS) {
          return `choice_made.among exceeds ${MAX_CHOICE_OPTIONS} options`;
        }
        for (const option of payload.among) {
          const optionErr = text("among[]", option, true);
          if (optionErr) return optionErr;
        }
      }
      return null;
    }
    case "prediction_recorded":
      return text("value", payload.value, true);
    case "observation_recorded": {
      const err = text("value", payload.value, true);
      if (err) return err;
      if (payload.predictsSeq !== undefined && !Number.isInteger(payload.predictsSeq)) {
        return "observation_recorded.predictsSeq must be an integer";
      }
      return null;
    }
    case "model_revised": {
      const err = text("before", payload.before, true) ?? text("after", payload.after, true);
      if (err) return err;
      if (payload.triggeredBySeq !== undefined && !Number.isInteger(payload.triggeredBySeq)) {
        return "model_revised.triggeredBySeq must be an integer";
      }
      return null;
    }
    case "strategy_inferred":
      return text("strategy", payload.strategy, true);
    case "local_rule_result": {
      if (typeof payload.passed !== "boolean") return "local_rule_result.passed must be a boolean";
      return text("detail", payload.detail, false);
    }
    case "scholar_explained":
      return text("text", payload.text, true);
    case "help_requested":
      return text("note", payload.note, false);
    case "outcome_claimed":
      return text("outcomeKey", payload.outcomeKey, true);
  }
}

// ── The module contract ──────────────────────────────────────────────────────

export interface GameManifest {
  gameId: string;
  /** Bumped on any rules change. Stamped on a session so evidence stays readable. */
  version: number;
  /**
   * Every eventKey this module can emit. Asserted against the evidence plan by
   * the CI conformance test, so a game cannot quietly grow a new vocabulary
   * without the plan that interprets it.
   */
  eventKeys: readonly string[];
}

export interface GameConfigCodec<C> {
  /** Validates authored config. Throws with a USEFUL message; never silently coerces. */
  parse(value: unknown): C;
}

export interface GameStateCodec<C, S> {
  /** Deterministic for a given (config, seed) — the CI conformance test asserts it. */
  create(input: { config: C; seed: string }): S;
}

/**
 * The framework-free half of a game: manifest, codecs, and (in the game's own
 * files) its rules. Deliberately absent: any scene graph, game loop, rules DSL,
 * scoring schema, physics abstraction or reward system. This is a HOST, not an
 * engine.
 *
 * `Screen` is NOT a member — see `native/src/games/registry.ts`. Splitting the
 * renderer out is what lets the CI conformance test `require()` every registered
 * game without importing a single React Native renderer (the property
 * `nativeManipulativeKinds.test.ts` already relies on), and it makes rule 3 at
 * the top of this file structural rather than a convention.
 */
export interface GameModule<C = unknown, S = unknown> {
  manifest: GameManifest;
  config: GameConfigCodec<C>;
  state: GameStateCodec<C, S>;
}

// ── What a game's Screen is handed ───────────────────────────────────────────

export interface GameLaunch<C, S> {
  config: C;
  /**
   * A FRESH state, always. Round state itself never resumes — an interrupted
   * round is closed and digested server-side and the scholar starts over. Two
   * things this decomposes into, kept distinct on purpose:
   *
   *   1. The scholar's WORK always persists. A game that produces an artifact
   *      (a built thing, a drawing, a written explanation) persists that
   *      artifact in its OWN store; the artifact is the durable asset and is
   *      never lost to a reopen.
   *
   *   2. Whether the TASK INSTANCE varies between rounds is a per-game
   *      pedagogical choice — a fresh draw each time, or the same board again.
   *      Either way, the round's runtime STATE does not resume: the game never
   *      has to make its state restorable, versioned, or
   *      rebuildable-including-derived-UI-state, which is exactly what keeps a
   *      digest whole and spares us a state migration when a game changes.
   */
  state: S;
  /** Stable per session, so randomness is reproducible from the event log. */
  seed: string;
}

export interface GameCheckpoint<S> {
  /**
   * Queued evidence, written in order, resolving only after the server acks.
   * React state is for animation; anything that must survive goes through here.
   *
   * `state` is a SNAPSHOT for the record, never a resume vehicle — the server
   * stores the latest one so a digest can quote where a round got to, and
   * nothing ever reads it back into a game. Evidence is what survives a crash;
   * the round itself does not.
   *
   * **NEVER REJECTS.** A failed write is the HOST's problem to notice, count and
   * tell the scholar about — not something every game author has to remember to
   * catch. It used to reject, and both shipped games called it as `void
   * commit(...)`, so a rejected write became an unhandled promise rejection: no
   * error boundary sees one, and a fleet build has no LogBox. The round played
   * on, beautifully, writing nothing. Games get back a boolean they are free to
   * ignore, which is what a game that has no recovery to offer should do.
   */
  transact(next: { state: S; events?: readonly GameEventInput[] }): Promise<boolean>;
  /** True while a transact is in flight — for disabling a control, not for logic. */
  pending: boolean;
}

export interface GameHostApi {
  /**
   * Record the game's own outcome key and end the session. The server then
   * re-derives the digest from the event log. NOT a grade, NOT mastery, NOT a
   * streak — those words appear nowhere in this contract on purpose.
   *
   * TERMINAL, AND IT TEARS THE SURFACE DOWN. The host closes the moment this
   * resolves, so anything the scholar is meant to SEE about how the round went
   * has to already be on screen and acknowledged. Do not call this inline from
   * the last move: the toy game did exactly that and, on device, the reveal
   * rendered for 493ms before the scholar was flung back to the unit list.
   * Render your result, then let a tap call this.
   *
   * (The host deliberately does not supply a results screen — what "over" looks
   * like is the game's business. A host that drew outcomes would be an engine.)
   */
  complete(outcome: {
    outcomeKey: string;
    events?: readonly GameEventInput[];
    /**
     * The game's final state, kept as a FORENSIC record only — never parsed,
     * never digested, never loaded back into a running game. Supply it when
     * "what did the board look like at the end" is worth being able to answer
     * later; omit it otherwise. It is not a resume vehicle and cannot become
     * one: nothing reads it.
     */
    finalState?: unknown;
  }): Promise<void>;
  /**
   * Leave without completing. The round is LOST — it is closed and digested
   * server-side, and reopening the activity starts a fresh one. The evidence
   * already banked survives; the half-built rocket does not. A game that can
   * lose meaningful work this way should confirm before calling it.
   */
  exit(): void;
}

export interface GameScreenProps<C = unknown, S = unknown> {
  launch: GameLaunch<C, S>;
  checkpoint: GameCheckpoint<S>;
  host: GameHostApi;
}
