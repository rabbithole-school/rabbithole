// "Could become" Quest ideas in the day's wonders note (TRA-697;
// review/quests-rebuilt-proposal.html, figure 6 and its appendix rule).
//
// When the day's note is built, Rabbithole drafts at most two Quest ideas per
// kid from that day's wonders, and each becomes a one-tap "Offer an app: …"
// button under the wonder it came from. Pure: the evidence rule, what the
// model is asked and how its answer is checked, and the message blocks. The
// drafting call is convex/dayWonderIdeasActions.ts, the rows and the tap are
// convex/wonderQuestIdeas.ts and convex/wonderQuestIdeaSlack.ts.
//
// The rule (appendix): a Quest is offered once, on evidence, when two of four
// hold. Two are counted from data (they came back to the wonder another day;
// they asked three or more follow-ups in its chat) and two are the model's
// judgment (it is open, testable or buildable; it connects to something they
// are making). The model can add to the count but can never lower what the
// data shows, and an idea that doesn't reach two is dropped whatever the model
// says.

import { escapeSlackText } from "./slackText";
import type { QuestProposalKind } from "./questApproval";
import { QUEST_PROPOSAL_KIND_LINE } from "./questApproval";

export const MAX_IDEAS_PER_SCHOLAR = 2;
export const EVIDENCE_NEEDED = 2;
/** "Three or more follow-ups" in the wonder's chat. */
export const FOLLOW_UPS_NEEDED = 3;
/** The Quest's mission and title limits (units.ts QUEST_MISSION_LIMITS, the
 *  proposal's name limit), written out because this file stays pure. */
export const IDEA_MISSION_MAX = 140;
export const IDEA_TITLE_MAX = 80;

/** The button family on /slack/interactivity (convex/slackInteractivity.ts). */
export const QUEST_IDEA_PREFIX = "qidea";
export function ideaOfferActionId(position: number): string {
  return `${QUEST_IDEA_PREFIX}:offer:${position}`;
}

export type IdeaCandidate = {
  seedId: string;
  question: string;
  /** The opening of Rabbithole's first reply. */
  reply: string;
  /** What the kid said in that chat after the question, oldest first. */
  followUps: string[];
  /** How many follow-ups there were in all (`followUps` may be clipped). */
  followUpCount: number;
  /** The kid wrote in that chat on a different school day than they asked. */
  cameBack: boolean;
};

/** What the data alone shows: 0, 1 or 2 of the four. */
export function computedEvidence(c: {
  followUpCount: number;
  cameBack: boolean;
}): number {
  return (c.cameBack ? 1 : 0) + (c.followUpCount >= FOLLOW_UPS_NEEDED ? 1 : 0);
}

/**
 * The wonders worth a model call: one that could still reach two of four. With
 * nothing counted from data, both judged items would have to hold, and
 * "connects to something they're making" can't without any work to connect
 * to. No candidates, no call.
 */
export function candidatesForModel<T extends Parameters<typeof computedEvidence>[0]>(
  wonders: readonly T[],
  hasMakingContext: boolean,
): T[] {
  return wonders.filter(
    (w) => computedEvidence(w) + (hasMakingContext ? 2 : 1) >= EVIDENCE_NEEDED,
  );
}

const QUESTION_WORDS = new Set([
  "what", "why", "how", "who", "whom", "whose", "when", "where", "which",
  "can", "could", "do", "does", "did", "is", "are", "was", "were", "will",
  "would", "should", "shall", "may", "might", "has", "have",
]);

/** "Why do owls…", anything with a question mark: a question is never a
 *  Quest idea. */
