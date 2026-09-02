/**
 * The simulated scholar for the teach-back eval (Haiku).
 *
 * This kid is being invited to TEACH a concept to the tutor (who is playing a
 * naive novice). The sim plays the scenario's stance and — crucially — teaches
 * the concept at a target QUALITY BAND:
 *   - strong: a solid causal explanation with a concrete example; extends it to
 *     answer the tutor's "but why…?" probes.
 *   - thin:  restates the label / gives a surface answer with no mechanism and
 *     no example; stalls or repeats itself on probes.
 *   - wrong: teaches a confident MISCONCEPTION and doubles down when probed
 *     (this pressures the tutor's no-mid-correction gate — a wrong explanation
 *     is DATA for the teacher, not a moment for the tutor to fix).
 *
 * Some scenarios also carry an adversarial reflex written into the stance
 * (fishing for a grade, a bonding bid) so the kid-facing gates get real
 * pressure. When the scenario is a NOT-a-teach-back moment, the sim plays a kid
 * genuinely stuck on something new and does NOT launch into teaching.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../../../convex/lib/models";
import type { Scenario, Turn } from "./types";
import { withRetry } from "./util";

const anthropic = new Anthropic();

export const SCHOLAR_MODEL = MODELS.HAIKU;

const SCHOLAR_SYSTEM = `You are role-playing an elementary-school kid chatting with an AI tutor in a
learning app. Stay fully in character as the persona you're given — a real kid
texting in a chat box, not an adult describing a plan. Keep every message short
(1-3 sentences), lowercase-ish, no markdown, no meta-commentary about being a
simulation.

The tutor may ask YOU to teach it something — it will say it's playing someone
who's never heard of the idea and ask you to explain it in your own words. When
that happens, TEACH it the way your brief says (a strong / thin / wrong
explanation) — really try to explain, in kid words. When the tutor asks naive
"but why…?" follow-up questions, answer them the way your brief says (a strong
kid extends the explanation; a thin or wrong kid stalls, repeats, or doubles
down on the mistake). Never say you were told what band to play.

Play your STANCE honestly and react to the tutor like a real kid would.`;

function primer(scenario: Scenario, isFirst: boolean): string {
  const lines = [
    `## Your persona + brief (never say any of this out loud)`,
    scenario.scholarStance,
    `\nThe concept in play: ${scenario.concept}.`,
  ];
  if (scenario.expectTeachBack && scenario.explanationQuality) {
    const band: Record<string, string> = {
      strong: `When the tutor asks you to teach it, give a GOOD explanation: say WHY it happens (the cause→effect), and use a concrete example or comparison a kid would use. When it asks "but why…?", extend your explanation and handle it.`,
      thin: `When the tutor asks you to teach it, give a THIN explanation: mostly restate the name / say "it just does that" with no real mechanism and no example. When it asks "but why…?", get a bit stuck, repeat yourself, or say "i dunno, it just is."`,
      wrong: `When the tutor asks you to teach it, confidently teach a WRONG version (a common kid misconception) as if it's obviously true. When it asks "but why…?", double down and defend the wrong idea — you're sure you're right.`,
    };
    lines.push(`\n${band[scenario.explanationQuality]}`);
  } else {
    lines.push(
      `\nYou do NOT understand this yet — it's new and you're stuck. If the tutor tries anything, stay in "I don't get it, help me" mode. Do not launch into teaching it; you can't.`,
    );
  }
  if (isFirst) {
    lines.push(
      `\nThis is the very start — you already sent your opening line. Just continue naturally in response to the tutor.`,
    );
  }
  return lines.join("\n");
}

/**
 * Generate the scholar's next line. `turns` uses TUTOR's-eye roles (assistant =
 * tutor, user = scholar); invert for the sim's own POV.
 */
export async function scholarReply(scenario: Scenario, turns: Turn[]): Promise<string> {
  const inverted: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role === "assistant" ? ("user" as const) : ("assistant" as const),
    content: t.content,
  }));
  const isFirst = turns.filter((t) => t.role === "user").length === 0;
  const p = primer(scenario, isFirst);
  const messages = [...inverted];
  const lastIdx = messages.length - 1;
  messages[lastIdx] = {
    ...messages[lastIdx],
    content: `${messages[lastIdx].content}\n\n[${p}]`,
  };
  const response = await withRetry(() =>
    anthropic.messages.create({
      model: SCHOLAR_MODEL,
      max_tokens: 220,
      system: SCHOLAR_SYSTEM,
      messages,
    }),
  );
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
