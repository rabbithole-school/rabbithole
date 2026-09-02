/**
 * Game BEATS on the practice playlist.
 *
 * A game beat is a teacher-bound game offered inside a practice run — the
 * answer to "can FactorGame still show up in practice sets?" once D-3 forbids
 * the thing it used to do there (pass iff you beat the AI, and feed that to
 * mastery).
 *
 * This module is the deliberate sibling of `instructionEntries.ts`, and the
 * shape is copied on purpose rather than reinvented. A beat is served as a
 * SIDECAR — `{ at, entry }` alongside the run, never an element of `items` —
 * so the client can render it INSTEAD of `items[at]` and then fall through to
 * that same index. `idx` never shifts, the graded array is untouched, and
 * `recordAttemptCore` is never reached. That is what makes `masteryEffect:
 * "none"` a structural property of where the beat LIVES rather than a flag
 * some later code path could forget to honour.
 *
 * Three things it deliberately does NOT do:
 *
 *  - It does not make a game a `practiceItem`. An item is discriminated by
 *    `answerType` and every attempt row advances the scheduler; a game has no
 *    answer to grade, and giving it one is exactly the D-3 violation being
 *    retired.
 *  - It does not record "played" here. `gameSessions` already is that record —
 *    one row per round, with `startedAt`/`endedAt`/`status`. Cooldown reads it
 *    rather than duplicating it, so there is one canonical answer to "has this
 *    scholar played this game" and it cannot drift.
 *  - It does not decide anything about credit. The offer ledger it does own is
 *    SYSTEM-ONLY telemetry (offers and declines), on the same footing as
 *    `instructionEvents`: never read into mastery, credit, adaptive difficulty,
 *    or any scholar-/teacher-facing quality surface. Declining a game is a
 *    preference, not a deficit.
 *
 * Pure core: no `ctx`, no DB, so the selection + budget rules are unit-testable
 * in isolation. `practiceSkills.ts` loads rows and delegates every policy call
 * here.
 */

/** Max times a game beat the scholar declined is re-offered before it rests. */
export const GAME_BEAT_REOFFER_CAP = 3;

/**
 * After a scholar actually PLAYS a bound game, don't offer it again for this
 * long.
 *
 * Unlike a Launchpad — which is a first look and is suppressed permanently once
 * engaged — a game is replayable and worth replaying; suppressing it forever on
 * first play would retire the very thing the teacher bound. So this is a
 * COOLDOWN, not a fire-once gate: the game comes back, just not tomorrow.
 */
export const GAME_BEAT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lanes a beat may interrupt.
 *
 * `mapping` is excluded because those are placement/calibration probes — a
 * detour mid-measurement corrupts what the probe is measuring. `challenge` and
 * `stretch` are excluded because they are optional tails the scholar has
 * already earned their way to; interposing a game there reads as a penalty for
 * doing well. What is left is ordinary frontier and review work, which is
 * precisely where a teacher binding a game means it to land.
 */
export const GAME_BEAT_ELIGIBLE_LANES = ["new", "review"] as const;

/** Stable content key for a bound game. One key per bound activity. */
export function gameBeatKey(activityId: string): string {
  return `game:${activityId}`;
}

/** Stable per-scholar render handle threaded through the wire entry + mutations. */
export function gameBeatOfferId(scholarId: string, key: string): string {
  return `${scholarId}:${key}`;
}

/** A teacher's binding of a `kind="game"` activity to a slice of the graph. */
export type GameBindingLike = {
  activityId: string;
  domain: string;
  strand: string;
  /** When set, the binding narrows to these skills rather than the whole strand. */
  skillKeys?: string[] | null;
  isActive?: boolean | null;
};

/** The subset of a `practiceGameOffers` row the pure rules read. */
export type GameOfferLike = {
  key: string;
  offerCount?: number | null;
  lastOfferedAt?: number | null;
  lastOfferedDayBucket?: string | null;
  declinedAt?: number | null;
};

/** One served item, reduced to what beat selection needs. */
export type RunItemLike = {
  skillKey: string;
  domain: string;
  strand?: string;
  lane?: string;
};

/**
 * A game beat positioned ON a served run: the entry to show, and the index of
 * the item it sits in front of.
 *
 * Deliberately a SIBLING of `items`, never a member of it — see the module
 * comment. The client renders this instead of `items[at]`, then falls through.
 */
export type RunGameBeat = { at: number; entry: GameBeatEntry };

/** Tier-1 wire shape: what the client needs to render the doorway. */
export type GameBeatEntry = {
  id: string;
  offerId: string;
  kind: "game_beat";
  key: string;
  /** The `kind="game"` activity to open. The host resolves game + config from it. */
  activityId: string;
  /** Catalog id, so the client can name the platform requirement before launch. */
  gameId: string;
  title: string;
  subtitle?: string;
  /** Why this game is here, in the scholar's terms. Teacher-authored. */
  blurb?: string;
  target: { domain: string; strand: string };
  /**
   * D-5 is a POLICY, and it has to be legible before launch, not after. The
   * playlist runs on web and native; games run only on the iPad. A beat is
   * ungraded, so a scholar on a laptop can simply pass it at zero cost — which
   * is the reason a beat handles native-only gracefully where a practice ITEM
   * could not (an item they cannot play would have to be graded, skipped, or
   * excluded from accuracy, and all three corrupt the run).
   */
  platform: "native";
  /** Structural invariant: a beat NEVER affects mastery/placement/credit. */
  masteryEffect: "none";
};

