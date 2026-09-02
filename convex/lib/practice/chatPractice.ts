/**
 * Problems-in-chat (⑮ / roadmap §8 Pattern 3) — the pure core.
 *
 * The tutor may, at the right moment, drop an INLINE interactive practice item
 * into the chat stream (a compact "solve this" widget the scholar answers in
 * place). This is the HIGHEST-RISK tutor integration in the roadmap: the risk
 * is *pedagogical*, not technical — an inline item invites the tutor to flip
 * productive-struggle order into "lecture → test" or to over-quiz. So it ships
 * behind a gate and gates on a judged prompt-eval (evals/problems-in-chat/),
 * exactly like the ⑫ Socratic handoff did (see ./handoff.ts).
 *
 * This module is the safety/behavior core, deliberately kept pure (no Convex /
 * React deps) so the eval harness imports the SAME text that ships — the thing
 * measured is the thing served, they cannot drift:
 *   - `chatPracticeEnabled()` — the kill-switch (CHAT_PRACTICE_ENABLED, OFF by
 *     default). Gates BOTH the tutor-prompt section and the tool being offered.
 *   - `buildChatPracticeSection` — the tutor-visible prompt section (when + how
 *     to offer an item; probe-first, retrieval-practice framing). Labels only —
 *     it inherits Pattern 1's redaction contract (no skillKeys, no rep counts).
 *   - `SERVE_PRACTICE_PROBLEM_TOOL` — the tool spec the tutor calls.
 *   - `resolveChatPracticeSkill` — maps the tutor's free-text `skill` argument
 *     to a concrete servable skillKey (so skillKeys stay OUT of the prompt).
 *   - `serveChatItem` — resolves a template, stored word item, or curated
 *     manipulative through the unified ServableItem builders.
 *     The correct answer is NEVER produced here; it is re-derived by the
 *     surface-specific grade mutation and only echoed on a CORRECT submission.
 */

import { makeItemId } from "./session";
import { servedItemFromServable } from "./serve";
import {
  buildStoredServable,
  buildTemplateServable,
  type ServableItem,
  type StoredPracticeItem,
} from "./servable";
import { hasTemplate } from "./templates";
import type { PracticePromptVisual } from "../../../shared/practicePromptVisual";
import { MANIPULATIVE_VERIFIER_KIND } from "../../../lib/manipulative/practiceContract";

// ── The gate ──────────────────────────────────────────────────────────────

/**
 * Is problems-in-chat live for the tutor? Reads CHAT_PRACTICE_ENABLED
 * (Convex deployment env). Fail-safe default OFF: an unset / "false" / "0" /
 * empty value keeps the tutor exactly as it is today. Only an explicit "true"
 * / "1" / "on" turns it on — set that LOCALLY for the eval / an E2E test, never
 * on prod until the eval passes and the owner signs off.
 */
