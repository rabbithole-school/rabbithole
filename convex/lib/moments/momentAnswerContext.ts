/**
 * What the scholar was asked on the done-screen question card, and what they
 * answered — handed to the tutor when they follow "Why? →" into a session from
 * that moment's seed, so it can open from THEIR answer.
 */
import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { storyCardQuestion } from "../practice/storyCardQuestions";
import { seedCardQuestion } from "../practice/seedCardQuestions";
import { isValidCardQuestion } from "../../../shared/questionCard";

export type MomentAnswerContext = {
  prompt: string;
  choice: string;
  correct: boolean;
};

export async function momentAnswerContextForSeed(
  ctx: QueryCtx,
  seed: Doc<"seeds">,
): Promise<MomentAnswerContext | null> {
  const storyFromKey = seed.storyFromKey;
  const storyToKey = seed.storyToKey;
  const isStory = seed.origin === "story" && !!storyFromKey && !!storyToKey;
  const events = await ctx.db
    .query("momentEvents")
    .withIndex("by_scholar_edge", (q) =>
      isStory
        ? q
            .eq("scholarId", seed.scholarId)
            .eq("fromKey", storyFromKey)
            .eq("toKey", storyToKey)
        : q
            .eq("scholarId", seed.scholarId)
            .eq("fromKey", undefined)
            .eq("toKey", undefined),
    )
    .collect();
  const answered = events
    .filter(
      (e) =>
        e.answerIndex !== undefined &&
        e.answerCorrect !== undefined &&
        (isStory || e.seedId === seed._id),
    )
    .sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0))[0];
  if (!answered) return null;
  const question = isStory
    ? storyCardQuestion(storyFromKey!, storyToKey!)
    : seedCardQuestion(seed.topic);
  if (!isValidCardQuestion(question)) return null;
  const choice = question.choices[answered.answerIndex!];
  if (choice === undefined) return null;
  return {
    prompt: question.prompt,
    choice,
    correct: answered.answerCorrect!,
  };
}
