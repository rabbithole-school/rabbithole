/**
 * Canonical Rehearse judge rubric, tool contract, and payload formatter.
 *
 * Pure by design: product actions and offline evals import this exact ruler
 * without pulling in an SDK, Convex runtime, filesystem, or environment.
 */
import {
  ALL_DIMENSION_KEYS,
  DESIGN_DIMS,
  DIMENSION_TOOL_DESCRIPTIONS,
} from "./curriculumDimensions";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "./primaryInstitutionPromptProfile";
import type {
  SimActivity,
  SimProfile,
  SimTurn,
  StopReason,
} from "./curriculumSimShared";

export const INVESTIGATION_BAR_RUBRIC = `INVESTIGATION BAR (DESIGN — measured, not gating):
Judge the DESIGN (activity structure + tutor systemPrompts + deliverables) first, transcript as
evidence of how it played; a dimension is not satisfied by topic appeal — only by design
structure.
- singleSpine — Does every activity visibly advance ONE conceptual through-line? 5 = one spine,
  each activity a step on it; 1 = a grab-bag tour of subtopics.
- discoveryArc — Does the scholar DERIVE the central idea (from data, pattern, or failed
  prediction) BEFORE it is named/explained? 5 = name arrives as payoff after derivation; 1 =
  concept stated up front, then practiced.
- handsOnMission — Does the quest include a real away-from-screen mission
  (measure/count/build/tally with real objects) whose results feed later work? 5 = mission
  present, results load-bearing; 3 = gestured at but optional / results unused; 1 = fully
  screen-bound.
- earnedPayoff — Is there an engineered surprise (inversion, hidden identity, data overruling
  intuition) that the design sets up (gap/bet/prediction first)? 5 = gap opened early, payoff
  lands; 1 = no gap, no surprise, praise as ending.`;

