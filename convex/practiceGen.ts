"use node";

/**
 * LLM word-problem generation — the contextual layer above the template drill.
 *
 * A fast model (Haiku) generates candidate word problems for a skill, each with
 * a restricted arithmetic `solutionExpression`. EVERY candidate passes through
 * the verification gate (convex/lib/practice/verify.ts — the solution,
 * safely evaluated, must equal the stated answer) before it is stored, so a
 * wrong problem never reaches a child. This is the Spike-A pipeline, productized.
 * See review/practice/sketches.html §5.
 *
 * The cron/bot wiring lives elsewhere; this action is invoked on demand
 * (manually for now, by the teacher/bot later). Live model calls only.
 */

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { verifyBatch, type Candidate } from "./lib/practice/verify";
import {
  formatAnswer,
  formatUnit,
  parseAnswer,
  parseUnitKey,
  textNamesUnit,
  UNIT_KEYS,
  type AnswerType,
} from "./lib/practice/answers";
import { verifyRevealLine, extractNumbers } from "./lib/practice/revealLine";
import { PRE_WARMED_CONCEPTUAL } from "./lib/practice/coverage";
import {
  verifyInstructionContent,
  type VerifyAtom,
} from "./lib/practice/instructionVerify";

/** One model-emitted candidate, plus the placement warmth-floor reveal line
 *  (Tier 1c) and the measurement unit the answer must carry. Both are verified
 *  separately (the reveal line by the S8 operand-substitution ban, the unit by
 *  `generatedAnswerUnit` below) and stored only if they pass; the arithmetic
 *  gate is unchanged by either. */
type GenItem = Candidate & { revealLine?: string; answerUnit?: string };

/** The display forms a generated item may name as its answer unit — the shared
 *  registry's whole vocabulary (lib/practice/answers.ts), never a list typed
 *  out here that could drift from what the grader can normalize. */
const GEN_ANSWER_UNITS = UNIT_KEYS.map(formatUnit);

/**
 * The unit a generated word problem's answer must carry, or undefined to leave
 * the item graded value-only (the pre-existing behavior for every stored item).
 *
 * Two gates, both mechanical, in the spirit of the arithmetic verifier: the unit
 * must be one the grading registry can normalize, and the STEM must actually
 * name it. A unit the stem never mentions would mark a child wrong for an answer
 * the question never asked for — strictly worse than grading it unit-free — so a
 * failing unit is DROPPED (the item itself is still perfectly good), exactly how
 * a failing `revealLine` is handled.
 */
export function generatedAnswerUnit(
  stem: string,
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  const key = parseUnitKey(raw);
  if (!key || !textNamesUnit(stem, key)) return undefined;
  return formatUnit(key);
}

const GEN_TOOL = {
  name: "emit_problems",
  description: "Return the generated word problems.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            stem: { type: "string", description: "The word problem a student reads. One unambiguous numeric answer." },
            answer: { type: "string", description: "The canonical correct answer, e.g. '42', '6.50', '3/4'." },
            answerType: { type: "string", enum: ["integer", "decimal", "fraction"] },
            answerUnit: {
              type: "string",
              enum: GEN_ANSWER_UNITS,
              description:
                "ONLY for a measurement problem whose stem asks for the answer in this unit (e.g. '…in cubic centimeters' → 'cm³'). Omit it for every other problem — most problems have no unit. The student must then write the unit as part of the answer, so never name a unit the stem doesn't ask for.",
            },
            solutionExpression: {
              type: "string",
              description: "A plain arithmetic expression that computes the answer using ONLY digits, + - * / and parentheses (no words, no variables). E.g. '4.50 * 3'.",
            },
            revealLine: {
              type: "string",
              description:
                "A single warm sentence (a 'reveal line') shown if a student says they haven't learned this yet — it states how to reach the answer, using ONLY the numbers already in this problem (its own quantities, the answer, or a value you get by doing the arithmetic on them). NEVER introduce a number from a different example. Plain text, no Markdown. E.g. for '3 baskets of 4 apples': 'Three baskets of 4 apples is 3 groups of 4, which makes 12.'",
            },
          },
          required: ["stem", "answer", "answerType", "solutionExpression"],
        },
      },
    },
    required: ["items"],
  },
};