export function chatPracticeEnabled(): boolean {
  const raw = (process.env.CHAT_PRACTICE_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

// ── Tool-callback guidance (what the tool hands back to the model) ────────────

export const CHAT_PRACTICE_NO_MATCH_REASON =
  "No matching practice skill for that. Name a concrete arithmetic skill (e.g. 'two-digit addition with regrouping') or skip the item.";

export const CHAT_PRACTICE_NO_ITEM_REASON =
  "That skill has no practice item available.";

export const CHAT_PRACTICE_WITHHOLD_REASON =
  "Do not serve a practice problem right now. The scholar explicitly needs support or a pause; respond to their thinking instead.";

/**
 * A deliberately narrow guard for an authored practice quest. This is not
 * sentiment analysis: it recognizes only explicit "stop the drill" language
 * in the scholar's latest message. The tutor can return to retrieval practice
 * once the scholar's next message no longer carries one of these signals.
 */
export function hasExplicitPracticeWithholdSignal(message: string): boolean {
  return /\b(?:i(?:'m| am)|this is|it(?:'s| is))\s+(?:so\s+)?(?:frustrated|upset|overwhelmed|stuck|lost|confused|tired|exhausted|done|bored)\b|\b(?:this is dumb|i hate this|i(?:'m| am) giving up|i don'?t want to|can we stop)\b/i.test(
    message,
  );
}

export function chatPracticeSuccessGuidance(
  skillLabel: string,
  stem: string,
): string {
  return `Served an inline practice problem on "${skillLabel}" (stem: "${stem}"). It now shows in the chat with its own answer box. You do NOT know the answer and must not state or guess it. Add ONE short, warm line inviting the scholar to give it a try, then stop and let them answer.`;
}

export function chatPracticeFailureGuidance(message: string): string {
  return `Couldn't serve a practice problem (${message}). Just keep the conversation going.`;
}

// ── The served item (no answer ever) ────────────────────────────────────────

type ChatPracticeServeBase = {
  itemId: string;
  skillKey: string;
  skillLabel: string;
  mode?: "storyThread";
};

export type ChatPracticeTypedServe = ChatPracticeServeBase & {
  kind: "typed";
  stem: string;
  answerType: string;
  /** The measurement unit this item must be answered in, in DISPLAY form
   *  ("cm³"). An inline chat item is graded through `submitAnswer` like any
   *  other, so a unit-bearing one has to tell the widget what the answer needs
   *  — otherwise a kid answering in the chat can only ever be marked
   *  unit-missing. Not an answer leak (the stem names the unit in words). */
  answerUnit?: string;
  choices?: string[];
  /** Display-only prompt visual (e.g. the dots to count). Absent for text-only
   *  items. Threaded through so an inline chat item renders the SAME visual the
   *  standalone drill does — a visual skill served as bare text is unanswerable. */
  promptVisual?: PracticePromptVisual;
  /** "twoD" when this fraction/expression should use the shared box editor. */
  answerShape?: "twoD";
};

export type ChatPracticeManipulativeServe = ChatPracticeServeBase & {
  kind: "manipulative";
  manipulativeSpec: string;
};

export type ChatPracticeServe =
  | ChatPracticeTypedServe
  | ChatPracticeManipulativeServe;

export type ChatPracticeCandidate = SkillCandidate & {
  domain: string;
  isFluent: boolean;
  storedItems: StoredPracticeItem[];
};

export type ChatPracticeItemKind = "template" | "stored" | "manipulative";

const EXPLORATION_INTENT =
  /\b(explore|exploration|model|visual|visualize|show|build|represent|hands-on|manipulative|concept)\b/i;

/** A candidate is chat-servable when either resolver can produce an item. */
export function hasChatPracticeItem(candidate: ChatPracticeCandidate): boolean {
  return hasTemplate(candidate.skillKey) || candidate.storedItems.length > 0;
}

/**
 * Keep chat selection deliberately legible:
 *   1. An explicit concept/exploration request gets the curated manipulative.
 *   2. A GREEN-fluent skill gets the fast deterministic template rep.
 *   3. Otherwise prefer a verified stored word item for contextual variety.
 *   4. Fall back to whichever template/manipulative remains.
 */
export function selectChatPracticeItemKind(
  request: string,
  candidate: ChatPracticeCandidate,
): ChatPracticeItemKind | null {
  const hasManipulative = candidate.storedItems.some(
    (item) =>
      item.verifierKind === MANIPULATIVE_VERIFIER_KIND &&
      item.manipulativeSpec !== undefined,
  );
  const hasStored = candidate.storedItems.some(
    (item) => item.verifierKind !== MANIPULATIVE_VERIFIER_KIND,
  );
  const template = hasTemplate(candidate.skillKey);

  if (hasManipulative && EXPLORATION_INTENT.test(request)) return "manipulative";
  if (candidate.isFluent && template) return "template";
  if (hasStored) return "stored";
  if (template) return "template";
  if (hasManipulative) return "manipulative";
  return null;
}

function chatPayloadFromServable(item: ServableItem): ChatPracticeServe | null {
  if (item.kind === "manipulative") {
    const manipulativeSpec = item.prompt.manipulativeSpec;
    if (!manipulativeSpec) return null;
    return {
      kind: "manipulative",
      itemId: item.itemId,
      skillKey: item.skillKey,
      skillLabel: item.skillLabel,
      manipulativeSpec,
    };
  }
  const answerShape = servedItemFromServable(item, false).answerShape;
  return {
    kind: "typed",
    itemId: item.itemId,
    skillKey: item.skillKey,
    skillLabel: item.skillLabel,
    stem: item.prompt.stem,
    answerType: item.prompt.answerType,
    ...(item.prompt.answerUnit ? { answerUnit: item.prompt.answerUnit } : {}),
    ...(item.prompt.choices ? { choices: item.prompt.choices } : {}),
    ...(item.prompt.promptVisual
      ? { promptVisual: item.prompt.promptVisual }
      : {}),
    ...(answerShape ? { answerShape } : {}),
  };
}

/** Convert an already-authoritatively-resolved story application to the same
 * answer-free chat payload, tagged so clients use the feedback-only mutation. */
export function storyThreadChatPayload(
  item: ServableItem,
): ChatPracticeServe | null {
  const payload = chatPayloadFromServable(item);
  return payload ? { ...payload, mode: "storyThread" } : null;
}

/**
 * Resolve one inline item through the unified ServableItem builders. The string
 * overload is retained for the prompt eval harness; it is template-only because
 * that pure harness has no fetched practiceItems rows.
 */
export function serveChatItem(
  skillKey: string,
  seed: number,
): ChatPracticeTypedServe | null;
export function serveChatItem(
  candidate: ChatPracticeCandidate,
  seed: number,
  request: string,
): ChatPracticeServe | null;
export function serveChatItem(
  candidateOrKey: ChatPracticeCandidate | string,
  seed: number,
  request = "",
): ChatPracticeServe | null {
  const candidate: ChatPracticeCandidate =
    typeof candidateOrKey === "string"
      ? {
          skillKey: candidateOrKey,
          label: candidateOrKey,
          domain: "whole-number-arithmetic",
          isFluent: true,
          storedItems: [],
        }
      : candidateOrKey;
  const kind = selectChatPracticeItemKind(request, candidate);
  if (!kind) return null;
  const node = { label: candidate.label, domain: candidate.domain };

  if (kind === "template") {
    const itemId = makeItemId(candidate.skillKey, seed);
    const item = buildTemplateServable(itemId, node, candidate.domain);
    return item ? chatPayloadFromServable(item) : null;
  }

  const variants = candidate.storedItems.filter((item) =>
    kind === "manipulative"
      ? item.verifierKind === MANIPULATIVE_VERIFIER_KIND &&
        item.manipulativeSpec !== undefined
      : item.verifierKind !== MANIPULATIVE_VERIFIER_KIND,
  );
  if (variants.length === 0) return null;
  const doc = variants[(seed >>> 0) % variants.length];
  const servable = buildStoredServable(`gen#${doc._id}`, doc, node, candidate.domain);
  return servable ? chatPayloadFromServable(servable) : null;
}

// ── Skill resolution (tutor free-text → servable skillKey) ───────────────────

export type SkillCandidate = { skillKey: string; label: string };

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "for", "with", "by",
  "your", "you", "their", "how", "many", "number", "numbers", "problem",
  "problems", "practice", "skill", "skills", "do", "some", "this", "that",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/**
 * Map the tutor's free-text `skill` argument (a label, a phrase, or even a raw
 * skillKey) to a concrete servable skillKey among the candidates. Robust to
 * the tutor paraphrasing a frontier label. Returns the best match or null.
 *
 * Why free-text and not a raw skillKey: the redaction contract (roadmap §8)
 * keeps skillKey identifiers OUT of the tutor prompt — the tutor only ever
 * sees skill LABELS. So the tool speaks labels and the server resolves them,
 * preserving that boundary. `candidates` should be the scholar's own
 * frontier/due/fluent servable skills (pedagogical fit), falling back to the
 * whole servable domain. Candidate construction owns availability filtering;
 * this resolver intentionally does not re-impose a template-only policy.
 */
export function resolveChatPracticeSkill(
  query: string,
  candidates: SkillCandidate[],
): string | null {
  if (candidates.length === 0) return null;

  const q = query.trim().toLowerCase();
  if (!q) return null;

  // 1. Exact skillKey (the tutor echoed a key back).
  const exactKey = candidates.find((c) => c.skillKey.toLowerCase() === q);
  if (exactKey) return exactKey.skillKey;

  // 2. Exact label (case-insensitive).
  const exactLabel = candidates.find((c) => c.label.toLowerCase() === q);
  if (exactLabel) return exactLabel.skillKey;

  // 3. Best token-overlap between the query and each candidate label. Ties
  //    break toward the shorter label (a more specific skill).
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return null;
  // Two tokens match if equal, or one is a prefix of the other (min length 4)
  // — so "subtraction" matches "subtract", "multiply" matches "multiplication".
  const tokMatch = (a: string, b: string): boolean =>
    a === b ||
    (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
  let best: { key: string; score: number; len: number } | null = null;
  for (const c of candidates) {
    const cTokens = tokenize(c.label);
    if (cTokens.length === 0) continue;
    let overlap = 0;
    for (const ct of cTokens) if (qTokens.some((qt) => tokMatch(qt, ct))) overlap++;
    // Also credit the query mentioning a distinctive number in the key (e.g.
    // "7s"/"8s"/"9s" → mult_facts_7_8_9) so "know your 7s" maps well.
    const keyDigits = c.skillKey.match(/\d+/g) ?? [];
    for (const d of keyDigits)
      if (qTokens.includes(d) || qTokens.includes(`${d}s`)) overlap += 0.5;
    if (overlap <= 0) continue;
    const score = overlap;
    if (!best || score > best.score || (score === best.score && c.label.length < best.len)) {
      best = { key: c.skillKey, score, len: c.label.length };
    }
  }
  return best ? best.key : null;
}

// ── The tool spec ────────────────────────────────────────────────────────────

export const SERVE_PRACTICE_PROBLEM_TOOL = {
  name: "serve_practice_problem",
  description:
    "Drop ONE short, interactive practice problem into the chat for the scholar to solve in place — a quick retrieval-practice item, NOT a quiz. Use this SPARINGLY and only after you have PROBED first: the scholar has just claimed or implied fluency in a skill ('I know my 7s', 'that's easy'), or a natural retrieval moment has arrived where doing one from memory would strengthen it more than talking about it. Do NOT open a topic by testing, do NOT string multiple problems together, and do NOT use it to check comprehension of something you just explained (that's lecture-then-test — exactly what to avoid). Pass the skill by its everyday name/label (e.g. 'multiplication facts for 7, 8, 9', 'two-digit addition with regrouping'); the server picks a fresh problem and grades it. If the moment calls for exploring or visually modeling a concept, say that in the skill phrase so the server can choose a hands-on manipulative when one is curated. You will NOT be told the answer. After serving, hand the moment back to the scholar and let them answer — react to their thinking, never state or confirm the answer yourself.",
  inputSchema: {
    type: "object" as const,
    properties: {
      skill: {
        type: "string" as const,
        description:
          "The skill to practice, in plain words (a label or short phrase). Prefer one of the skills named in the PRACTICE FRONTIER context. Example: 'multiplication facts for 7, 8, 9'.",
      },
    },
    required: ["skill"] as const,
  },
};

export const SERVE_STORY_APPLICATION_PROBLEM_TOOL = {
  name: "serve_story_application_problem",
  description:
    "Serve the ONE inline application problem tied to this story thread's exact story edge. Use it only after genuine discussion, when trying the story's idea has become the natural next beat. Never use it as the opener, as bait for the story, as a gate, or more than once. The server derives the edge and problem; you do not choose a skill or item, and you will not be told the answer. After serving, invite the scholar to try it and stop.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [] as const,
  },
};

export function storyApplicationSuccessGuidance(
  skillLabel: string,
  stem: string,
): string {
  return `Served this story edge's inline application on "${skillLabel}" (stem: "${stem}"). It now shows in the chat with its own answer box. You do NOT know the answer and must not state or guess it. Add ONE short, warm invitation to try it, then stop and let the scholar answer.`;
}

// ── The tutor-visible prompt section (gated) ─────────────────────────────────

export type ChatPracticeSectionCtx = {
  fluentLabels: string[];
  frontierLabels: string[];
  dueLabels: string[];
};

/**
 * The tutor-visible instructions for problems-in-chat. Appended to the tutor
 * system prompt ONLY when the gate is on. Labels only — never skillKeys, rep
 * counts, or the problems in today's session (Pattern 1's redaction contract).
 *
 * The heart of it is the probe-first / retrieval-practice framing: an inline
 * item is a tool for making the scholar THINK (retrieve from memory), never a
 * gate the tutor puts in front of a topic or a comprehension check after a
 * mini-lecture. Returns null when there's nothing the scholar could be served
 * (no known skills), so the section is omitted rather than dangling.
 */
export function buildChatPracticeSection(
  ctx: ChatPracticeSectionCtx | null,
): string | null {
  if (!ctx) return null;
  const { fluentLabels, frontierLabels, dueLabels } = ctx;
  if (
    fluentLabels.length === 0 &&
    frontierLabels.length === 0 &&
    dueLabels.length === 0
  )
    return null;

  const lines: string[] = [
    `\nINLINE PRACTICE (you can offer a quick "solve this" problem — use it rarely and well):`,
    `You have a tool, serve_practice_problem, that drops a single interactive problem into the chat for the scholar to answer in place. It is a RETRIEVAL-PRACTICE move, not a quiz. Retrieval practice — pulling something from memory — strengthens it far more than talking about it, but only when the moment is right.`,
    ``,
    `WHEN to offer one (all of these must feel true):`,
    `  - You have already PROBED — drawn out the scholar's own thinking — and the natural next beat is "let's actually do one," not more talk.`,
    `  - The scholar just CLAIMED or implied fluency ("I know my 7s", "that part's easy") and doing one from memory would let them prove it to themselves — a friendly "let's see" beats taking their word for it OR lecturing them.`,
    `  - It's a skill they're building or revisiting where one clean rep now would help it stick.`,
    ``,
    `WHEN NOT to (these are the failure modes — avoid them):`,
    `  - Do NOT open a topic by testing. Probe and explore FIRST; an item is never your first move on something new.`,
    `  - Do NOT serve an item right after you explained a method to "check they got it" — that's lecture-then-test, the exact anti-pattern here. Retrieval practice is for something they already have, not something you just handed them.`,
    `  - Do NOT chain items or turn the chat into a worksheet. At most one at a time, and only occasionally.`,
    ``,
    `HOW it works: you pass the skill by its everyday name (see PRACTICE FRONTIER for the scholar's current skills — use those labels). The server picks a fresh problem, shows the scholar an answer box, and grades it. You are NOT told the answer and have no way to know it — so never state it, never confirm a guess, and don't pre-solve it in your message. After you call the tool, hand the moment to the scholar: a short encouraging line and let them answer. React to HOW they think, not whether you can supply the result.`,
  ];
  if (frontierLabels.length > 0)
    lines.push(`Good candidates right now: ${frontierLabels.join(", ")}.`);
  if (dueLabels.length > 0)
    lines.push(`Worth revisiting: ${dueLabels.join(", ")}.`);
  if (fluentLabels.length > 0)
    lines.push(
      `Already fluent (only re-offer as a confident warm-up, not to re-test): ${fluentLabels.join(", ")}.`,
    );
  return lines.join("\n");
}
