/**
 * Pure Improver prompt/parsing helpers for the self-improving-curricula loop —
 * the product-side twin of evals/curriculum-sim/lib/improver.ts (kept in sync;
 * same SYSTEM prompt, tool, and user-message assembly). No Convex imports, no
 * SDK, no I/O: just string assembly, so it's importable from the "use node"
 * orchestrator action AND unit-testable on its own.
 *
 * The Improver reads how a variant fared across the cast (aggregate + each
 * session's stallPoint / promptAttribution) and proposes ONE concrete edit to
 * the activity's systemPrompt, with a rationale tied to specific failures. The
 * HARD RULES discourage reward-hacking (give answers / flatter / over-scaffold)
 * — belt-and-suspenders with the mechanical protected-dim gate in
 * curriculumScore.ts, which rejects such a candidate even if the prompt fails.
 */
import type { Aggregate } from "./curriculumScore";
import type { SimActivity } from "./curriculumSimShared";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";

export const IMPROVER_SYSTEM = `You are a curriculum designer improving ONE activity for a Socratic AI tutor at
${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName} (a school for GIFTED elementary scholars). You are given:
- the activity's title, FIXED learning goal, deliverable, and current tutor systemPrompt
- aggregate scores from simulating a diverse cast of synthetic scholars through it
- per-scholar diagnoses: where each kid stalled and which failures trace to THIS prompt

Propose ONE concrete revision of the activity's systemPrompt (and, only if needed, the
deliverable framing) that should help more kids reach the SAME learning goal — especially the
ones who stalled.

THE DIRECTION OF A GOOD EDIT IS DEEPER, NOT EASIER. This is a gifted school. Every edit
should move the activity toward MORE of Carl's five hallmarks — Depth, Complexity,
Abstraction, Inquiry, Authenticity — never less:
- Depth: surface the patterns, causes, and open questions under the topic.
- Complexity: invite multiple perspectives, competing evidence, or cross-domain links.
- Abstraction: connect the concrete task to a transferable big idea; keep the big idea big.
- Inquiry: have the kid investigate, hypothesize, test, and produce — not receive and recite.
- Authenticity: anchor the work to a real problem, context, or audience.
When a kid stalls, fix it with BETTER SCAFFOLDING INTO the deep version (a more concrete entry
point, a clearer first step, accepting more forms of an answer) — never by removing the
challenge, ambiguity, or open-endedness that makes it a gifted activity.

HARD RULES:
- Do NOT change the learning goal. Do NOT make the goal easier, vaguer, or shallower.
- Do NOT fix stalls by telling the tutor to give answers, reveal the discovery, over-scaffold
  into one-word prompts, or praise the scholar. That trades a real win for a fake one and will
  be rejected. Keep it genuinely Socratic.
- Do NOT optimize for the simulation rig. NEVER add instructions to hurry, be efficient, move
  faster, wrap up, save time, limit the back-and-forth, or reference any cap on the number of
  turns/messages. Real scholars are not on a turn budget — the sim's turn cap is a measurement
  artifact. An edit that helps the synthetic kid finish within the cap but rushes a real
  scholar or thins the thinking is a REGRESSION, not an improvement, and will be rejected.
- Edit surgically. Keep what worked; change what the diagnoses point at. Prefer the smallest
  edit that addresses the actual stall (e.g. "accept a drawing, not just a number").
- Your rationale must cite the specific stall/attribution it addresses.`;

export const IMPROVER_TOOL = {
  name: "propose_revision" as const,
  description: "Propose one revised activity systemPrompt + rationale.",
  input_schema: {
    type: "object" as const,
    required: ["systemPrompt", "rationale"],
    properties: {
      systemPrompt: {
        type: "string" as const,
        description: "The full revised tutor systemPrompt for this activity.",
      },
      deliverablePrompt: {
        type: ["string", "null"] as const,
        description: "Revised deliverable framing, or null to leave unchanged.",
      },
      rationale: {
        type: "string" as const,
        description:
          "Why this edit, citing the specific stalls/attributions it addresses.",
      },
    },
  },
};

/** One per-scholar diagnosis the Improver reasons over. */
export interface ImproverDiagnosis {
  name: string;
  readingLevel: string;
  stopReason: string;
  goalAttainment: number;
  productiveStruggle: number;
  stallPoint: string;
  promptAttribution: string;
}

/** The Improver's structured output (the propose_revision tool input). */
export interface ImproverProposal {
  systemPrompt: string;
  deliverablePrompt?: string | null;
  rationale: string;
}

/** Assemble the Improver's user message from how the variant fared. */
export function buildImproverUserMessage(
  activity: SimActivity,
  agg: Aggregate,
  diagnoses: ImproverDiagnosis[],
): string {
  const lines = diagnoses
    .map(
      (d) =>
        `- ${d.name} (${d.readingLevel}, ${d.stopReason}): goal ${d.goalAttainment}/5, struggle ${d.productiveStruggle}/5. stall: ${d.stallPoint}. attribution: ${d.promptAttribution}`,
    )
    .join("\n");
  return [
    `## Activity: ${activity.title}`,
    `FIXED learning goal: ${activity.learningGoal}`,
    `Deliverable: ${activity.deliverablePrompt ?? "(none)"}`,
    ``,
    `## Current systemPrompt`,
    activity.systemPrompt ?? "(empty)",
    ``,
    `## Aggregate across cast (n=${agg.n})`,
    `fitness ${agg.fitness.toFixed(2)}/5, goal-reached ${(agg.goalAttainmentRate * 100).toFixed(0)}% of ${agg.goalRateN ?? agg.n} counted${(agg.goalTruncatedN ?? 0) > 0 ? ` (${agg.goalTruncatedN} hit the turn cap before showing goal evidence — excluded, not failed)` : ""}`,
    `deliverableReach ${agg.dims.deliverableReach.toFixed(2)}, productiveStruggle ${agg.dims.productiveStruggle.toFixed(2)}`,
    `gifted lens — depth ${agg.dims.depth.toFixed(2)}, complexity ${agg.dims.complexity.toFixed(2)}, abstraction ${agg.dims.abstraction.toFixed(2)}, inquiry ${agg.dims.inquiry.toFixed(2)}, authenticity ${agg.dims.authenticity.toFixed(2)} (these are GUARDED — your edit may not lower them)`,
    ``,
    `## Per-scholar diagnoses`,
    `(stopReason "maxTurns" = the kid ran out of SIMULATED turns, not a failure — they may have been progressing fine. Do NOT "fix" this by making the tutor faster; real scholars have no turn limit.)`,
    lines,
  ].join("\n");
}