/**
 * Skill-specific generation directives — extra prompt rules for nodes whose
 * answer FORMAT the generic prompt can't infer from the label alone. The
 * fraction-as-division concept (a ÷ b = a/b) is only illustrated by a GENUINE
 * fraction: an evenly-dividing "share 8 among 4" gives the whole number 2, which
 * both misses the concept AND can't be entered on the numeric pad (no "/" key
 * unless the item is typed "fraction"). That was the reported bug, so this
 * steers the model away from it; verify.ts is the hard gate that enforces it.
 */
const SKILL_DIRECTIVES: Record<string, string> = {
  fraction_as_division:
    `\n\nFor THIS skill specifically (interpreting a fraction as division, a ÷ b = a/b):\n` +
    `- EVERY answer must be a genuine fraction. Set "answerType" to "fraction" for every item and tell the student to express the answer as a fraction.\n` +
    `- Choose numbers that DO NOT divide evenly (e.g. 3 shared among 4 → 3/4, 7 among 2 → 7/2). Never numbers like 8 among 4 that give a whole number — those defeat the concept and can't be typed as a fraction.\n` +
    `- Write "answer" as "a/b" (e.g. "3/4"); "solutionExpression" is the division "a / b".`,
};

export const generateVerifiedItems = internalAction({
  args: { skillKey: v.string(), count: v.optional(v.number()), replace: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ requested: number; generated: number; verified: number; rejected: number; stored: number }> => {
    const count = args.count ?? 8;
    const skill: {
      label: string;
      grade: string | null;
      standardCodes: { framework: string; code: string }[];
      domain: string;
    } | null = await ctx.runQuery(internal.practiceSkills.getSkillInfo, { skillKey: args.skillKey });
    if (!skill) throw new Error(`Unknown skill ${args.skillKey}`);

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();

    // Over-generate so the verification gate can reject without starving us.
    const ask = Math.ceil(count * 1.5) + 2;
    const gradePhrase = skill.grade ? `a grade-${skill.grade} student` : "a student";
    const standardPhrase = skill.standardCodes.length
      ? ` (aligned to ${skill.standardCodes.map((s) => `${s.framework} ${s.code}`).join(", ")})`
      : "";
    const prompt =
      `Generate ${ask} short, friendly word problems for ${gradePhrase} practicing the skill ` +
      `"${skill.label}"${standardPhrase}.\n\n` +
      `Rules:\n` +
      `- Each problem has ONE unambiguous numeric answer.\n` +
      `- Write the stem as plain text. Do not use Markdown or formatting markers such as **bold**.\n` +
      `- Keep the numbers grade-appropriate for this skill.\n` +
      `- Mathematical precision: NEVER apply an integer concept to a fraction. Multiples/factors — and so LCM/GCF/LCD — belong to INTEGERS, not fractions. Never write "the LCD of 1/11 and 1/5", "a multiple of 2/3", or "the GCF of 3/4 and 1/2". Say the LCD is the LCM of the *denominators* (e.g. "the LCM of the denominators 11 and 5") or frame it around the operation ("To add 1/11 + 1/5, what's the least common denominator you could use?").\n` +
      `- Be concise: minimal, punchy, scannable wording — no padding or paragraph-length setups. These are gifted learners.\n` +
      `- Provide a "solutionExpression": a plain arithmetic expression (digits, + - * / and parentheses ONLY) that evaluates to the answer.\n` +
      `- Provide a "revealLine": one warm sentence that tells a student how to reach the answer if they haven't learned this yet. Use ONLY the numbers in this problem (its own quantities, the answer, or a value reached by doing the arithmetic on them) — NEVER a number from a different example. Plain text.\n` +
      `- If a problem tells the learner to express the answer AS A FRACTION, set "answerType" to "fraction" and write the answer like "3/4" — never a whole number (the answer pad only shows a "/" key for fraction items).\n` +
      `- Set "answerUnit" ONLY when the stem asks for a measurement in one of ${GEN_ANSWER_UNITS.join(", ")} (e.g. "What is its volume in cubic centimeters?" → "cm³"). The student then has to write that unit as part of the answer, so it must be a unit the stem names. Omit it otherwise — most problems have no unit.\n` +
      `- Vary the contexts (animals, food, sports, space, etc). Warm and curiosity-friendly, never babyish.` +
      (SKILL_DIRECTIVES[args.skillKey] ?? "");

    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 2048,
      tools: [GEN_TOOL],
      tool_choice: { type: "tool", name: "emit_problems" },
      messages: [{ role: "user", content: prompt }],
    });
    await recordAnthropicUsage(ctx, {
      source: "practice-gen",
      model: MODELS.HAIKU,
      usage: response.usage,
    });

    const block = response.content.find((b) => b.type === "tool_use");
    const genItems: GenItem[] =
      block && "input" in block && Array.isArray((block.input as { items?: unknown }).items)
        ? ((block.input as { items: GenItem[] }).items)
        : [];
    const candidates: Candidate[] = genItems;

    const { passed, rejected } = verifyBatch(candidates);

    // Normalize the stored answer through our typed parser so grading is exact.
    const toStore = passed
      .map((p) => {
        const typed = parseAnswer(p.candidate.answer, p.candidate.answerType as AnswerType);
        if (!typed) return null;
        const stem = p.candidate.stem.trim();
        const answerCanonical = formatAnswer(typed);
        // Placement warmth floor (Tier 1c): keep the model's reveal line ONLY if
        // it survives the S8 operand-substitution ban — its numbers must be the
        // item's own (stem quantities + the answer, or an arithmetic step on
        // them). A failing or absent line is dropped; the serve path degrades to
        // the deterministic Tier-2 floor, never a wrong line.
        const rawReveal = (p.candidate as GenItem).revealLine;
        const itemNumbers = [...extractNumbers(stem), ...extractNumbers(answerCanonical)];
        const revealLine =
          rawReveal && verifyRevealLine(rawReveal, itemNumbers).ok ? rawReveal.trim() : undefined;
        // The measurement unit the answer must carry, kept only if the registry
        // knows it AND the stem asks for it (see `generatedAnswerUnit`).
        const answerUnit = generatedAnswerUnit(stem, (p.candidate as GenItem).answerUnit);
        return {
          skillKey: args.skillKey,
          domain: skill.domain,
          stem,
          answerType: p.candidate.answerType,
          answerCanonical,
          verifierKind: "arithmetic",
          model: MODELS.HAIKU,
          ...(revealLine ? { revealLine } : {}),
          ...(answerUnit ? { answerUnit } : {}),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, count);

    const stored: number = await ctx.runMutation(internal.practiceSkills.storeGeneratedItems, {
      skillKey: args.skillKey,
      items: toStore,
      replace: args.replace ?? false,
    });

    return {
      requested: count,
      generated: candidates.length,
      verified: passed.length,
      rejected: rejected.length,
      stored,
    };
  },
});