export const JUDGE_RUBRIC = `You are auditing one simulated tutoring session at ${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName} (a school for
GIFTED elementary scholars; Socratic pedagogy: scholars do the thinking). A synthetic scholar
with a defined profile played through a specific ACTIVITY against the live AI tutor. You are
judging whether the ACTIVITY (its instructions to the tutor) did its job for THIS kind of kid
— not grading the kid.

You get: the full unit design (activity structure + tutor systemPrompts + deliverables), the
activity title + its stated learning goal + deliverable, the synthetic scholar's profile, and
the full transcript.

Score 1–5, 5 = best. Use the full range; don't default to 3. "Absence-of" means 5 = the bad
thing is absent. Judge every dimension RELATIVE TO THIS SCHOLAR'S LEVEL — a 5 for a
Kindergartner looks different than a 5 for a 5th grader.

THE TURN CAP IS A SIMULATION ARTIFACT, NOT A REAL CONSTRAINT. Real scholars have no limit on
back-and-forth; this rig caps the conversation. So: do NOT lower any score because a session
ended at the cap ("Session ended: maxTurns") while still making real progress — judge the
trajectory and depth, not whether the kid crossed the finish line within an arbitrary number
of turns. And FASTER IS NOT BETTER: an activity that reaches the goal by rushing the kid,
over-hinting, or thinning the thinking is WORSE, not better — score it LOW on
productiveStruggle and the gifted dims.

TOOL MARKERS ARE REAL ARTIFACTS, NOT BROKEN OUTPUT. The transcript may contain bracketed
markers like "[The tutor generated an image and showed it to the scholar here.]" or
"[The tutor built a small interactive widget and showed it to the scholar here.]". In
production the tutor genuinely renders these (a diagram, an interactive). The eval rig can't
run the tools, so the marker stands in for the artifact the scholar actually saw. Treat it as
a successful, helpful render: judge the pedagogy AROUND it (did the visual serve discovery, or
spoil it?) — NEVER penalize the marker as if the tutor dumped text, malfunctioned, or went
off-task.

CURRICULUM-FIT (what we're trying to improve):
- goalAttainment: did the scholar reach genuine understanding of the learning goal (in their
  own words, not parroted) — or, if cut off by the turn cap, were they soundly and visibly
  progressing toward it? Score whether any claim of understanding was EARNED: reward a
  transcript where the kid ARTICULATED the idea in their own words — explained what they now
  understand and WHY, made it their own — before declaring they were done. Heavily PENALIZE a
  hollow, parroted, or unexplained sign-off ("I get it" / "makes sense" / "I'm done") that the
  transcript doesn't actually back up: a confident declaration with nothing demonstrated behind
  it is a 1–2, not a 5. 5 = clearly understood AND able to put it in their own words (or clearly
  almost there). 1 = ended no closer than they started, or declared an understanding they never
  demonstrated.
- deliverableReach: did they produce/describe the deliverable to its intent? 5 = yes,
  on-target. 1 = never got near it. (If no deliverable, score 3 and say so.)
- productiveStruggle: was the challenge level right for THIS capable kid — genuinely
  stretched, doing real thinking at the edge of their ability? 5 = real productive struggle.
  1 = either coasting because it was trivially easy for them, OR so confusing they shut down.
  For a gifted scholar, too-easy is as much a failure as too-hard.

GIFTED-CURRICULUM (Carl's five hallmarks — what makes this a GIFTED activity rather than a
general-ed one; score relative to the scholar's grade):
- depth: did the activity push past surface facts into patterns, causes, underlying
  structure, or genuinely open/unanswered questions? 5 = real grappling with why/how/what-if.
  1 = stayed at recall, labeling, or one-step facts.
- complexity: did it hold more than one thing at once — multiple perspectives, competing
  evidence, trade-offs, or connections across domains? 5 = the kid had to weigh/relate
  several things. 1 = single, isolated, one-variable.
- abstraction: did it connect the concrete task to a transferable big idea/concept (system,
  change, adaptation, resilience, power, identity…), keeping the big idea big? 5 = the kid
  touched the underlying concept, not just the instance. 1 = wholly concrete, no bridge to a
  bigger idea. (Even young kids can name a big idea simply.)
- inquiry: did the kid function as an investigator — asking real questions, forming and
  testing ideas, producing something original — rather than receiving and confirming what the
  tutor fed? 5 = the kid drove the investigation. 1 = consumed/recited.
- authenticity: was the work anchored to a real problem, real context, or a genuine
  product/audience — not contrived busywork? 5 = real and consequential. 1 = an exercise with
  no stakes beyond "the activity".

PROTECTED (tutor behavior must not be sacrificed to hit the goal):
- socratic: tutor turned thinking back to the scholar. 5 = genuine questions. 1 = lectured.
- cognitiveOffloading (absence-of): 5 = scaffolded, left the work to the kid. 1 = did the
  thinking / handed answers.
- noSpoilers (absence-of): 5 = preserved the discovery. 1 = revealed the destination.
- sycophancy (absence-of): 5 = neutral/respectful. 1 = empty praise / flattery every turn.
- ageFit: vocabulary/sentences matched the scholar's reading level. 5 = matched. 1 = off.

${INVESTIGATION_BAR_RUBRIC}

DIAGNOSIS (free text, terse, quote the load-bearing moment):
- stallPoint: the single turn/spot where the kid lost the thread or disengaged, and why; or
  "none" if they flowed to the goal.
- promptAttribution: of what went wrong, what traces to THIS ACTIVITY's instructions (e.g.
  "the prompt told the tutor to wait for a number, so a kid who drew the answer got stuck")
  vs. the base tutor. This is the signal for editing the activity. "none" if nothing went
  wrong.
- summary: one sentence — would this activity, as written, work for this kind of gifted kid?`;

const numericProperties = Object.fromEntries(
  ALL_DIMENSION_KEYS.map((key) => [
    key,
    {
      type: "integer" as const,
      description: DIMENSION_TOOL_DESCRIPTIONS[key],
    },
  ]),
);

export const JUDGE_TOOL = {
  name: "record_session_verdict" as const,
  description:
    "Record the curriculum-fit + gifted-lens + protected-dim + investigation-bar judgment for one simulated session.",
  input_schema: {
    type: "object" as const,
    required: [
      ...ALL_DIMENSION_KEYS,
      "stallPoint",
      "promptAttribution",
      "summary",
    ],
    properties: {
      ...numericProperties,
      stallPoint: { type: "string" as const },
      promptAttribution: { type: "string" as const },
      summary: { type: "string" as const },
    },
  },
};

const designNumericProperties = Object.fromEntries(
  DESIGN_DIMS.map((key) => [
    key,
    {
      type: "integer" as const,
      description: DIMENSION_TOOL_DESCRIPTIONS[key],
    },
  ]),
);

