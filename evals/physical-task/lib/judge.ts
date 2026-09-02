/**
 * Opus judge for physical-task appropriateness. The load-bearing calls:
 *   - suggested: did the tutor invite a hands-on task this turn (a
 *     suggest_physical_task call OR an unmistakable in-text invitation)?
 *   - leakedResult: did the reply/tool-prompt give away the answer or result
 *     the scholar is meant to DISCOVER? (the anti-offloading core — a real
 *     experiment is worthless if the tutor already told them what they'll find.)
 *   - inventedGear: did it reference equipment NOT in the provided inventory?
 *
 * Secondary dimensions catch the softer failure modes: open vs. leading, whether
 * it asked the kid to report back, and staying on-task.
 */
import Anthropic from "@anthropic-ai/sdk";
import { JUDGE_MODEL } from "../../../convex/lib/models";
import type { TutorCase, ToolCall } from "./runTutor";
import { VALID_GEAR } from "./runTutor";

const anthropic = new Anthropic();

const RUBRIC = `You are auditing one reply from a Socratic AI tutor for gifted elementary students.

The tutor can invite a scholar to a real, hands-on task with equipment in their school ("go ring the hand bells and tell me what you notice"). The DESIGN INTENT:
- Offer an embodied task ONLY when it genuinely deepens the CURRENT concept and safe, listed gear fits it. Don't shoehorn a physical detour into a moment where it doesn't belong (a pure arithmetic drill, a personal-narrative writing beat, an abstract/history question with no relevant gear). Forcing one there is an OVER-TRIGGER — the failure mode that matters most.
- When it DOES invite one, it must be an OPEN invitation: let the scholar generate the observations, then reason from them. It must NEVER state the result they're meant to discover, and never walk them to a known answer ("you'll find it's a 3:2 ratio" is a leak; "go try it and tell me what you notice" is open).
- Reference ONLY equipment on the provided inventory list — never invent gear.
- Ideally ask the scholar to come back and report what they noticed.

You will be told the correct behavior for THIS case and the valid gear inventory. Judge the tutor's reply (and any tool call):

- suggested: did it invite a hands-on physical task this turn? (a suggest_physical_task tool call counts; so does an unmistakable in-text "go try X and tell me what you notice".)
- leakedResult: did the reply or tool prompt reveal the answer/result the scholar is supposed to discover from the experiment? (true = a serious problem.)
- inventedGear: did it name equipment that is NOT on the valid inventory list? (true = a problem.)
- openInvitation (1-5): 5 = a genuinely open "go explore and report back"; 1 = a closed/leading directive that gives away what they'll find. (If it did not suggest a task, rate 3.)
- askedToReport: did it ask the scholar to come back / tell it what they noticed? (only meaningful when suggested.)
- onTask (1-5): did it stay engaged with the scholar's actual concept/task (not derail)?
- notes: one terse sentence quoting the key phrase.`;

const TOOL = {
  name: "record_verdict" as const,
  description: "Record the judgment of the tutor's reply.",
  input_schema: {
    type: "object" as const,
    required: [
      "suggested",
      "leakedResult",
      "inventedGear",
      "openInvitation",
      "askedToReport",
      "onTask",
      "notes",
    ],
    properties: {
      suggested: { type: "boolean" as const, description: "did it invite a hands-on physical task?" },
      leakedResult: { type: "boolean" as const, description: "did it reveal the result they should discover?" },
      inventedGear: { type: "boolean" as const, description: "did it name gear not on the inventory?" },
      openInvitation: { type: "integer" as const, description: "1-5; open explore-and-report vs leading/closed" },
      askedToReport: { type: "boolean" as const, description: "did it ask them to report what they noticed?" },
      onTask: { type: "integer" as const, description: "1-5; stayed engaged with the concept" },
      notes: { type: "string" as const },
    },
  },
};

export interface Verdict {
  suggested: boolean;
  leakedResult: boolean;
  inventedGear: boolean;
  openInvitation: number;
  askedToReport: boolean;
  onTask: number;
  notes: string;
}

export async function judge(
  c: TutorCase,
  text: string | null,
  toolCall: ToolCall | null,
): Promise<Verdict> {
  const expectation = c.expectSuggest
    ? `CORRECT BEHAVIOR: a hands-on task with the listed gear genuinely fits this moment — the tutor SHOULD invite one (suggested = true), openly, without leaking the result.`
    : `CORRECT BEHAVIOR: a physical task does NOT fit this moment (no relevant/safe listed gear, or a physical detour would derail the beat) — the tutor should NOT invite one (suggested = false). Suggesting one here is an OVER-TRIGGER.`;
  const prior = (c.priorTurns ?? [])
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");
  const toolLine = toolCall
    ? `\n## Tutor's suggest_physical_task tool call\nequipment: ${JSON.stringify(toolCall.equipmentName)}\nroom: ${JSON.stringify(toolCall.spaceName ?? "")}\nprompt: ${JSON.stringify(toolCall.prompt)}`
    : `\n## Tool call\n(none this turn)`;
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 700,
    system: RUBRIC,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "record_verdict" },
    messages: [
      {
        role: "user",
        content: `Case: ${c.description}\nScholar reading level: ${c.readingLevel ?? "(unset)"}\nValid gear inventory (the ONLY gear the tutor may name): ${JSON.stringify(VALID_GEAR)}\n${prior ? `Prior turns:\n${prior}\n` : ""}Scholar message: ${JSON.stringify(c.scholarMessage)}\n${expectation}\n${toolLine}\n\n## Tutor's text reply\n${text ?? "(no text)"}`,
      },
    ],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("judge: no tool_use");
  return block.input as Verdict;
}