/**
 * Materialize a problem set's authored targets once, off the write path.
 * Template items remain the fast serving source, but every target also receives
 * a verified, durable pool row. Existing core items cost no model call.
 */
export const ensureProblemSetItems = internalAction({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const problemSet = await ctx.runQuery(
      internal.practiceSkills.problemSetGenerationTargets,
      { activityId: args.activityId },
    );
    if (!problemSet) return { generated: 0, skipped: 0, failed: 0 };

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    for (const skillKey of problemSet.targetSkillKeys) {
      const existing = await ctx.runQuery(internal.practiceSkills.countStoredItems, {
        skillKey,
      });
      if (existing > 0) {
        skipped++;
        continue;
      }
      try {
        const outcome = await ctx.runAction(
          internal.practiceGen.generateVerifiedItems,
          { skillKey, count: 1 },
        );
        generated += outcome.stored;
        if (outcome.stored === 0) failed++;
      } catch (err) {
        console.error(`[ensureProblemSetItems] failed for ${skillKey}:`, err);
        failed++;
      }
    }
    return { generated, skipped, failed };
  },
});

/** Never generate more than this many items for a single conceptual node per run. */
const PREWARM_COUNT = 6;
/** A node is considered "already served" once it has at least this many stored items. */
const PREWARM_MIN_ITEMS = 4;

const INSTRUCTION_ANSWER_TYPES = [
  "integer",
  "decimal",
  "fraction",
  "expression",
  "multipleChoice",
] as const satisfies readonly AnswerType[];
const INSTRUCTION_ANSWER_TYPE_SET: ReadonlySet<string> = new Set(
  INSTRUCTION_ANSWER_TYPES,
);

function isInstructionAnswerType(value: unknown): value is AnswerType {
  return typeof value === "string" && INSTRUCTION_ANSWER_TYPE_SET.has(value);
}

type GeneratedInstructionAtom = Extract<
  VerifyAtom,
  { kind: "story_hook" | "micro_explain" | "worked_example" | "try_it" }
>;