export const DESIGN_JUDGE_RUBRIC = `You are auditing the baked design of one real QUEST at
${PRIMARY_INSTITUTION_PROMPT_PROFILE.schoolName}, a school for gifted elementary scholars. Score the design itself, not a
scholar and not a simulated or real transcript. Use the full 1–5 range; do not invent evidence
that is absent from the design.

${INVESTIGATION_BAR_RUBRIC}

DIAGNOSIS
- designDiagnosis: one sentence naming the strongest load-bearing design choice and the most
  important weakness.`;

export const DESIGN_JUDGE_TOOL = {
  name: "record_design_verdict" as const,
  description:
    "Record the four-dimension investigation-bar judgment for one baked QUEST design.",
  input_schema: {
    type: "object" as const,
    required: [...DESIGN_DIMS, "designDiagnosis"],
    properties: {
      ...designNumericProperties,
      designDiagnosis: { type: "string" as const },
    },
  },
};

export function formatUnitDesignForJudge(title: string, design: string): string {
  return [`## QUEST: ${title}`, "", "## Unit design", design].join("\n");
}

function markerFor(tool: string): string {
  switch (tool) {
    case "generate_image":
      return "[The tutor generated an image and showed it to the scholar here.]";
    case "create_code":
      return "[The tutor built a small interactive widget and showed it to the scholar here.]";
    case "edit_document":
      return "[The tutor updated the scholar's document here.]";
    case "update_rubric_score":
      return "[The tutor checked the scholar's work against the rubric here.]";
    case "update_process_step":
      return "[The tutor advanced the activity to its next step here.]";
    case "set_activity_angle":
      return "[The tutor recorded the scholar's chosen angle for the activity here.]";
    case "web_search":
    case "web_fetch":
      return "[The tutor looked something up on the web here.]";
    default:
      return `[The tutor used a tool (${tool}) here.]`;
  }
}

const KNOWN_TOOLS = [
  "generate_image",
  "create_code",
  "edit_document",
  "update_rubric_score",
  "update_process_step",
  "set_activity_angle",
  "update_dossier",
  "web_search",
  "web_fetch",
];

export function sanitizeToolText(content: string): string {
  let out = content;
  out = out.replace(
    /<(?:antml:)?invoke\s+name="([^"]+)"[\s\S]*?<\/(?:antml:)?invoke>/g,
    (_match, name: string) => markerFor(name),
  );
  for (const tool of KNOWN_TOOLS) {
    const re = new RegExp(`${tool}\\s*\\(\\s*\\{[\\s\\S]*?\\}\\s*\\)`, "g");
    out = out.replace(re, markerFor(tool));
  }
  out = out
    .replace(/<\/?(?:antml:)?function_calls>/g, "")
    .replace(/<\/?(?:antml:)?invoke[^>]*>/g, "")
    .replace(/<\/?(?:antml:)?parameter[^>]*>/g, "");
  out = out.replace(
    /\*?\[\s*(?:generating|creating|drawing|building|making|rendering)\b[^\]]*\]\*?/gi,
    markerFor("generate_image"),
  );
  return out
    .replace(/(\[The tutor[^\]]*\])(\s*\1)+/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeTurns<T extends { content: string }>(turns: T[]): T[] {
  return turns.map((turn) => ({
    ...turn,
    content: sanitizeToolText(turn.content),
  }));
}

export function formatSessionForJudge(
  activity: SimActivity,
  profile: SimProfile,
  turns: SimTurn[],
  stopReason: StopReason,
): string {
  const convo = turns
    .map(
      (turn) =>
        `[${turn.role === "tutor" ? "TUTOR" : "SCHOLAR"}] ${sanitizeToolText(turn.content)}`,
    )
    .join("\n\n");
  return [
    `## Activity: ${activity.title} (${activity.kind})`,
    `Learning goal: ${activity.learningGoal}`,
    activity.deliverablePrompt
      ? `Deliverable: ${activity.deliverablePrompt}`
      : "Deliverable: (none)",
    "",
    "## Unit design",
    activity.unitDesign ??
      [
        `Activity: ${activity.title} (${activity.kind})`,
        `System prompt: ${activity.systemPrompt ?? "(none)"}`,
        `Deliverable: ${activity.deliverablePrompt ?? "(none)"}`,
      ].join("\n"),
    "",
    `## Synthetic scholar: ${profile.name} — reading level ${profile.readingLevel}`,
    `Profile: ${profile.dossier}`,
    `Traits: ${profile.traits.join("; ") || "none"}`,
    `Session ended: ${stopReason}`,
    "",
    "## Transcript",
    convo,
  ].join("\n");
}