export function isQuestionShaped(text: string): boolean {
  const t = text.trim();
  if (t.includes("?")) return true;
  const first = (t.split(/\s+/)[0] ?? "").toLowerCase().replace(/[^a-z']/g, "");
  return QUESTION_WORDS.has(first);
}

export const IDEA_KINDS = ["app", "slides", "python"] as const;

export const WONDER_IDEAS_TOOL = {
  name: "report_quest_ideas",
  description:
    "For each wonder, judge the two items only you can judge, then give at most two Quest ideas across all of them, only where the evidence holds.",
  input_schema: {
    type: "object" as const,
    properties: {
      judgments: {
        type: "array",
        description: "One entry per wonder listed.",
        items: {
          type: "object",
          properties: {
            wonderId: { type: "string" },
            open_testable_or_buildable: {
              type: "boolean",
              description:
                "True if the wonder opens onto something they could test, build or make, not just look up.",
            },
            connects_to_their_making: {
              type: "boolean",
              description:
                "True if it clearly connects to something this kid is already making (the list given), not just the same broad subject.",
            },
            reasons: {
              type: "string",
              description: "One short sentence for each of the two judgments, naming the evidence.",
            },
          },
          required: [
            "wonderId",
            "open_testable_or_buildable",
            "connects_to_their_making",
            "reasons",
          ],
        },
      },
      ideas: {
        type: "array",
        description: "At most two in all. Empty when no wonder has enough evidence or no good idea.",
        items: {
          type: "object",
          properties: {
            wonderId: { type: "string", description: "The wonder this idea grew from." },
            kind: { type: "string", enum: [...IDEA_KINDS] },
            mission: {
              type: "string",
              description:
                "One sentence, at most 140 characters: who it is for and what it should do for them. A goal, not a checklist, and not a question.",
            },
            title: {
              type: "string",
              description: "A short name, at most 6 words, that is not a question.",
            },
          },
          required: ["wonderId", "kind", "mission", "title"],
        },
      },
    },
    required: ["judgments", "ideas"],
  },
};

export const WONDER_IDEAS_SYSTEM = `You help a teacher decide which of a child's questions today could become a Quest: one thing the child makes, of three kinds. "app" is a small interactive web app. "slides" is a presentation. "python" is a short Python program.

You are shown a child's wonders from today: what they asked, how Rabbithole answered, what they said next in that chat, and what they are already making. Most wonders should not become a Quest. A Quest is offered once, on evidence, when two of four hold:
1. They came back to it on another day. (Given to you.)
2. They asked three or more follow-ups. (Given to you.)
3. It is open, testable or buildable: it opens onto something they could make or try, not a fact to look up.
4. It connects to something they are making: it clearly builds on or feeds a project in the list, not the same broad subject.
You judge 3 and 4 only. The first two are counted for you; trust the counts.

For every wonder, judge 3 and 4 honestly and say why in one short sentence each. Then give at most two ideas in all, each from a wonder where at least two of the four hold. Say nothing for a wonder that falls short.

Each idea has a kind, a short title, and a mission: one sentence of at most 140 characters that names who it is for and what it should do for them. The audience is a real person or group (a younger sibling, the class, a grandparent), and the mission is a goal, never a checklist of steps or features. Neither the title nor the mission may be a question or start like one. Make the idea something this child would be glad to be offered, in their own interest, and suitable for a school. Pick the kind that fits what they wondered: a thing people use is an app, something to explain to others is slides, a calculation or simulation is python. Never invent facts about the child.`;

/** What one call reads is bounded on the way in, not just on the way out:
 *  each label, each quoted line, how many wonders, and the whole message. */
export const MAKING_LABEL_MAX = 120;
export const MAKING_LINES_MAX = 6;
export const QUESTION_MAX = 300;
export const REPLY_MAX = 400;
export const FOLLOW_UP_SHOWN_MAX = 4;
export const FOLLOW_UP_CHARS_MAX = 200;
export const WONDERS_PER_CALL_MAX = 8;
export const PROMPT_CHARS_MAX = 16_000;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function renderIdeasUserMessage(input: {
  firstName: string;
  making: string[];
  wonders: IdeaCandidate[];
}): string {
  const lines: string[] = [];
  lines.push(`Child: ${clip(input.firstName, 40)}`);
  const making = input.making.slice(0, MAKING_LINES_MAX).map((m) => clip(m, MAKING_LABEL_MAX));
  lines.push(
    making.length > 0
      ? `Already making or working on:\n${making.map((m) => `- ${m}`).join("\n")}`
      : "Already making or working on: nothing we know of.",
  );
  for (const w of input.wonders.slice(0, WONDERS_PER_CALL_MAX)) {
    lines.push("");
    lines.push(`Wonder ${w.seedId}`);
    lines.push(`Asked: ${clip(w.question, QUESTION_MAX)}`);
    lines.push(`Rabbithole said: ${clip(w.reply, REPLY_MAX)}`);
    lines.push(
      `Came back to it on another day: ${w.cameBack ? "yes" : "no"}. Follow-ups: ${w.followUpCount}.`,
    );
    if (w.followUps.length > 0) {
      lines.push("Their follow-ups:");
      for (const f of w.followUps.slice(0, FOLLOW_UP_SHOWN_MAX)) {
        lines.push(`- ${clip(f, FOLLOW_UP_CHARS_MAX)}`);
      }
    }
  }
  return lines.join("\n").slice(0, PROMPT_CHARS_MAX);
}

export type DraftedIdea = {
  seedId: string;
  kind: QuestProposalKind;
  mission: string;
  title: string;
  reasons: string;
  evidence: { cameBack: boolean; followUps: number; open: boolean; connects: boolean };
};

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * The model's answer, held to the rule. An idea stands only when its wonder
 * was asked about, two of the four hold counting the data first, it has a
 * known kind, a mission and a title within limits, and neither reads as a
 * question. At most MAX_IDEAS_PER_SCHOLAR, in the order given, one per
 * (wonder, kind) so two near-copies don't take both places.
 */
export function acceptIdeas(
  raw: unknown,
  candidates: readonly IdeaCandidate[],
  hasMakingContext: boolean,
): DraftedIdea[] {
  const out = raw as {
    judgments?: unknown;
    ideas?: unknown;
  } | null;
  if (!out || !Array.isArray(out.judgments) || !Array.isArray(out.ideas)) return [];
  const byId = new Map(candidates.map((c) => [c.seedId, c]));
  const judged = new Map<string, { open: boolean; connects: boolean; reasons: string }>();
  for (const j of out.judgments as Record<string, unknown>[]) {
    const id = typeof j?.wonderId === "string" ? j.wonderId : "";
    if (!byId.has(id) || judged.has(id)) continue;
    judged.set(id, {
      open: j.open_testable_or_buildable === true,
      // With no work to connect to, the connection can't hold, whatever the
      // model says.
      connects: hasMakingContext && j.connects_to_their_making === true,
      reasons: typeof j.reasons === "string" ? oneLine(j.reasons).slice(0, 400) : "",
    });
  }
  const accepted: DraftedIdea[] = [];
  const seen = new Set<string>();
  for (const idea of out.ideas as Record<string, unknown>[]) {
    if (accepted.length >= MAX_IDEAS_PER_SCHOLAR) break;
    const id = typeof idea?.wonderId === "string" ? idea.wonderId : "";
    const candidate = byId.get(id);
    const judgment = judged.get(id);
    if (!candidate || !judgment) continue;
    const kind = idea.kind;
    if (kind !== "app" && kind !== "slides" && kind !== "python") continue;
    const mission = typeof idea.mission === "string" ? oneLine(idea.mission) : "";
    const title = typeof idea.title === "string" ? oneLine(idea.title) : "";
    if (!mission || !title) continue;
    if (mission.length > IDEA_MISSION_MAX || title.length > IDEA_TITLE_MAX) continue;
    if (isQuestionShaped(mission) || isQuestionShaped(title)) continue;
    const held =
      computedEvidence(candidate) +
      (judgment.open ? 1 : 0) +
      (judgment.connects ? 1 : 0);
    if (held < EVIDENCE_NEEDED) continue;
    const key = `${id}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({
      seedId: id,
      kind,
      mission,
      title,
      reasons: judgment.reasons,
      evidence: {
        cameBack: candidate.cameBack,
        followUps: candidate.followUpCount,
        open: judgment.open,
        connects: judgment.connects,
      },
    });
  }
  return accepted;
}

/** Slack allows 75 characters on a button. */
const BUTTON_TEXT_MAX = 75;

/** "Offer an app: Angle croc", "Offer a presentation: …". */
export function ideaButtonText(kind: QuestProposalKind, title: string): string {
  const noun = QUEST_PROPOSAL_KIND_LINE[kind].toLowerCase();
  const text = `Offer ${noun}: ${oneLine(title)}`;
  return text.length <= BUTTON_TEXT_MAX ? text : `${text.slice(0, BUTTON_TEXT_MAX - 1).trimEnd()}…`;
}

export type IdeaForMessage = {
  ideaId: string;
  position: number;
  kind: QuestProposalKind;
  title: string;
  mission: string;
  /** Set once a teacher has offered it. */
  offeredBy?: string;
};

/**
 * The blocks under a wonder's question and answer: one "✅ Offered to …" line
 * for each idea already offered, then the buttons for the rest. Empty when
 * the wonder has no ideas. Both the first post and every update after a tap
 * build the message from the ideas' stored state, so two taps in a row can't
 * undo each other.
 */
export function ideaBlocks(
  ideas: readonly IdeaForMessage[],
  scholarLabel: string,
): { blocks: unknown[]; lines: string[] } {
  const sorted = [...ideas].sort((a, b) => a.position - b.position);
  const blocks: unknown[] = [];
  const lines: string[] = [];
  for (const idea of sorted) {
    if (idea.offeredBy === undefined) continue;
    const line = `✅ Offered to ${scholarLabel} by ${idea.offeredBy}: ${oneLine(idea.title)}`;
    lines.push(line);
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: escapeSlackText(line) }],
    });
  }
  const waiting = sorted.filter((i) => i.offeredBy === undefined);
  if (waiting.length > 0) {
    // The teacher reads what they are offering before they tap: the title and
    // the mission that will be posted under their name.
    const shown = waiting.map(
      (i) => `${ideaButtonText(i.kind, i.title)} — ${oneLine(i.mission)}`,
    );
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: shown.map(escapeSlackText).join("\n") },
    });
    lines.push(...shown);
    blocks.push({
      type: "actions",
      elements: waiting.map((idea) => ({
        type: "button",
        action_id: ideaOfferActionId(idea.position),
        text: { type: "plain_text", text: ideaButtonText(idea.kind, idea.title) },
        value: idea.ideaId,
      })),
    });
  }
  return { blocks, lines };
}


/** What a wonder's post shows of its ideas, in one string: which exist and
 *  which are offered. A sync carries the stamp it was asked for, and a sync
 *  whose stamp is no longer current leaves the post to a newer one. */
export function ideaStamp(ideas: readonly IdeaForMessage[]): string {
  return [...ideas]
    .sort((a, b) => a.position - b.position)
    .map((i) => `${i.ideaId}:${i.offeredBy === undefined ? 0 : 1}`)
    .join("|");
}