export const INSTRUCTION_GEN_TOOL = {
  name: "emit_launchpad",
  description: "Return one short instructional 'Launchpad' for a strand doorway.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Short title naming the core move (<= 60 chars)." },
      subtitle: { type: "string", description: "Optional one-line subtitle (<= 100 chars)." },
      atoms: {
        type: "array",
        description:
          "1 optional story_hook first, then a micro_explain, then exactly one worked_example or try_it.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["story_hook", "micro_explain", "worked_example", "try_it"],
            },
            hook: { type: "string", description: "story_hook only: <= 200 chars, real-world, no mascot voice." },
            text: { type: "string", description: "micro_explain only: <= 300 chars, plain framing of the move." },
            strategyLabel: {
              type: "string",
              description: "worked_example or try_it only: names the move.",
            },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "worked_example or try_it only: 2-5 short steps.",
            },
            examplePrompt: {
              type: "string",
              description: "worked_example or try_it only: a NEW example problem.",
            },
            exampleAnswer: {
              type: "string",
              description:
                "worked_example or try_it only: its answer, derivable from the steps.",
            },
            answerType: {
              type: "string",
              enum: [...INSTRUCTION_ANSWER_TYPES],
              description:
                "try_it only: optional answer parser type; defaults to integer when omitted.",
            },
          },
          required: ["kind"],
        },
      },
    },
    required: ["title", "atoms"],
  },
};

export function normalizeInstructionAtoms(
  rawAtoms: Array<Record<string, unknown>>,
): GeneratedInstructionAtom[] {
  return rawAtoms
    .map((atom) => {
      if (atom.kind === "story_hook" && typeof atom.hook === "string") {
        return { kind: "story_hook" as const, hook: atom.hook };
      }
      if (atom.kind === "micro_explain" && typeof atom.text === "string") {
        return { kind: "micro_explain" as const, text: atom.text };
      }
      if (atom.kind === "worked_example") {
        return {
          kind: "worked_example" as const,
          strategyLabel: String(atom.strategyLabel ?? ""),
          steps: Array.isArray(atom.steps) ? atom.steps.map((step) => String(step)) : [],
          examplePrompt: String(atom.examplePrompt ?? ""),
          exampleAnswer: String(atom.exampleAnswer ?? ""),
        };
      }
      if (atom.kind === "try_it") {
        const answerType =
          atom.answerType === undefined
            ? "integer"
            : isInstructionAnswerType(atom.answerType)
              ? atom.answerType
              : null;
        if (answerType === null) return null;
        return {
          kind: "try_it" as const,
          strategyLabel: String(atom.strategyLabel ?? ""),
          steps: Array.isArray(atom.steps) ? atom.steps.map((step) => String(step)) : [],
          examplePrompt: String(atom.examplePrompt ?? ""),
          exampleAnswer: String(atom.exampleAnswer ?? ""),
          answerType,
        };
      }
      return null;
    })
    .filter((atom): atom is NonNullable<typeof atom> => atom !== null);
}

/**
 * Generate ONE strand-level "Launchpad" and store it through the shared
 * verify→store gate (`internal.instruction.storeInstructionContent`). Emits the
 * SAME atom shape as authored seed, so generated and authored content are
 * interchangeable and both are gated by `instructionVerify`. On-demand + live
 * model calls only; requires ANTHROPIC_API_KEY. The worked example or try_it
 * MUST use its own numbers (never a served item's) — the whole point of the
 * decoupled design.
 */
