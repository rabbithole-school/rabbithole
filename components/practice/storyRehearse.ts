import type { StoryMoment } from "@/components/practice/StoryMomentCard";

export type StoryRehearseStory = {
  fromKey: string;
  toKey: string;
  fromLabel: string;
  hook: string;
  narrative: string;
  teaser?: string;
  visualEmoji?: string;
  artUrl?: string;
  probe?: string;
};

/**
 * Shape a curated edge story for the same scholar-facing reveal card used after
 * practice. This has no scholar identity or event id, so rehearsal cannot mint
 * a moment, seed, attempt, or mastery row.
 */
export function storyMomentForRehearsal(story: StoryRehearseStory): StoryMoment {
  return {
    fromKey: story.fromKey,
    toKey: story.toKey,
    skillLabel: story.fromLabel,
    hook: story.hook,
    narrative: story.narrative,
    ...(story.teaser === undefined ? {} : { teaser: story.teaser }),
    ...(story.visualEmoji === undefined ? {} : { visualEmoji: story.visualEmoji }),
    ...(story.artUrl === undefined ? {} : { artUrl: story.artUrl }),
    ...(story.probe === undefined ? {} : { probe: story.probe }),
    kindLabel: "story",
    hasApplication: false,
  };
}