/**
 * True when a bound game should not be offered right now.
 *
 * Two independent brakes, deliberately different in kind:
 *  - COOLDOWN after a real play, so a replayable game rests rather than retires.
 *  - A re-offer CAP after declines, so a scholar who keeps passing is left
 *    alone — but one impulsive pass never suppresses it permanently.
 */
export function isGameBeatSuppressed(params: {
  offer?: GameOfferLike | null;
  /** `startedAt` of the scholar's most recent round of this game, if any. */
  lastPlayedAt?: number | null;
  now: number;
  cap?: number;
  cooldownMs?: number;
}): boolean {
  const cap = params.cap ?? GAME_BEAT_REOFFER_CAP;
  const cooldown = params.cooldownMs ?? GAME_BEAT_COOLDOWN_MS;
  if (params.lastPlayedAt != null && params.now - params.lastPlayedAt < cooldown) {
    return true;
  }
  const offer = params.offer;
  if (!offer) return false;
  if ((offer.offerCount ?? 0) >= cap && offer.declinedAt != null) return true;
  return false;
}

/** Does a binding cover the skill this item is serving? */
export function bindingMatchesItem(binding: GameBindingLike, item: RunItemLike): boolean {
  if (binding.isActive === false) return false;
  if (binding.domain !== item.domain) return false;
  if (!item.strand || binding.strand !== item.strand) return false;
  const keys = binding.skillKeys;
  if (keys && keys.length > 0 && !keys.includes(item.skillKey)) return false;
  return true;
}

/**
 * Pick the game beat for a RUN — which bound game, and the exact item index to
 * offer it in front of.
 *
 * Selecting FROM the served items (rather than from the graph, then hoping the
 * queue agrees) is copied straight from `selectRunLaunchpad`, and for the same
 * reason: it makes the position defect UNREPRESENTABLE. The strand the beat
 * names is by construction the strand of `items[at]`, so a beat can never
 * introduce work the run does not actually contain.
 *
 * Precedence:
 *  1. Daily cap — if a game beat for a DIFFERENT game was already offered
 *     today, offer nothing.
 *  2. Otherwise the first served item that is in an eligible lane, is covered
 *     by an active binding, and whose game is not cooling down or capped out.
 *
 * Advisory, exactly like the Launchpad: a Convex query cannot write, so the
 * claim mutation re-checks the cap authoritatively.
 */
export function selectRunGameBeat(params: {
  items: RunItemLike[];
  bindings: GameBindingLike[];
  offerByKey: Map<string, GameOfferLike>;
  /** `startedAt` of the most recent round per bound activityId. */
  lastPlayedByActivity: Map<string, number>;
  dayBucket: string;
  now: number;
  eligibleLanes?: readonly string[];
  cap?: number;
  cooldownMs?: number;
}): { at: number; binding: GameBindingLike; key: string } | null {
  const lanes = params.eligibleLanes ?? GAME_BEAT_ELIGIBLE_LANES;
  if (params.bindings.length === 0) return null;

  for (let at = 0; at < params.items.length; at++) {
    const item = params.items[at];
    if (!item.lane || !lanes.includes(item.lane)) continue;
    const binding = params.bindings.find((b) => bindingMatchesItem(b, item));
    if (!binding) continue;
    const key = gameBeatKey(binding.activityId);
    if (
      isGameBeatSuppressed({
        offer: params.offerByKey.get(key),
        lastPlayedAt: params.lastPlayedByActivity.get(binding.activityId) ?? null,
        now: params.now,
        cap: params.cap,
        cooldownMs: params.cooldownMs,
      })
    ) {
      continue;
    }
    // The <=1/day governor, evaluated LAST and scoped to OTHER keys — the same
    // subtlety `selectRunLaunchpad` documents. The doorway claims its own
    // impression on mount, which writes `lastOfferedDayBucket` for exactly this
    // key; a blanket "anything offered today" test would flip true the instant
    // the card rendered and retract the offer being shown, yanking it
    // off-screen mid-decision. Excluding this key also gives the behaviour we
    // want on its own merits: an untaken doorway survives a reload, while the
    // cooldown and decline cap above still retire it once the scholar has
    // actually answered it.
    const offeredOtherToday = [...params.offerByKey.entries()].some(
      ([k, o]) => k !== key && o.lastOfferedDayBucket === params.dayBucket,
    );
    if (offeredOtherToday) return null;
    return { at, binding, key };
  }
  return null;
}
