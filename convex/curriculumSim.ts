"use node";

/**
 * Self-improving curricula — the simulation orchestrator (node runtime).
 *
 * This is the only place that makes Anthropic calls for the loop: the
 * Scholar Simulator (Haiku roleplaying a kid), the REAL tutor (Sonnet,
 * driven by the production system prompt assembled in
 * curriculumExperiments), the Judge (Opus), and — for propose/loop modes —
 * the Improver (Opus). It mirrors evals/curriculum-sim/lib/* — the harness
 * is the portable core; this is the product wrapper that persists variants
 * + sessions + a reactive progress doc.
 *
 * Three modes (curriculumExperiments.start picks one):
 *  - analyze: simulate + judge the baseline cast, report. No edits.
 *  - propose: + the Improver proposes ONE candidate; re-simulate; decide
 *    keep/hold via the protected-dim gate. Teacher promotes the diff.
 *  - loop: hill-climb K candidates/generation, keep the best that clears
 *    the gate, stop on plateau/budget (pure control flow in
 *    lib/curriculumOptimize.ts).
 *
 * Needs ANTHROPIC_API_KEY on the deployment. Without it the Anthropic
 * calls 401 and the experiment finalizes `failed` with the error (it
 * never half-writes). See review/self-improving-curricula-plan.md.
 */
import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./lib/primaryInstitutionPromptProfile";
import {
  buildKidSystem,
  buildProbeAnswerPrompt,
  extractProbeAnswer,
  parseControl,
  toMessages,
  JUDGE_RUBRIC,
  JUDGE_TOOL,
  formatSessionForJudge,
  PAIRWISE_RUBRIC,
  PAIRWISE_TOOL,
  formatPairwiseForJudge,
  assignPairwiseOrder,
  resolvePairwiseWinner,
  type SimActivity,
  type SimProfile,
  type SimTurn,
  type StopReason,
} from "./lib/curriculumSimShared";
import {
  buildProbePairs,
  summarizeProbe,
  type ProbeItem,
  type ProbeSummary,
} from "./lib/curriculumProbe";
import {
  aggregate,
  isBetter,
  isBetterPairwise,
  tallyPairwise,
  DEFAULT_GATE,
  PROTECTED_DIMS,
  type Aggregate,
  type ExperimentPairwise,
  type PairwiseComparison,
  type PromotionDecision,
  type SessionVerdict,
} from "./lib/curriculumScore";
import {
  deterministicPreflightFindings,
  fallbackPreflightResult,
  normalizePreflightSynthesis,
  preflightCoverage,
  PREFLIGHT_SYNTHESIS_SYSTEM,
  PREFLIGHT_SYNTHESIS_TOOL,
  type PreflightCoverage,
  type PreflightResult,
} from "./lib/curriculumPreflightResult";
import { calibrate, realMessagesToTranscript, transcriptExcerpt } from "./lib/curriculumGround";
import {
  IMPROVER_SYSTEM,
  IMPROVER_TOOL,
  buildImproverUserMessage,
  type ImproverDiagnosis,
  type ImproverProposal,
} from "./lib/curriculumImprover";
import { optimize, type OptVariant } from "./lib/curriculumOptimize";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the env
const TUTOR_MODEL = process.env.TUTOR_MODEL || MODELS.SONNET;
const SIM_MODEL = process.env.SIM_MODEL || MODELS.HAIKU;
const JUDGE_MODEL = process.env.JUDGE_MODEL || MODELS.OPUS;
const IMPROVER_MODEL = process.env.IMPROVER_MODEL || MODELS.OPUS;

/** Thrown when a cancel lands mid-run; the catch returns without finalizing. */
class CancelledError extends Error {}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * One emergent session: tutor opens, then sim ⇄ tutor until goal/stuck/cap.
 * `onTurn` (optional) is awaited after every turn with a snapshot of the
 * conversation so far — the orchestrator uses it to stream the session live to
 * the running view. It's best-effort: a failed live-write never sinks the run.
 */
