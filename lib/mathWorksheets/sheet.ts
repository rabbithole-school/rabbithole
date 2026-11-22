/**
 * One printable sheet, built from its URL: which skills, how many problems,
 * and a seed. Same URL, same sheet, so a teacher's answer key matches every
 * printed copy and a shared link reproduces the exact problems.
 *
 * Pure: the problems come from the deterministic templates
 * (convex/lib/practice/templates.ts) and the worked steps from the same
 * backward-fade the practice engine uses (fadedSteps.ts), always at level 1,
 * so the last, answer-producing step is left for the child.
 */

import {
  formatAnswer,
  formatAnswerForDisplay,
  formatUnit,
  type TypedAnswer,
  type UnitKey,
} from "@/convex/lib/practice/answers";
import { applyFade, DEFAULT_BLANK_TEXT, type FadeResult } from "@/convex/lib/practice/fadedSteps";
import { generateSet, type PracticeItem } from "@/convex/lib/practice/templates";
import type { PracticePromptVisual } from "@/shared/practicePromptVisual";
import { skillByKey } from "./catalog";
import { numerals } from "./themeRewrite";
import { COUNT_OPTIONS, DEFAULT_COUNT, DEFAULT_SEED, MAX_SEED, MAX_SKILLS, type SheetParams } from "./params";

export { COUNT_OPTIONS, DEFAULT_COUNT, DEFAULT_SEED, MAX_SKILLS, type SheetParams } from "./params";

type RawSearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Read `?skills=a,b&n=12&seed=4821`. Unknown skills are dropped, the page's
 * skill always leads, and anything out of range falls back to the default,
 * so a mangled link still prints a sensible sheet.
 */
export function parseSheetParams(primaryKey: string, sp: RawSearchParams): SheetParams {
  const extra = (first(sp.skills) ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k && k !== primaryKey && skillByKey(k));
  const skillKeys = [primaryKey, ...new Set(extra)].slice(0, MAX_SKILLS);
  const n = Number(first(sp.n));
  const count = (COUNT_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_COUNT;
  const s = Number(first(sp.seed));
  const seed = Number.isInteger(s) && s >= 1 && s <= MAX_SEED ? s : DEFAULT_SEED;
  return { skillKeys, count, seed };
}

export type SheetItem = {
  /** 1-based problem number on the sheet. */
  n: number;
  skillKey: string;
  stem: string;
  choices?: string[];
  promptVisual?: PracticePromptVisual;
  answerText: string;
  /** Worked steps with the final step blank, when the family has them. */
  steps?: FadeResult;
  /** A long stem, a table or a picture takes the full width of the sheet. */
  wide: boolean;
};

export type Sheet = {
  params: SheetParams;
  items: SheetItem[];
  /** Fewer than asked when the skills have only so many different problems. */
  short: boolean;
};

/** Stable per-skill offset so mixing in a skill never reshuffles the others. */
function keySalt(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 100_000;
}

/** Stems were written for a screen; a few say "type". On paper you write. */
export function paperWording(stem: string): string {
  return stem
    .replace(/\btype the\b/gi, "write the")
    .replace(/\bType\b/g, "Write")
    .replace(/\bEnter\b/g, "Write");
}

export function answerText(item: Pick<PracticeItem, "answer" | "choices" | "answerUnit">): string {
  const a: TypedAnswer = item.answer;
  let text = formatAnswerForDisplay(a, item.choices);
  if (a.type === "expression") {
    const rem = /^(-?\d+)r(\d+)$/i.exec(text);
    if (rem) text = `${rem[1]} R ${rem[2]}`;
  }
  if (item.answerUnit) {
    const unit: UnitKey = item.answerUnit;
    text = unit === "deg" ? `${text}${formatUnit(unit)}` : `${text} ${formatUnit(unit)}`;
  }
  return text;
}

const PAPER_PROMPT = "Now you finish the last step.";

export function buildSheet(params: SheetParams): Sheet {
  const k = params.skillKeys.length;
  const perSkill = Math.ceil(params.count / k);
  const pools = params.skillKeys.map((key) => generateSet(key, perSkill, params.seed + keySalt(key)));
  // Round-robin so a mixed sheet interleaves skills instead of blocking them.
  const picked: PracticeItem[] = [];
  for (let i = 0; picked.length < params.count && i < perSkill; i++) {
    for (const pool of pools) {
      if (picked.length >= params.count) break;
      if (pool[i]) picked.push(pool[i]);
    }
  }
  const items: SheetItem[] = picked.map((item, i) => {
    const stem = paperWording(item.stem);
    let steps: FadeResult | undefined;
    if (item.workedSteps && item.workedSteps.length >= 2) {
      const fade = applyFade(item.workedSteps, 1);
      // A faded step's prompt names the move ("Write 6/9 in simplest form"). When
      // the operand already IS the answer (2/3 - 1/3 gives "Write 1/3 in simplest
      // form"), that prompt hands the child the answer, so blank it instead.
      const answer = formatAnswer(item.answer);
      const faded = fade.faded.map((f) =>
        numerals(f.blankText).includes(answer) ? { blankText: DEFAULT_BLANK_TEXT } : f,
      );
      steps = { ...fade, faded, selfExplainPrompt: fade.selfExplainPrompt ? PAPER_PROMPT : undefined };
    }
    return {
      n: i + 1,
      skillKey: item.skillKey,
      stem,
      ...(item.choices ? { choices: item.choices } : {}),
      ...(item.promptVisual ? { promptVisual: item.promptVisual } : {}),
      answerText: answerText(item),
      ...(steps ? { steps } : {}),
      wide: Boolean(item.promptVisual) || stem.includes("|") || stem.length > 60 || (item.choices?.join("").length ?? 0) > 40,
    };
  });
  return { params, items, short: items.length < params.count };
}
