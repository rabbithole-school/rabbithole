/**
 * The DIGEST — the only thing that ever leaves a game session.
 *
 * A pure function over the append-only event log. The server calls it; the
 * client may call it too for optimistic UI, but the client's answer is never
 * stored (the games shape of the `practiceContract.ts` rule: the server
 * RE-DERIVES rather than trusting a client-supplied summary).
 *
 * Two boundaries this function exists to hold:
 *
 *   • RAW GAME STATE NEVER LEAVES. The digest is built from events, not from the
 *     checkpointed state blob. A game's state can be as weird as it likes; none
 *     of it reaches a teacher surface or a model prompt.
 *
 *   • NO VERDICTS. There is no `passed`, no `score`, no `mastery`, no
 *     recommendation in `GameSessionDigest`. `outcomeClaim` is the game's own
 *     word for how its round ended — a claim, not a grade. Anything that reads
 *     like a conclusion has to be drawn downstream by something with the
 *     authority to draw it.
 *
 * Deterministic: same events in, same digest out. That is what makes it safe to
 * rebuild after the fact when a plan label changes.
 */

import type { EvidencePlan, TutorRole } from "./catalog";
import { isHostEventKey, type GameActor, type GameEvent } from "./contract";

export interface DigestPhase {
  phase: string;
  enteredAtActiveMs: number;
  /** Time spent before the next phase (or session end). */
  durationMs: number;
}

export interface DigestPrediction {
  seq: number;
  atActiveMs: number;
  label: string;
  value: string;
  /** The observation that answered it, when one did. */
  outcome?: { seq: number; atActiveMs: number; label: string; value: string };
}

export interface DigestRevision {
  seq: number;
  atActiveMs: number;
  label: string;
  before: string;
  after: string;
  /** What the scholar had just seen, when the game said so. */
  triggeredBy?: { seq: number; label: string; summary: string };
}

export interface DigestNote {
  seq: number;
  atActiveMs: number;
  label: string;
  /** Rendered text for this event. Always derived here, never game-supplied prose. */
  detail: string;
  tutorRole: TutorRole;
  concept?: string;
  /** Who did it. `scholar` unless a game declared otherwise. */
  actor: GameActor;
}

export interface GameSessionDigest {
  gameId: string;
  gameVersion: number;
  eventCount: number;
  activeMs: number;
  phases: DigestPhase[];
  predictions: DigestPrediction[];
  revisions: DigestRevision[];
  /** The game's guesses at strategy. Labelled as inferences wherever shown. */
  strategyInferences: DigestNote[];
  /** Local rule outcomes. NOT verified correctness — the server grades nothing here. */
  localRuleResults: DigestNote[];
  /** The scholar's own words. */
  scholarExplanations: DigestNote[];
  helpRequests: DigestNote[];
  choices: DigestNote[];
  /** The game's own word for how the round ended. A claim, never a grade. */
  outcomeClaim: { seq: number; atActiveMs: number; outcomeKey: string } | null;
}

export interface BuildDigestInput {
  gameId: string;
  gameVersion: number;
  /** Host-tracked active time at session end. Games never assert elapsed time. */
  totalActiveMs: number;
  /** The append-only log, in `seq` order. */
  events: readonly GameEvent[];
  /** The effective (game + host) plan. See `effectiveEvidencePlan`. */
  plan: EvidencePlan;
}

/**
 * An eventKey with no plan entry falls back to the raw key as its label and a
 * `context` role. The server rejects undeclared keys at ingest, so this only
 * fires when a plan entry is REMOVED after events were already stored — and in
 * that case a slightly ugly label beats a silently dropped event.
 */
function lookup(plan: EvidencePlan, eventKey: string) {
  const entry = plan[eventKey];
  if (entry) return entry;
  return { label: eventKey, tutorRole: "context" as TutorRole };
}