async function runSession(
  ctx: ActionCtx,
  profile: SimProfile,
  activity: SimActivity,
  firstTurnPrompt: string,
  laterPrompt: string,
  maxTurns: number,
  onTurn?: (turns: SimTurn[]) => Promise<void>,
  institutionId?: Id<"institutions"> | null,
): Promise<{ turns: SimTurn[]; stopReason: StopReason }> {
  const turns: SimTurn[] = [];
  const kidSystem = buildKidSystem(profile, activity);
  // Snapshot-and-report: pass a copy (turns is mutated as the session grows).
  const report = async () => {
    if (!onTurn) return;
    try {
      await onTurn([...turns]);
    } catch (err) {
      console.warn(
        `runSession: live-turn report failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Tutor opens (the production <start> greeting).
  const opener = await anthropic.messages.create({
    model: TUTOR_MODEL,
    max_tokens: 1024,
    system: firstTurnPrompt,
    messages: [{ role: "user", content: "(start)" }],
  });
  await recordAnthropicUsage(ctx, {
    source: "curriculum-sim",
    role: ROLES.TEACHER,
    model: TUTOR_MODEL,
    usage: opener.usage,
    institutionId,
  });
  turns.push({ role: "tutor", content: textOf(opener) });
  await report();

  for (let i = 0; i < maxTurns; i++) {
    const kid = await anthropic.messages.create({
      model: SIM_MODEL,
      max_tokens: 400,
      system: kidSystem,
      messages: toMessages(turns, "scholar"),
    });
    await recordAnthropicUsage(ctx, {
      source: "curriculum-sim",
      role: ROLES.TEACHER,
      model: SIM_MODEL,
      usage: kid.usage,
      institutionId,
    });
    const reply = parseControl(textOf(kid));
    turns.push({ role: "scholar", content: reply.text });
    await report();
    if (reply.stop) return { turns, stopReason: reply.stop };

    const tutor = await anthropic.messages.create({
      model: TUTOR_MODEL,
      max_tokens: 1024,
      system: laterPrompt,
      messages: toMessages(turns, "tutor"),
    });
    await recordAnthropicUsage(ctx, {
      source: "curriculum-sim",
      role: ROLES.TEACHER,
      model: TUTOR_MODEL,
      usage: tutor.usage,
      institutionId,
    });
    turns.push({ role: "tutor", content: textOf(tutor) });
    await report();
  }
  return { turns, stopReason: "maxTurns" };
}

// ─── Outcome probe (adoptable #1) ───────────────────────────────────

const PROBE_ANSWER_MAX_TOKENS = 300;

/** Stable 32-bit seed from a document id, so a cast member gets the SAME probe
 *  items across variants (baseline vs candidate compare on identical held-out
 *  items — the "delta between variants over the same cast"). */
function seedFromId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * The sim kid (Haiku, SIM_MODEL) answers ONE held-out probe item in character.
 * `prior` (the finished session) is passed for the POST probe and omitted for
 * the cold PRE probe. Returns the EXTRACTED answer string; grading is
 * deterministic downstream (no judge). Throws on a model error so the caller
 * can record a skip reason without corrupting the session.
 */
async function answerProbeItem(
  ctx: ActionCtx,
  profile: SimProfile,
  item: ProbeItem,
  prior?: { activityTitle: string; transcript: SimTurn[] },
  institutionId?: Id<"institutions"> | null,
): Promise<string> {
  const { system, user } = buildProbeAnswerPrompt(profile, item, prior);
  const res = await anthropic.messages.create({
    model: SIM_MODEL,
    max_tokens: PROBE_ANSWER_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
  });
  await recordAnthropicUsage(ctx, {
    source: "curriculum-sim",
    role: ROLES.TEACHER,
    model: SIM_MODEL,
    usage: res.usage,
    institutionId,
  });
  return extractProbeAnswer(textOf(res));
}

/**
 * Run the PRE probe (cold, before the session): ask the kid each pre item.
 * Returns the resolved pairs + the kid's pre answers so the POST phase can
 * reuse the SAME pairs. On no resolvable skills or a model error it returns a
 * skip reason and no answers — the probe NEVER crashes a run.
 */
async function runPreProbe(
  ctx: ActionCtx,
  profile: SimProfile,
  probeSkillKeys: string[],
  seedBase: number,
  institutionId?: Id<"institutions"> | null,
): Promise<{
  pairs: ReturnType<typeof buildProbePairs>;
  preAnswers: string[] | null;
  skipReason: string | null;
}> {
  const pairs = buildProbePairs(probeSkillKeys, seedBase);
  if (pairs.length === 0) {
    return {
      pairs,
      preAnswers: null,
      skipReason:
        probeSkillKeys.length === 0
          ? "no probe skills resolvable (activity declares no target skills)"
          : "no probe skills resolvable (no target skill has a deterministic template)",
    };
  }
  try {
    const preAnswers = await Promise.all(
      pairs.map((p) =>
        answerProbeItem(ctx, profile, p.pre, undefined, institutionId),
      ),
    );
    return { pairs, preAnswers, skipReason: null };
  } catch (err) {
    return {
      pairs,
      preAnswers: null,
      skipReason: `probe pre-answer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run the POST probe (after the session, with the transcript in context) and
 * grade both halves deterministically into a ProbeSummary. Returns a skip
 * reason instead of throwing if the model errors.
 */
async function runPostProbe(
  ctx: ActionCtx,
  profile: SimProfile,
  pairs: ReturnType<typeof buildProbePairs>,
  preAnswers: string[],
  prior: { activityTitle: string; transcript: SimTurn[] },
  institutionId?: Id<"institutions"> | null,
): Promise<{ probe: ProbeSummary | null; skipReason: string | null }> {
  try {
    const postAnswers = await Promise.all(
      pairs.map((p) =>
        answerProbeItem(ctx, profile, p.post, prior, institutionId),
      ),
    );
    return { probe: summarizeProbe(pairs, preAnswers, postAnswers), skipReason: null };
  } catch (err) {
    return {
      probe: null,
      skipReason: `probe post-answer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Opus judge → curriculum-fit, guarded, and diagnosis-only design dims. */
async function judgeSession(
  ctx: ActionCtx,
  activity: SimActivity,
  profile: SimProfile,
  turns: SimTurn[],
  stopReason: StopReason,
  institutionId?: Id<"institutions"> | null,
): Promise<SessionVerdict> {
  const res = await anthropic.messages.create({
    model: JUDGE_MODEL,
    // 20 scored fields (17 numeric dims + 3 free-text) — give the JSON
    // headroom so the tool input can't truncate mid-write. A truncated verdict
    // would parse to undefined dims → NaN in aggregate → corrupt scores.
    max_tokens: 1600,
    system: JUDGE_RUBRIC,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: "record_session_verdict" },
    messages: [
      {
        role: "user",
        content: formatSessionForJudge(activity, profile, turns, stopReason),
      },
    ],
  });
  await recordAnthropicUsage(ctx, {
    source: "curriculum-sim",
    role: ROLES.TEACHER,
    model: JUDGE_MODEL,
    usage: res.usage,
    institutionId,
  });
  // Fail loud on truncation rather than returning a half-written verdict — a
  // partial verdict (undefined dims → NaN) would silently corrupt the cast
  // aggregate and could promote a bad variant.
  if (res.stop_reason === "max_tokens") {
    throw new Error("judgeSession: judge hit max_tokens — verdict truncated");
  }
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("judgeSession: no tool_use in judge response");
  }
  return block.input as SessionVerdict;
}

/**
 * One cast member's played-through session — the transcript kept so the SAME
 * kid's baseline and candidate runs can be paired for the pairwise promote gate
 * (adoptable #3). Collected per variant in evaluateVariant.
 */
type CastTranscript = {
  profileId: Id<"syntheticScholarProfiles">;
  name: string;
  readingLevel: string;
  dossier: string;
  traits: string[];
  archetype?: string;
  turns: SimTurn[];
  stopReason: StopReason;
};

/**
 * Opus PAIRWISE judge (adoptable #3) → which of two sessions (baseline vs
 * candidate, SAME cast member) better served the kid. Uses the SEPARATE
 * PAIRWISE_RUBRIC/PAIRWISE_TOOL, never the absolute judge. Order is RANDOMIZED
 * to avoid position bias (`assignPairwiseOrder`), the randomization recorded,
 * and the judge's raw A/B pick resolved back to candidate/baseline
 * (`resolvePairwiseWinner`). `rand` is injectable for deterministic tests.
 */
async function judgePairwise(
  ctx: ActionCtx,
  activity: SimActivity,
  profile: SimProfile,
  baselineTurns: SimTurn[],
  candidateTurns: SimTurn[],
  institutionId?: Id<"institutions"> | null,
  rand: () => number = Math.random,
): Promise<PairwiseComparison> {
  const { candidateLabel } = assignPairwiseOrder(rand());
  const transcriptA = candidateLabel === "A" ? candidateTurns : baselineTurns;
  const transcriptB = candidateLabel === "A" ? baselineTurns : candidateTurns;
  const res = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 500,
    system: PAIRWISE_RUBRIC,
    tools: [PAIRWISE_TOOL],
    tool_choice: { type: "tool", name: "record_pairwise_verdict" },
    messages: [
      {
        role: "user",
        content: formatPairwiseForJudge(activity, profile, transcriptA, transcriptB),
      },
    ],
  });
  await recordAnthropicUsage(ctx, {
    source: "curriculum-sim",
    role: ROLES.TEACHER,
    model: JUDGE_MODEL,
    usage: res.usage,
    institutionId,
  });
  if (res.stop_reason === "max_tokens") {
    throw new Error("judgePairwise: judge hit max_tokens — verdict truncated");
  }
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("judgePairwise: no tool_use in pairwise judge response");
  }
  const input = block.input as { winner?: unknown; reason?: unknown };
  const pick: "A" | "B" | "tie" =
    input.winner === "A" || input.winner === "B" ? input.winner : "tie";
  return {
    profileName: profile.name,
    readingLevel: profile.readingLevel,
    candidateLabel,
    pick,
    winner: resolvePairwiseWinner(pick, candidateLabel),
    reason: typeof input.reason === "string" ? input.reason : "",
  };
}

/**
 * Run the pairwise judge across the cast: pair the candidate's transcript with
 * the reference (baseline / champion) transcript for the SAME cast member (by
 * profileId) and ask which better served the kid. A per-member judge failure is
 * skipped (not fatal). Returns the comparisons (possibly empty — the caller
 * then degrades to the absolute gate).
 */
async function runPairwiseCast(
  ctx: ActionCtx,
  activity: SimActivity,
  referenceTs: CastTranscript[],
  candidateTs: CastTranscript[],
  institutionId?: Id<"institutions"> | null,
): Promise<PairwiseComparison[]> {
  const refByProfile = new Map(referenceTs.map((t) => [t.profileId, t]));
  const comparisons: PairwiseComparison[] = [];
  for (const cand of candidateTs) {
    const ref = refByProfile.get(cand.profileId);
    // Can only compare a member who played BOTH versions with real turns.
    if (!ref || ref.turns.length === 0 || cand.turns.length === 0) continue;
    try {
      const profile: SimProfile = {
        name: cand.name,
        readingLevel: cand.readingLevel,
        dossier: cand.dossier,
        traits: cand.traits,
        archetype: cand.archetype,
      };
      comparisons.push(
        await judgePairwise(
          ctx,
          activity,
          profile,
          ref.turns,
          cand.turns,
          institutionId,
        ),
      );
    } catch (err) {
      console.warn(
        `runPairwiseCast: skipping ${cand.name} after a failed pairwise judge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return comparisons;
}

/**
 * Decide promotion of `candidate` over `reference` (baseline in propose; the
 * champion in loop) by PAIRWISE preference, RETAINING the protected-dim veto
 * (isBetterPairwise reuses passesGate on the absolute aggregates). Robust: if no
 * pairwise comparison could be judged (all calls failed / no paired
 * transcripts), degrade to the absolute isBetter with a recorded note — never
 * crash the run. Returns the gating decision AND the persistable pairwise
 * summary for the results UI.
 */
async function decidePromotion(
  ctx: ActionCtx,
  activity: SimActivity,
  candidateAgg: Aggregate,
  referenceAgg: Aggregate,
  referenceTs: CastTranscript[],
  candidateTs: CastTranscript[],
  institutionId?: Id<"institutions"> | null,
): Promise<{ decision: PromotionDecision; pairwise: ExperimentPairwise }> {
  const comparisons = await runPairwiseCast(
    ctx,
    activity,
    referenceTs,
    candidateTs,
    institutionId,
  );
  if (comparisons.length === 0) {
    // Fall back to the absolute gate — the run must never crash on a flaky
    // pairwise judge (Finding-3 fix is a reliability upgrade, not a new SPOF).
    const abs = isBetter(candidateAgg, referenceAgg);
    return {
      decision: abs,
      pairwise: {
        ...tallyPairwise([]),
        decidedBy: "absolute-fallback",
        promote: abs.better,
        reason: abs.reason,
        note: "No pairwise comparisons could be judged (all calls failed or no paired transcripts) — fell back to the absolute fitness gate.",
      },
    };
  }
  const tally = tallyPairwise(comparisons);
  const res = isBetterPairwise(candidateAgg, referenceAgg, tally);
  return {
    decision: res,
    pairwise: {
      ...tally,
      decidedBy: "pairwise",
      promote: res.better,
      reason: res.reason,
    },
  };
}

/**
 * Opus Improver → one revised systemPrompt + rationale for `activity`, or
 * `null` when it produced no usable edit (callers degrade gracefully instead
 * of crashing createVariant with an undefined systemPrompt).
 */
async function runImprover(
  ctx: ActionCtx,
  activity: SimActivity,
  agg: Aggregate,
  diagnoses: ImproverDiagnosis[],
  institutionId?: Id<"institutions"> | null,
): Promise<ImproverProposal | null> {
  try {
    const res = await anthropic.messages.create({
      model: IMPROVER_MODEL,
      // A full revised systemPrompt (these activity prompts run 1–2.5KB) plus the
      // rationale plus Opus thinking easily exceed a small budget. Too low and the
      // tool-input JSON truncates mid-write → systemPrompt/rationale come back
      // undefined → Convex drops the undefined args → createVariant's validator
      // rejects the missing `systemPrompt`. Give it real room.
      max_tokens: 8000,
      system: IMPROVER_SYSTEM,
      tools: [IMPROVER_TOOL],
      tool_choice: { type: "tool", name: "propose_revision" },
      messages: [
        { role: "user", content: buildImproverUserMessage(activity, agg, diagnoses) },
      ],
    });
    await recordAnthropicUsage(ctx, {
      source: "curriculum-sim",
      role: ROLES.TEACHER,
      model: IMPROVER_MODEL,
      usage: res.usage,
      institutionId,
    });
    // Hit the token ceiling → the tool-input JSON is (or may be) truncated
    // mid-write. Even a non-empty partial `systemPrompt` is untrustworthy — a
    // half-written prompt must never become a promotable candidate. Treat as
    // "no usable edit" regardless of what partial string came back.
    if (res.stop_reason === "max_tokens") {
      console.warn(
        "runImprover: hit max_tokens — tool input likely truncated; proposing no edit this run",
      );
      return null;
    }
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      console.warn("runImprover: no tool_use in improver response — proposing no edit");
      return null;
    }
    // Guard the tool output. A proposal with no systemPrompt would, unguarded,
    // reach createVariant as an undefined arg → ArgumentValidationError. Treat
    // it as "no usable edit": return null and let callers keep the baseline
    // gracefully. Logged so a recurring problem stays visible.
    const input = block.input as Partial<ImproverProposal>;
    if (typeof input.systemPrompt !== "string" || !input.systemPrompt.trim()) {
      console.warn(
        `runImprover: no usable systemPrompt (stop_reason=${res.stop_reason}) — proposing no edit`,
      );
      return null;
    }
    return input as ImproverProposal;
  } catch (err) {
    // A failed Improver call (API error after the SDK's own retries) is not a
    // run-ending event: propose-mode keeps the baseline, loop-mode skips this
    // candidate slot. Degrade, don't crash the whole experiment.
    console.warn(
      `runImprover: improver call failed (${err instanceof Error ? err.message : String(err)}) — proposing no edit`,
    );
    return null;
  }
}

const OVERALL_VERDICT_SYSTEM = `You audited ONE activity for a Socratic AI tutor at ${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName} (a school for
GIFTED elementary scholars) by running a small, diverse cast of synthetic scholars through it.
You're given the aggregate scores and each scholar's individual verdict.

Write the OVERALL verdict in 1-2 sentences: does this activity, AS WRITTEN, work for this gifted
cast? Name the load-bearing strength and the single biggest soft spot, and end with one concrete
next step — the same plain, specific voice as the per-scholar verdicts. No preamble, no bullet
points, and don't just restate the numbers.`;

/**
 * One LLM "overall verdict" synthesizing how the whole cast fared on the
 * BASELINE activity — the cast-level twin of each session's judge `summary`,
 * shown as the headline of the results. Best-effort: a failed call returns
 * null and the UI just omits it (the scorecard still carries the numbers).
 */
async function synthesizeOverallVerdict(
  ctx: ActionCtx,
  activity: SimActivity,
  agg: Aggregate,
  verdicts: SessionVerdict[],
  institutionId?: Id<"institutions"> | null,
): Promise<string | null> {
  try {
    const perScholar = verdicts
      .map(
        (vd) =>
          `- goal ${vd.goalAttainment}/5, struggle ${vd.productiveStruggle}/5, depth ${vd.depth}/5 — ${vd.summary} (stall: ${vd.stallPoint}; traces to prompt: ${vd.promptAttribution})`,
      )
      .join("\n");
    const user = [
      `## Activity: ${activity.title}`,
      `Learning goal: ${activity.learningGoal}`,
      ``,
      `## Aggregate across the cast (n=${agg.n})`,
      `fitness ${agg.fitness.toFixed(2)}/5; ${Math.round(agg.goalAttainmentRate * 100)}% reached the goal`,
      `curriculum-fit — goal ${agg.dims.goalAttainment.toFixed(1)}, deliverable ${agg.dims.deliverableReach.toFixed(1)}, struggle ${agg.dims.productiveStruggle.toFixed(1)}`,
      `gifted — depth ${agg.dims.depth.toFixed(1)}, complexity ${agg.dims.complexity.toFixed(1)}, abstraction ${agg.dims.abstraction.toFixed(1)}, inquiry ${agg.dims.inquiry.toFixed(1)}, authenticity ${agg.dims.authenticity.toFixed(1)}`,
      ``,
      `## Per-scholar verdicts`,
      perScholar,
    ].join("\n");
    const res = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 400,
      system: OVERALL_VERDICT_SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    await recordAnthropicUsage(ctx, {
      source: "curriculum-sim",
      role: ROLES.TEACHER,
      model: JUDGE_MODEL,
      usage: res.usage,
      institutionId,
    });
    return textOf(res).trim() || null;
  } catch (err) {
    console.warn(
      `synthesizeOverallVerdict failed (${err instanceof Error ? err.message : String(err)}) — omitting`,
    );
    return null;
  }
}

/** Context coverage for a rehearsal run against master's actual sim fidelity
 *  (see convex/lib/curriculumSimShared.ts's SimActivity / getRunInput): the
 *  unit/lesson/deliverable are fully embedded in the tutor's system prompt,
 *  but activity resources and scholar deliverable "completion" tracking are
 *  not modeled by the sim, so those two layers are honestly "withheld"
 *  rather than claimed as tested. */
function preflightContextCoverage(): PreflightCoverage["context"] {
  return {
    unit: "included",
    lesson: "included",
    resources: "withheld",
    deliverable: "included",
    deliverableScoring: "included",
    completion: "withheld",
  };
}

function preflightPerScholarBlock(verdicts: SessionVerdict[]): string {
  return verdicts
    .map(
      (vd, i) =>
        `- Sim ${i + 1} (stop: ${vd.stopReason ?? "unknown"}) — socratic ${vd.socratic}/5, no-offloading ${vd.cognitiveOffloading}/5, no-spoilers ${vd.noSpoilers}/5, no-sycophancy ${vd.sycophancy}/5, age-fit ${vd.ageFit}/5, goal ${vd.goalAttainment}/5, deliverable ${vd.deliverableReach}/5, struggle ${vd.productiveStruggle}/5 — ${vd.summary} (stall: ${vd.stallPoint}; traces to prompt: ${vd.promptAttribution})`,
    )
    .join("\n");
}

/**
 * The structured Preflight findings result for the baseline cast — the
 * evidence-backed, editor-routable twin of `synthesizeOverallVerdict`'s plain
 * headline sentence. Best-effort: a failed/empty LLM call falls back to the
 * deterministic findings so the run never surfaces zero information.
 *
 * Deliberately excludes: a deterministic fabrication check (declined — the
 * judge has no `factualCorrectness` dimension on this codebase to duplicate)
 * and a per-dimension design/gifted floor scan (declined — uncalibrated,
 * single-cell judge noise). See curriculumPreflightResult.ts.
 */
async function synthesizePreflightResult(
  ctx: ActionCtx,
  activity: SimActivity,
  durationMinutes: number | null,
  base: {
    agg: Aggregate;
    verdicts: SessionVerdict[];
    probeCoverage: { completed: number; skipped: number };
    protectedFloorBreaches: NonNullable<
      PreflightCoverage["protectedFloorBreaches"]
    >;
  },
  institutionId?: Id<"institutions"> | null,
): Promise<PreflightResult> {
  const context = preflightContextCoverage();
  const stopReasons = base.verdicts.map((vd) => vd.stopReason ?? "goal");
  const coverage = preflightCoverage(
    base.agg.n,
    stopReasons,
    context,
    base.probeCoverage,
    undefined,
    "not-checked",
    base.protectedFloorBreaches,
    [], // every protected dim is a required judge field on this codebase — none go unchecked.
  );
  const deterministic = deterministicPreflightFindings({
    coverage,
    durationMinutes,
  });
  try {
    const user = [
      `## Activity: ${activity.title}`,
      `Learning goal: ${activity.learningGoal}`,
      ``,
      `## Per-sim evidence (n=${base.agg.n})`,
      preflightPerScholarBlock(base.verdicts),
    ].join("\n");
    const res = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 1600,
      system: PREFLIGHT_SYNTHESIS_SYSTEM,
      tools: [PREFLIGHT_SYNTHESIS_TOOL],
      tool_choice: { type: "tool", name: PREFLIGHT_SYNTHESIS_TOOL.name },
      messages: [{ role: "user", content: user }],
    });
    await recordAnthropicUsage(ctx, {
      source: "curriculum-sim",
      role: ROLES.TEACHER,
      model: JUDGE_MODEL,
      usage: res.usage,
      institutionId,
    });
    if (res.stop_reason === "max_tokens") {
      throw new Error("synthesizePreflightResult: hit max_tokens — truncated");
    }
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new Error("synthesizePreflightResult: no tool_use in response");
    }
    const normalized = normalizePreflightSynthesis(
      block.input as Record<string, unknown>,
      coverage,
    );
    if (!normalized) {
      throw new Error("synthesizePreflightResult: malformed synthesis output");
    }
    // backendCommit is left unset: this runtime has no reliable build-SHA
    // source to stamp (normalizeBackendCommit stays available for whenever
    // one exists, e.g. a future deploy-time env var).
    return {
      ...normalized,
      findings: [...deterministic, ...normalized.findings],
    };
  } catch (err) {
    console.warn(
      `synthesizePreflightResult failed (${err instanceof Error ? err.message : String(err)}) — falling back to deterministic findings`,
    );
    return fallbackPreflightResult(coverage, deterministic, "unavailable");
  }
}

/**
 * Phase 4 — judge REAL transcripts on the activity with the curriculum judge,
 * aggregate, and calibrate against the sim baseline. Records the calibration on
 * the experiment (or a "no real data" marker). Read-only w.r.t. the transcripts.
 */
export const runGrounding = internalAction({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    // Whole body is guarded: groundExperiment marks `grounding.status =
    // "running"` before scheduling us, so ANY unhandled throw (incl. from
    // getGroundInput) would strand that marker and permanently block
    // re-grounding. Record a terminal status on every path instead.
    try {
      const input = await ctx.runQuery(
        internal.curriculumExperiments.getGroundInput,
        { experimentId: args.experimentId },
      );
      const { activityId, activity, baselineAggregate, realSessions, scholarFeedback } =
        input;

      if (!baselineAggregate || realSessions.length === 0) {
        await ctx.runMutation(internal.curriculumExperiments.recordGrounding, {
          experimentId: args.experimentId,
          grounding: {
            status: "no-data",
            realN: realSessions.length,
            scholarFeedback,
            note:
              realSessions.length === 0
                ? "No real scholar transcripts on this activity yet — run it with a class first, then ground."
                : "No sim baseline to calibrate against.",
          },
        });
        return;
      }

      const simActivity: SimActivity = {
        title: activity.title,
        kind: activity.kind,
        systemPrompt: activity.systemPrompt,
        learningGoal: activity.learningGoal,
        deliverablePrompt: activity.deliverablePrompt,
        durationMinutes: activity.durationMinutes,
        unitDesign: activity.unitDesign,
      };
      const verdicts: SessionVerdict[] = [];
      const institutionIds = new Map<string, Id<"institutions"> | null>();
      const institutionFor = async (scholarId?: Id<"users">) => {
        if (!scholarId) return null;
        const key = String(scholarId);
        const cached = institutionIds.get(key);
        if (cached !== undefined) return cached;
        const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: scholarId,
          principal: "scholar",
        });
        institutionIds.set(key, institutionId);
        return institutionId;
      };
      // Adoptable #2 — keep the per-real-session verdicts (not just the
      // aggregate) so the judge's ranking of real sessions is reproducible and
      // a teacher can be correlated against it (judgeValidation).
      const perSession: {
        sessionId: Id<"sessions">;
        scholarId?: Id<"users">;
        profileName: string;
        readingLevel: string;
        verdict: SessionVerdict;
        fitness: number;
        goalAttainment: number;
        excerpt: string;
      }[] = [];
      for (const real of realSessions) {
        const turns = realMessagesToTranscript(real.messages);
        if (turns.length === 0) continue;
        const profile: SimProfile = {
          name: real.profileName,
          readingLevel: real.readingLevel,
          dossier: "(real scholar — dossier not loaded)",
          traits: [],
        };
        // Real transcripts carry no goal/stuck sentinel; judge as-is.
        // DELIBERATELY not stamping verdict.stopReason here: "maxTurns" below
        // is a placeholder, and stamping it would make aggregate() exclude
        // every real near-miss from the goal denominator, silently inflating
        // real goal rates. Real sessions count as fully run.
        const verdict = await judgeSession(
          ctx,
          simActivity,
          profile,
          turns,
          "maxTurns",
          await institutionFor(real.scholarId),
        );
        verdicts.push(verdict);
        perSession.push({
          sessionId: real.sessionId,
          scholarId: real.scholarId,
          profileName: real.profileName,
          readingLevel: real.readingLevel,
          verdict,
          // Single-session fitness (mean of the fitness dims) — the ranking
          // signal the teacher validation correlates against.
          fitness: aggregate([verdict]).fitness,
          goalAttainment: verdict.goalAttainment,
          excerpt: transcriptExcerpt(turns),
        });
      }
      if (perSession.length > 0) {
        await ctx.runMutation(
          internal.curriculumExperiments.recordGroundedVerdicts,
          {
            experimentId: args.experimentId,
            activityId,
            verdicts: perSession,
          },
        );
      }
      const realAgg = aggregate(verdicts);
      const calibration = calibrate(
        baselineAggregate as Aggregate,
        realAgg,
        0.75,
      );
      await ctx.runMutation(internal.curriculumExperiments.recordGrounding, {
        experimentId: args.experimentId,
        grounding: {
          status: "done",
          realAggregate: realAgg,
          scholarFeedback,
          ...calibration,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.curriculumExperiments.recordGrounding, {
        experimentId: args.experimentId,
        grounding: { status: "error", note: message },
      });
    }
  },
});

/**
 * The teacher-facing finalize message for a propose run, worded from the
 * pairwise decision (or the absolute fallback when pairwise couldn't run).
 */
function proposeMessage(promoted: boolean, pairwise: ExperimentPairwise): string {
  if (pairwise.decidedBy === "absolute-fallback") {
    return promoted
      ? "Proposed edit clears the gate (pairwise judge was unavailable — decided on absolute scores) — review the diff to promote."
      : `Held the baseline — ${pairwise.reason} (pairwise judge was unavailable — decided on absolute scores). The proposed diff is saved for review.`;
  }
  const tieSuffix = pairwise.ties ? `, ${pairwise.ties} tie` : "";
  return promoted
    ? `Cast prefers the proposed edit ${pairwise.candidateWins}–${pairwise.baselineWins}${tieSuffix} and it clears the gate — review the diff to promote.`
    : `Held the baseline — ${pairwise.reason}. The proposed diff is saved for review.`;
}

export const runExperiment = internalAction({
  args: { experimentId: v.id("curriculumExperiments") },
  handler: async (ctx, args) => {
    const input = await ctx.runQuery(
      internal.curriculumExperiments.getRunInput,
      { experimentId: args.experimentId },
    );
    const {
      activityId,
      activity,
      mode,
      maxTurns,
      generations,
      variantsPerGen,
      baselineVariantId,
      teacherId,
    } = input;
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: teacherId, principal: "staff" },
    );

    const baseActivity: SimActivity = {
      title: activity.title,
      kind: activity.kind,
      systemPrompt: activity.systemPrompt,
      learningGoal: activity.learningGoal,
      deliverablePrompt: activity.deliverablePrompt,
      durationMinutes: activity.durationMinutes,
      unitDesign: activity.unitDesign,
    };
    // Candidate target skills for the OUTCOME PROBE (adoptable #1); the probe
    // filters these to templated ones and skips gracefully when none resolve.
    const probeSkillKeys: string[] = activity.probeSkillKeys ?? [];

    // Global session counter (across every variant in the experiment) for the
    // reactive progress bar, plus a cache of each variant's diagnoses so the
    // Improver can read the PARENT's stalls when proposing a child, plus a cache
    // of each variant's per-cast transcripts so the pairwise promote gate
    // (adoptable #3) can pair a candidate's run against its reference's for the
    // SAME kid.
    const counter = { done: 0 };
    const diagByVariant = new Map<string, ImproverDiagnosis[]>();
    const transcriptsByVariant = new Map<string, CastTranscript[]>();

    const ensureRunning = async () => {
      const status = await ctx.runQuery(
        internal.curriculumExperiments.getStatus,
        { experimentId: args.experimentId },
      );
      if (status !== "running") throw new CancelledError();
    };

    /** Simulate + judge the whole cast against ONE variant's systemPrompt. */
    const evaluateVariant = async (
      variantId: Id<"curriculumVariants">,
      systemPrompt: string | null,
      generation: number,
    ): Promise<{
      agg: Aggregate;
      diagnoses: ImproverDiagnosis[];
      verdicts: SessionVerdict[];
      transcripts: CastTranscript[];
      probeCoverage: { completed: number; skipped: number };
      protectedFloorBreaches: NonNullable<
        PreflightCoverage["protectedFloorBreaches"]
      >;
    }> => {
      const {
        activity: variantActivity,
        cast,
        expectedCastCount,
        resolvedCastCount,
      } = await ctx.runQuery(
        internal.curriculumExperiments.assemblePromptsForVariant,
        { experimentId: args.experimentId, systemPrompt },
      );
      const verdicts: SessionVerdict[] = [];
      const diagnoses: ImproverDiagnosis[] = [];
      const transcripts: CastTranscript[] = [];
      // Preflight-only bookkeeping (never affects promotion/scoring): outcome-
      // probe completion for the coverage summary, and any per-sim PROTECTED_DIMS
      // score below the pre-existing calibrated absoluteFloor gate — this reuses
      // that gate rather than inventing a new uncalibrated per-dimension cap.
      const probeCoverage = { completed: 0, skipped: 0 };
      const protectedFloorBreaches: NonNullable<
        PreflightCoverage["protectedFloorBreaches"]
      > = [];

      for (const member of cast) {
        await ensureRunning();
        await ctx.runMutation(internal.curriculumExperiments.recordProgress, {
          experimentId: args.experimentId,
          sessionsDone: counter.done,
          generation,
          message: `Simulating ${member.name} (${member.readingLevel})…${generation > 0 ? ` — gen ${generation}` : ""}`,
        });
        // Light up the live feed (spinner + name) before the first turn lands.
        await ctx.runMutation(internal.curriculumExperiments.recordLiveTurn, {
          experimentId: args.experimentId,
          scholarName: member.name,
          scholarReadingLevel: member.readingLevel,
          transcript: [],
        });

        const profile: SimProfile = {
          name: member.name,
          readingLevel: member.readingLevel,
          dossier: member.dossier,
          traits: member.traits,
          archetype: member.archetype ?? undefined,
          misconception: member.misconception ?? undefined,
        };
        const simActivity: SimActivity = variantActivity;

        // One cast member that fails (the SDK already retries transient 5xx/429
        // — this catches what survives that) must NOT abort the whole multi-
        // minute run. Skip the member, keep the survivors. The slot still counts
        // toward the progress bar so it doesn't stall. Cancellation
        // (CancelledError from ensureRunning, above) is intentionally outside
        // this try so it still propagates.
        try {
          // PRE probe (cold) — before the session, so it reflects prior
          // knowledge. Same seed per member across variants → identical
          // held-out items, so the pre→post delta compares like-for-like.
          const pre = await runPreProbe(
            ctx,
            profile,
            probeSkillKeys,
            seedFromId(member.profileId),
            institutionId,
          );

          const { turns, stopReason } = await runSession(
            ctx,
            profile,
            simActivity,
            member.firstTurnPrompt,
            member.laterPrompt,
            maxTurns,
            // Stream each turn to the running view as it lands.
            async (live) => {
              await ctx.runMutation(
                internal.curriculumExperiments.recordLiveTurn,
                {
                  experimentId: args.experimentId,
                  scholarName: member.name,
                  scholarReadingLevel: member.readingLevel,
                  transcript: live,
                },
              );
            },
            institutionId,
          );
          const judgedVerdict = await judgeSession(
            ctx,
            simActivity,
            profile,
            turns,
            stopReason,
            institutionId,
          );
          const verdict: SessionVerdict = { ...judgedVerdict, stopReason };
          verdicts.push(verdict);
          for (const dim of PROTECTED_DIMS) {
            const value = verdict[dim];
            if (typeof value === "number" && value < DEFAULT_GATE.absoluteFloor) {
              protectedFloorBreaches.push({
                profileName: member.name,
                dimension: dim,
                value,
                floor: DEFAULT_GATE.absoluteFloor,
              });
            }
          }
          // Keep this member's transcript for the pairwise promote gate — the
          // SAME kid's baseline vs candidate runs get paired later.
          transcripts.push({
            profileId: member.profileId,
            name: member.name,
            readingLevel: member.readingLevel,
            dossier: member.dossier,
            traits: member.traits,
            archetype: member.archetype ?? undefined,
            turns,
            stopReason,
          });
          diagnoses.push({
            name: member.name,
            readingLevel: member.readingLevel,
            stopReason,
            goalAttainment: verdict.goalAttainment,
            productiveStruggle: verdict.productiveStruggle,
            stallPoint: verdict.stallPoint,
            promptAttribution: verdict.promptAttribution,
          });

          // POST probe (with the finished transcript in context), then grade
          // both halves deterministically. Only runs when the PRE probe landed.
          let probe: ProbeSummary | null = null;
          let probeSkipReason: string | null = pre.skipReason;
          if (pre.preAnswers) {
            const post = await runPostProbe(
              ctx,
              profile,
              pre.pairs,
              pre.preAnswers,
              {
                activityTitle: baseActivity.title,
                transcript: turns,
              },
              institutionId,
            );
            probe = post.probe;
            probeSkipReason = post.skipReason;
          }
          if (probe) probeCoverage.completed += 1;
          else probeCoverage.skipped += 1;

          await ctx.runMutation(internal.curriculumExperiments.recordSession, {
            experimentId: args.experimentId,
            variantId,
            profileId: member.profileId,
            transcript: turns,
            stopReason,
            verdict,
            goalReached: verdict.goalAttainment >= 4,
            probe: probe ?? undefined,
            probeSkipReason: probeSkipReason ?? undefined,
          });
        } catch (err) {
          console.warn(
            `curriculumSim: skipping cast member ${member.name} after a failed session/judge: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        counter.done += 1;
      }

      // Every session failed — a transient model/API issue, not a real score.
      // Don't aggregate an empty cast to fitness 0 (that would make a broken
      // baseline look terrible and every candidate look like an improvement).
      // Surface it as a clean failure instead.
      if (verdicts.length === 0) {
        throw new Error(
          `All ${cast.length} cast sessions failed for this variant — likely a transient model/API issue, so there is nothing to score. Try again.`,
        );
      }

      const agg = aggregate(verdicts, {
        expectedN: expectedCastCount,
        resolvedN: resolvedCastCount,
      });
      await ctx.runMutation(internal.curriculumExperiments.recordVariantScores, {
        variantId,
        aggregateScores: agg,
      });
      diagByVariant.set(variantId, diagnoses);
      transcriptsByVariant.set(variantId, transcripts);
      return {
        agg,
        diagnoses,
        verdicts,
        transcripts,
        probeCoverage,
        protectedFloorBreaches,
      };
    };

    try {
      // gen 0 — baseline (every mode evaluates this).
      const base = await evaluateVariant(baselineVariantId, activity.systemPrompt, 0);
      // The cast-level "overall verdict" — one LLM synthesis of the baseline
      // run, shown as the results headline (the deterministic progress message
      // stays as the live status). Best-effort; null on failure.
      const overallVerdict = await synthesizeOverallVerdict(
        ctx,
        baseActivity,
        base.agg,
        base.verdicts,
        institutionId,
      );
      // The structured, editor-routable findings twin of overallVerdict above —
      // always computed on the baseline cast (never the candidate/champion), so
      // "Fix this" always routes off the SAME run the teacher is looking at.
      const preflightResult = await synthesizePreflightResult(
        ctx,
        baseActivity,
        activity.durationMinutes,
        base,
        institutionId,
      );

      if (mode === "analyze") {
        await ctx.runMutation(internal.curriculumExperiments.finalize, {
          experimentId: args.experimentId,
          variantId: baselineVariantId,
          aggregateScores: base.agg,
          status: "done",
          overallVerdict: overallVerdict ?? undefined,
          preflightResult,
          message: `Done — ${Math.round(base.agg.goalAttainmentRate * 100)}% reached the goal (fitness ${base.agg.fitness.toFixed(2)}/5 across ${base.agg.n} kids).`,
        });
        return;
      }

      // propose + loop insert candidate variants against this activity.
      const activityIdForVariants = activityId;

      if (mode === "propose") {
        const proposal = await runImprover(
          ctx,
          { ...baseActivity, systemPrompt: activity.systemPrompt },
          base.agg,
          base.diagnoses,
          institutionId,
        );
        if (!proposal) {
          await ctx.runMutation(internal.curriculumExperiments.finalize, {
            experimentId: args.experimentId,
            variantId: baselineVariantId,
            status: "done",
            overallVerdict: overallVerdict ?? undefined,
            preflightResult,
            message:
              "The Improver didn't return a usable edit this run — kept the baseline. Try again.",
          });
          return;
        }
        const candId = await ctx.runMutation(
          internal.curriculumExperiments.createVariant,
          {
            experimentId: args.experimentId,
            activityId: activityIdForVariants,
            parentVariantId: baselineVariantId,
            generation: 1,
            systemPrompt: proposal.systemPrompt,
            rationale: proposal.rationale,
          },
        );
        const cand = await evaluateVariant(candId, proposal.systemPrompt, 1);
        // Adoptable #3 — decide PROMOTION by pairwise preference (baseline vs
        // candidate, same kid, order randomized), retaining the protected-dim
        // veto. The absolute aggregates are still computed + stored above for
        // the teacher's diagnosis view (DeltaTable / scorecard).
        const { decision, pairwise } = await decidePromotion(
          ctx,
          baseActivity,
          cand.agg,
          base.agg,
          base.transcripts,
          cand.transcripts,
          institutionId,
        );
        await ctx.runMutation(internal.curriculumExperiments.finalize, {
          experimentId: args.experimentId,
          variantId: decision.better ? candId : baselineVariantId,
          status: "done",
          overallVerdict: overallVerdict ?? undefined,
          preflightResult,
          pairwise,
          message: proposeMessage(decision.better, pairwise),
        });
        return;
      }

      // mode === "loop" — hill-climb.
      const result = await optimize(
        { id: baselineVariantId, systemPrompt: activity.systemPrompt, generation: 0 },
        base.agg,
        {
          evaluate: async (variant: OptVariant) => {
            const e = await evaluateVariant(
              variant.id as Id<"curriculumVariants">,
              variant.systemPrompt,
              variant.generation,
            );
            return e.agg;
          },
          propose: async (parent: OptVariant, parentAgg: Aggregate) => {
            const diags = diagByVariant.get(parent.id) ?? [];
            const proposal = await runImprover(
              ctx,
              { ...baseActivity, systemPrompt: parent.systemPrompt },
              parentAgg,
              diags,
              institutionId,
            );
            // No usable edit → tell the optimizer to skip this candidate slot
            // (not a failure; it logs and moves on).
            if (!proposal) return null;
            const id = await ctx.runMutation(
              internal.curriculumExperiments.createVariant,
              {
                experimentId: args.experimentId,
                activityId: activityIdForVariants,
                parentVariantId: parent.id as Id<"curriculumVariants">,
                generation: parent.generation + 1,
                systemPrompt: proposal.systemPrompt,
                rationale: proposal.rationale,
              },
            );
            return {
              id,
              systemPrompt: proposal.systemPrompt,
              generation: parent.generation + 1,
            };
          },
          // Adoptable #3 — drive each PROMOTION decision (candidate vs the
          // current champion) by pairwise preference instead of absolute
          // fitness, retaining the protected-dim veto. Transcripts for both
          // sides are cached by variant id in evaluateVariant. Degrades to the
          // absolute gate if the pairwise judge can't run (decidePromotion).
          decide: async ({ candidate, candidateAgg, champion, championAgg }) => {
            const { decision } = await decidePromotion(
              ctx,
              baseActivity,
              candidateAgg,
              championAgg,
              transcriptsByVariant.get(champion.id) ?? [],
              transcriptsByVariant.get(candidate.id) ?? [],
              institutionId,
            );
            return decision;
          },
          shouldStop: async () => {
            const status = await ctx.runQuery(
              internal.curriculumExperiments.getStatus,
              { experimentId: args.experimentId },
            );
            return status !== "running";
          },
          onProgress: async (msg, generation) => {
            await ctx.runMutation(
              internal.curriculumExperiments.recordProgress,
              {
                experimentId: args.experimentId,
                sessionsDone: counter.done,
                generation,
                message: msg,
              },
            );
          },
        },
        {
          generations: generations ?? 2,
          variantsPerGen: variantsPerGen ?? 1,
          // Stop gracefully (keep the best so far) before this single "use node"
          // action risks its runtime limit — checked before each generation and
          // each candidate, so worst-case overrun is one in-flight cast eval.
          maxDurationMs: 7 * 60 * 1000,
        },
      );

      const improved = result.best.variant.id !== baselineVariantId;
      const stopPhrase: Record<typeof result.stoppedReason, string> = {
        generations: "all generations done",
        plateau: "plateau",
        budget: "eval budget reached",
        timeBudget: "time budget reached",
        cancelled: "cancelled",
      };
      const why = stopPhrase[result.stoppedReason] ?? result.stoppedReason;
      // For the results view, compute ONE final pairwise comparison of the
      // champion against the gen-0 baseline (the "where we started → where we
      // landed" the teacher cares about). The per-generation promotions above
      // were judged candidate-vs-champion; this is the headline. Skipped when no
      // variant beat the baseline (nothing to compare).
      let loopPairwise: ExperimentPairwise | undefined;
      if (improved) {
        const { pairwise } = await decidePromotion(
          ctx,
          baseActivity,
          result.best.agg,
          base.agg,
          base.transcripts,
          transcriptsByVariant.get(result.best.variant.id) ?? [],
          institutionId,
        );
        loopPairwise = pairwise;
      }
      const castPref =
        loopPairwise && loopPairwise.decidedBy === "pairwise"
          ? ` — cast prefers it ${loopPairwise.candidateWins}–${loopPairwise.baselineWins}${loopPairwise.ties ? `, ${loopPairwise.ties} tie` : ""} vs the baseline`
          : "";
      await ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId: args.experimentId,
        variantId: result.best.variant.id as Id<"curriculumVariants">,
        status: "done",
        overallVerdict: overallVerdict ?? undefined,
        preflightResult,
        pairwise: loopPairwise,
        message: improved
          ? `Loop done (${why}) — champion clears the gate across ${result.evaluations} cast-runs${castPref}. Review the diff to promote.`
          : `Loop done (${why}) — no variant beat the baseline; kept the current activity.`,
      });
    } catch (err) {
      if (err instanceof CancelledError) return; // cancel already set the state
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.curriculumExperiments.finalize, {
        experimentId: args.experimentId,
        variantId: baselineVariantId,
        status: "failed",
        error: message,
        message: `Experiment failed: ${message}`,
      });
    }
  },
});