export const generateInstructionContent = internalAction({
  args: {
    domain: v.string(),
    strand: v.string(),
    moveDescription: v.string(),
    gradePhrase: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ key: string; status: "passed" | "failed"; version: number; report: string }> => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();
    const who = args.gradePhrase ?? "a curious young student";
    const prompt =
      `Write ONE short instructional "Launchpad" that introduces the strand "${args.strand}" ` +
      `in ${args.domain} to ${who}. The core move: ${args.moveDescription}.\n\n` +
      `Rules:\n` +
      `- Structure: an OPTIONAL one-sentence real-world story_hook, then a micro_explain (<= 300 chars) that plainly explains the move, then EXACTLY ONE worked_example or try_it.\n` +
      `- Teach-as-action: doing the step IS the reading. A try_it is the interactive twin of a worked_example: the same strategyLabel, 2-5 short steps, and a self-contained NEW examplePrompt with its exampleAnswer, but the scholar finishes the final answer-producing step.\n` +
      `- Prefer a try_it over a bare worked_example whenever the move has a crisp final answer-producing step. Set answerType to integer, decimal, fraction, expression, or multipleChoice as appropriate; it defaults to integer when omitted.\n` +
      `- The worked_example or try_it must use its OWN numbers and be fully decoupled from any live practice item. Never reference an outside problem.\n` +
      `- Teach the METHOD; do not just assert an answer. No phrases like "the answer is".\n` +
      `- Warm and precise, never babyish, never a mascot/first-person "I'm your friend" voice. No emoji. Plain text.`;

    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 1024,
      tools: [INSTRUCTION_GEN_TOOL],
      tool_choice: { type: "tool", name: "emit_launchpad" },
      messages: [{ role: "user", content: prompt }],
    });
    await recordAnthropicUsage(ctx, {
      source: "practice-gen",
      model: MODELS.HAIKU,
      usage: response.usage,
    });

    const block = response.content.find((b) => b.type === "tool_use");
    const input = (block && "input" in block ? block.input : {}) as {
      title?: string;
      subtitle?: string;
      atoms?: Array<Record<string, unknown>>;
    };
    // Normalize the model output to the stored atom union (drop stray fields).
    const atoms = normalizeInstructionAtoms(input.atoms ?? []);

    return await ctx.runMutation(internal.instruction.storeInstructionContent, {
      domain: args.domain,
      strand: args.strand,
      title: String(input.title ?? ""),
      subtitle: input.subtitle ? String(input.subtitle) : undefined,
      atoms,
      provenance: "generated",
    });
  },
});

const WORKED_EXAMPLE_TOOL = {
  name: "emit_worked_example",
  description: "Return ONE fresh worked example that teaches the given move.",
  input_schema: {
    type: "object" as const,
    properties: {
      strategyLabel: { type: "string", description: "Names the move (<= 60 chars)." },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "2-5 short steps that work the example, each <= 200 chars.",
      },
      examplePrompt: { type: "string", description: "A NEW example problem, different from any avoided one." },
      exampleAnswer: { type: "string", description: "Its answer, derivable from the steps." },
    },
    required: ["strategyLabel", "steps", "examplePrompt", "exampleAnswer"],
  },
};

type WorkedExampleAtom = Extract<VerifyAtom, { kind: "worked_example" }>;

type ExampleGenContext = {
  domain: string;
  strand: string;
  title: string;
  move: string;
  gradePhrase: string;
  baseExamplePrompt: string | null;
};

export const MAX_AVOID_PROMPTS = 20;
export const MAX_AVOID_PROMPT_CHARS = 300;

export function sanitizeAvoidPrompts(avoidPrompts: string[]): string[] {
  const sanitized: string[] = [];
  for (const prompt of avoidPrompts) {
    if (sanitized.length >= MAX_AVOID_PROMPTS) break;
    const trimmed = prompt.trim();
    if (!trimmed) continue;
    sanitized.push(trimmed.slice(0, MAX_AVOID_PROMPT_CHARS));
  }
  return sanitized;
}

/**
 * Core: generate ONE fresh worked example that teaches `genCtx.move`, avoiding
 * `avoidPrompts`, and return it only if it passes the deterministic
 * `verifyInstructionContent` gate (up to 3 tries). Returns null if every
 * candidate fails the gate or just repeats an avoided prompt. Records usage.
 * Never stores anything — the result is transient by design. Live model calls.
 */