export function buildGameSessionDigest(input: BuildDigestInput): GameSessionDigest {
  const { gameId, gameVersion, totalActiveMs, plan } = input;
  const events = [...input.events].sort((a, b) => a.seq - b.seq);

  const phases: DigestPhase[] = [];
  const predictions: DigestPrediction[] = [];
  const revisions: DigestRevision[] = [];
  const strategyInferences: DigestNote[] = [];
  const localRuleResults: DigestNote[] = [];
  const scholarExplanations: DigestNote[] = [];
  const helpRequests: DigestNote[] = [];
  const choices: DigestNote[] = [];
  let outcomeClaim: GameSessionDigest["outcomeClaim"] = null;

  // Observations are collected first so predictions can be paired in one pass
  // without depending on the order the two arrive in.
  type Observation = {
    seq: number;
    atActiveMs: number;
    label: string;
    value: string;
    predictsSeq?: number;
    ignored: boolean;
  };
  const observations: Observation[] = [];
  const eventBySeq = new Map<number, GameEvent>();

  for (const ev of events) {
    eventBySeq.set(ev.seq, ev);
    const { label, tutorRole, concept } = lookup(plan, ev.eventKey);
    const actor: GameActor = ev.actor ?? "scholar";
    const note = (detail: string): DigestNote => ({
      seq: ev.seq,
      atActiveMs: ev.atActiveMs,
      label,
      detail,
      tutorRole,
      concept,
      actor,
    });
    // A digest is a record of THE SCHOLAR'S thinking. An opponent's move is
    // context — it belongs on the timeline, but a bot's choice must never be
    // collected as a prediction the child made or a strategy the child used.
    // Everything the digest presents as the scholar's reasoning is gated here.
    const bySelf = actor === "scholar";
    const ignored = tutorRole === "ignore" || !bySelf;

    switch (ev.payload.kind) {
      // Phases and the outcome claim are STRUCTURE, not narration: they compute
      // even when the plan files them as `ignore`, because per-phase timing and
      // "how did this end" are the frame everything else is read against.
      case "phase_changed": {
        // A HOST lifecycle marker is never a phase of the game. This guard is
        // cheap insurance against a bug class we already paid for once: when
        // the host emitted `host.resumed` with a `phase_changed` payload, each
        // reopen opened a zero-length "resumed" phase and stole the time the
        // scholar actually spent thinking (one round reported `revise 21s`
        // against a real 103s). Resume is gone, so this is now unreachable —
        // keep it anyway, so re-introducing a host phase marker degrades to a
        // dropped event rather than to silently corrupted timings.
        if (isHostEventKey(ev.eventKey)) break;
        const phase = ev.payload.phase;
        if (phases.length > 0) {
          const prev = phases[phases.length - 1];
          prev.durationMs = Math.max(0, ev.atActiveMs - prev.enteredAtActiveMs);
        }
        phases.push({ phase, enteredAtActiveMs: ev.atActiveMs, durationMs: 0 });
        break;
      }
      case "outcome_claimed":
        outcomeClaim = {
          seq: ev.seq,
          atActiveMs: ev.atActiveMs,
          outcomeKey: ev.payload.outcomeKey,
        };
        break;
      case "prediction_recorded":
        if (!ignored) {
          predictions.push({
            seq: ev.seq,
            atActiveMs: ev.atActiveMs,
            label,
            value: ev.payload.value,
          });
        }
        break;
      case "observation_recorded":
        observations.push({
          seq: ev.seq,
          atActiveMs: ev.atActiveMs,
          label,
          value: ev.payload.value,
          predictsSeq: ev.payload.predictsSeq,
          ignored,
        });
        break;
      case "model_revised":
        if (!ignored) {
          revisions.push({
            seq: ev.seq,
            atActiveMs: ev.atActiveMs,
            label,
            before: ev.payload.before,
            after: ev.payload.after,
          });
        }
        break;
      case "strategy_inferred":
        if (!ignored) strategyInferences.push(note(ev.payload.strategy));
        break;
      case "local_rule_result":
        if (!ignored) {
          localRuleResults.push(
            note(ev.payload.detail ?? (ev.payload.passed ? "rule satisfied" : "rule not satisfied")),
          );
        }
        break;
      case "scholar_explained":
        if (!ignored) scholarExplanations.push(note(ev.payload.text));
        break;
      case "help_requested":
        if (!ignored) helpRequests.push(note(ev.payload.note ?? "asked for help"));
        break;
      case "choice_made": {
        // Choices are the one thing an opponent DOES contribute: the board a
        // scholar faced is unreadable without the moves made against them.
        // Recorded with its actor, so a reader never has to guess whose it was.
        if (tutorRole === "ignore") break;
        const among = ev.payload.among;
        choices.push(
          note(
            among && among.length > 0
              ? `${ev.payload.choice} (of ${among.length})`
              : ev.payload.choice,
          ),
        );
        break;
      }
    }
  }

  if (phases.length > 0) {
    const last = phases[phases.length - 1];
    last.durationMs = Math.max(0, totalActiveMs - last.enteredAtActiveMs);
  }

  pairPredictions(predictions, observations);

  // Fill each revision's trigger, when the game named one.
  for (const revision of revisions) {
    const source = eventBySeq.get(revision.seq);
    if (!source || source.payload.kind !== "model_revised") continue;
    const triggerSeq = source.payload.triggeredBySeq;
    if (triggerSeq === undefined) continue;
    const trigger = eventBySeq.get(triggerSeq);
    if (!trigger) continue;
    revision.triggeredBy = {
      seq: trigger.seq,
      label: lookup(plan, trigger.eventKey).label,
      summary: summarize(trigger),
    };
  }

  return {
    gameId,
    gameVersion,
    eventCount: events.length,
    activeMs: totalActiveMs,
    phases,
    predictions,
    revisions,
    strategyInferences,
    localRuleResults,
    scholarExplanations,
    helpRequests,
    choices,
    outcomeClaim,
  };
}

/**
 * Explicit links first (`predictsSeq`), then greedy chronological pairing of
 * whatever is left: the earliest unpaired prediction takes the earliest later
 * unpaired observation. Deliberately simple — the pairing is a reading aid, and
 * a game that cares about precision says so with `predictsSeq`.
 */
function pairPredictions(
  predictions: DigestPrediction[],
  observations: readonly {
    seq: number;
    atActiveMs: number;
    label: string;
    value: string;
    predictsSeq?: number;
    ignored: boolean;
  }[],
) {
  const usable = observations.filter((o) => !o.ignored);
  const taken = new Set<number>();

  for (const observation of usable) {
    if (observation.predictsSeq === undefined) continue;
    const prediction = predictions.find((p) => p.seq === observation.predictsSeq);
    if (!prediction || prediction.outcome) continue;
    prediction.outcome = {
      seq: observation.seq,
      atActiveMs: observation.atActiveMs,
      label: observation.label,
      value: observation.value,
    };
    taken.add(observation.seq);
  }

  for (const prediction of predictions) {
    if (prediction.outcome) continue;
    const match = usable.find(
      (o) => !taken.has(o.seq) && o.predictsSeq === undefined && o.seq > prediction.seq,
    );
    if (!match) continue;
    prediction.outcome = {
      seq: match.seq,
      atActiveMs: match.atActiveMs,
      label: match.label,
      value: match.value,
    };
    taken.add(match.seq);
  }
}

/** One-line rendering of an event, for a revision's trigger. */
function summarize(ev: GameEvent): string {
  switch (ev.payload.kind) {
    case "phase_changed":
      return ev.payload.phase;
    case "choice_made":
      return ev.payload.choice;
    case "prediction_recorded":
      return ev.payload.value;
    case "observation_recorded":
      return ev.payload.value;
    case "model_revised":
      return `${ev.payload.before} → ${ev.payload.after}`;
    case "strategy_inferred":
      return ev.payload.strategy;
    case "local_rule_result":
      return ev.payload.detail ?? (ev.payload.passed ? "rule satisfied" : "rule not satisfied");
    case "scholar_explained":
      return ev.payload.text;
    case "help_requested":
      return ev.payload.note ?? "asked for help";
    case "outcome_claimed":
      return ev.payload.outcomeKey;
  }
}