async function generateVerifiedWorkedExample(
  ctx: ActionCtx,
  genCtx: ExampleGenContext,
  avoidPrompts: string[],
  institutionId?: Id<"institutions"> | null,
): Promise<WorkedExampleAtom | null> {
  const avoid = avoidPrompts.map((p) => p.trim()).filter(Boolean);
  const avoidClause = avoid.length
    ? `\n- Your examplePrompt MUST be clearly DIFFERENT from each of these already-seen examples (different numbers and, ideally, a different context):\n${avoid.map((p) => `  • ${p}`).join("\n")}`
    : "";

  const prompt =
    `Write ONE fresh WORKED example that teaches the move "${genCtx.move}" ` +
    `(strand "${genCtx.strand}" in ${genCtx.domain}) to ${genCtx.gradePhrase}.\n\n` +
    `Rules:\n` +
    `- Name the move (strategyLabel), give 2-5 short steps, and a NEW examplePrompt with its exampleAnswer.\n` +
    `- The answer must be derivable from its OWN steps and numbers. Never reference an outside problem.\n` +
    `- Teach the METHOD; do not just assert an answer. No phrases like "the answer is".\n` +
    `- Keep the numbers grade-appropriate for this move.\n` +
    `- Warm and precise, never babyish, never a mascot/first-person voice. No emoji. Plain text.` +
    avoidClause;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic();

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 1024,
      tools: [WORKED_EXAMPLE_TOOL],
      tool_choice: { type: "tool", name: "emit_worked_example" },
      messages: [{ role: "user", content: prompt }],
    });
    await recordAnthropicUsage(ctx, {
      source: "practice-gen",
      model: MODELS.HAIKU,
      usage: response.usage,
      institutionId,
    });

    const block = response.content.find((b) => b.type === "tool_use");
    const input = (block && "input" in block ? block.input : {}) as Record<string, unknown>;
    const candidate: WorkedExampleAtom = {
      kind: "worked_example",
      strategyLabel: String(input.strategyLabel ?? ""),
      steps: Array.isArray(input.steps) ? input.steps.map((s) => String(s)) : [],
      examplePrompt: String(input.examplePrompt ?? ""),
      exampleAnswer: String(input.exampleAnswer ?? ""),
    };

    // Reject a candidate that just repeats an already-seen example.
    const repeated = avoid.some(
      (p) => p.toLowerCase() === candidate.examplePrompt.trim().toLowerCase(),
    );
    if (repeated) continue;

    const verdict = verifyInstructionContent({ title: genCtx.title, atoms: [candidate] });
    if (verdict.status === "passed") return candidate;
  }
  return null;
}

/**
 * Generate ONE MORE fresh worked example on demand — powers the "Show me another"
 * control on the practice "See an example" shelf. Scholar-callable: auth + strand
 * context come from `api.instruction.exampleGenContext` (a scholar-self/teacher-of
 * gated query; identity propagates through runQuery), so an unauthorized caller
 * gets nothing. The example teaches the SAME move as the strand's canonical
 * Launchpad but with different numbers, avoiding `avoidPrompts` (the examples the
 * scholar has already seen this session). Every candidate passes the SAME
 * deterministic `verifyInstructionContent` gate the stored content passed; a
 * failing/absent candidate returns null (the sheet shows a gentle retry note)
 * rather than an unverified example. TRANSIENT — never stored, so it can't
 * overwrite the shared authored strand row (upsert-by-key). Live model calls.
 */
export const generateAnotherWorkedExample = action({
  args: {
    scholarId: v.id("users"),
    skillKey: v.string(),
    avoidPrompts: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<WorkedExampleAtom | null> => {
    const genCtx = await ctx.runQuery(api.instruction.exampleGenContext, {
      scholarId: args.scholarId,
      skillKey: args.skillKey,
    });
    if (!genCtx) return null;
    const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
      userId: args.scholarId,
      principal: "scholar",
    });
    // components/practice/InstructionExampleSheet.tsx is the sole UI caller:
    // its MAX_GENERATIONS=6 loop sends at most six concise seenPrompts. These
    // generous server-side caps bound prompt size without constraining real use.
    const clientAvoidPrompts = sanitizeAvoidPrompts(args.avoidPrompts ?? []);
    const avoidPrompts = [
      ...(genCtx.baseExamplePrompt ? [genCtx.baseExamplePrompt] : []),
      ...clientAvoidPrompts,
    ];
    return await generateVerifiedWorkedExample(ctx, genCtx, avoidPrompts, institutionId);
  },
});


/**
 * Pre-warm the genuinely-conceptual nodes (raise-the-ceiling §3, A4) with
 * verified LLM items at seed/deploy time, so every node in
 * `PRE_WARMED_CONCEPTUAL` (coverage.ts) is serveable even though it can't be
 * templated. Reuses `generateVerifiedItems` — no duplicated generation logic.
 *
 * Idempotent + cheap on re-seed: a node with >= PREWARM_MIN_ITEMS stored items
 * is skipped, so re-running `pnpm db:seed` never regenerates or duplicates.
 * Best-effort: a model hiccup or a verification-gate failure on ONE node is
 * logged and skipped, never thrown — a transient generation error must not
 * hard-fail the whole seed run.
 */
export const prewarmConceptualItems = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ node: string; generated: number; skipped: boolean; failed: boolean }[]> => {
    const results: { node: string; generated: number; skipped: boolean; failed: boolean }[] = [];

    for (const node of PRE_WARMED_CONCEPTUAL) {
      try {
        const existing: number = await ctx.runQuery(internal.practiceSkills.countStoredItems, {
          skillKey: node,
        });
        if (existing >= PREWARM_MIN_ITEMS) {
          results.push({ node, generated: 0, skipped: true, failed: false });
          continue;
        }

        const outcome = await ctx.runAction(internal.practiceGen.generateVerifiedItems, {
          skillKey: node,
          count: PREWARM_COUNT,
        });
        results.push({ node, generated: outcome.stored, skipped: false, failed: false });
      } catch (err) {
        // A single node's model hiccup or verification-gate failure must never
        // abort the rest of the seed run — log + continue.
        console.error(`[prewarmConceptualItems] failed for ${node}:`, err);
        results.push({ node, generated: 0, skipped: false, failed: true });
      }
    }

    return results;
  },
});

// ── Placement warmth-floor backfill (Tier 1c) ──────────────────────────────
// Give EXISTING stored LLM word-problem items a VERIFIED `revealLine` (new items
// get one at generation time in `generateVerifiedItems`). Idempotent +
// budget-capped: reads at most `limit` items still missing a line in ONE
// invocation, asks the fast model for a reveal line per item, and writes back
// only lines that clear the S8 operand-substitution ban (setItemRevealLine
// re-verifies). Re-invoke until `remaining` is 0. Manipulatives are skipped
// (no answer string). NEVER run against prod from a worktree — dev only.

const BACKFILL_TOOL = {
  name: "emit_reveal_lines",
  description: "Return one warm reveal line per problem, keyed by index.",
  input_schema: {
    type: "object" as const,
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The problem's index, as given." },
            revealLine: {
              type: "string",
              description:
                "One warm sentence telling a student how to reach the answer, using ONLY the numbers already in that problem (its own quantities, the answer, or a value reached by arithmetic on them). NEVER a number from a different example. Plain text, no Markdown.",
            },
          },
          required: ["index", "revealLine"],
        },
      },
    },
    required: ["lines"],
  },
};

export const backfillRevealLines = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; written: number; rejected: number }> => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
    const batch: { itemId: Id<"practiceItems">; stem: string; answerCanonical: string }[] =
      await ctx.runQuery(internal.practiceSkills.listItemsMissingRevealLine, { limit });
    if (batch.length === 0) return { scanned: 0, written: 0, rejected: 0 };

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();

    const listing = batch
      .map((b, i) => `${i}. Problem: ${b.stem}\n   Answer: ${b.answerCanonical}`)
      .join("\n");
    const prompt =
      `For each numbered math problem below, write ONE warm "reveal line": a single ` +
      `sentence that tells a student how to reach the answer, for when they say they ` +
      `haven't learned it yet.\n\n` +
      `Rules:\n` +
      `- Use ONLY the numbers already in that problem — its own quantities, the answer, ` +
      `or a value you reach by doing the arithmetic on them. NEVER introduce a number ` +
      `from a different example.\n` +
      `- Plain text, no Markdown. Warm and matter-of-fact; no persona, no emoji beyond a ` +
      `simple 👍 at most.\n` +
      `- Return one entry per index.\n\n${listing}`;

    const response = await anthropic.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 2048,
      tools: [BACKFILL_TOOL],
      tool_choice: { type: "tool", name: "emit_reveal_lines" },
      messages: [{ role: "user", content: prompt }],
    });
    await recordAnthropicUsage(ctx, {
      source: "practice-gen-backfill",
      model: MODELS.HAIKU,
      usage: response.usage,
    });

    const block = response.content.find((b) => b.type === "tool_use");
    const lines: { index: number; revealLine: string }[] =
      block && "input" in block && Array.isArray((block.input as { lines?: unknown }).lines)
        ? ((block.input as { lines: { index: number; revealLine: string }[] }).lines)
        : [];

    let written = 0;
    let rejected = 0;
    for (const line of lines) {
      const target = batch[line.index];
      if (!target || typeof line.revealLine !== "string") continue;
      // setItemRevealLine re-runs verifyRevealLine (the S8 gate) before writing.
      const ok: boolean = await ctx.runMutation(internal.practiceSkills.setItemRevealLine, {
        itemId: target.itemId,
        revealLine: line.revealLine,
      });
      if (ok) written++;
      else rejected++;
    }
    return { scanned: batch.length, written, rejected };
  },
});
