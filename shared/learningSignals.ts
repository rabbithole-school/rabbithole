/** The complete vocabulary and audience-specific copy for session signals. */
export const SESSION_SIGNAL_TYPES = [
  "task_commitment",
  "creative_approach",
  "self_direction",
  "intellectual_intensity",
  "emotional_engagement",
  "cross_domain_thinking",
  "productive_struggle",
  "metacognition",
] as const;

export type SessionSignalType = (typeof SESSION_SIGNAL_TYPES)[number];

export type LearningSignalMetadata = {
  type: SessionSignalType;
  teacherLabel: string;
  teacherDescription: string;
  promptDescription: string;
  scholarTitle: string;
  scholarBlurb: string;
  emoji: string;
};

export const SESSION_SIGNAL_META: Record<
  SessionSignalType,
  LearningSignalMetadata
> = {
  task_commitment: {
    type: "task_commitment",
    teacherLabel: "Task commitment",
    teacherDescription: "Sustained focus, persistence, returning to hard problems",
    promptDescription: "sustained focus, persistence, returning to hard problems",
    scholarTitle: "You stick with hard problems",
    scholarBlurb: "Coming back to something difficult until it gives way.",
    emoji: "🎯",
  },
  creative_approach: {
    type: "creative_approach",
    teacherLabel: "Creative approach",
    teacherDescription: "Novel methods, inventions, original solutions",
    promptDescription: "novel methods, inventions, original solutions",
    scholarTitle: "You find your own ways in",
    scholarBlurb: "Trying methods nobody handed you.",
    emoji: "💡",
  },
  self_direction: {
    type: "self_direction",
    teacherLabel: "Self-direction",
    teacherDescription: "Student-initiated investigations, choosing own path",
    promptDescription: "student-initiated investigations, choosing own path",
    scholarTitle: "You steer your own learning",
    scholarBlurb: "Picking your own questions and chasing them down.",
    emoji: "🧭",
  },
  intellectual_intensity: {
    type: "intellectual_intensity",
    teacherLabel: "Intellectual intensity",
    teacherDescription: "Rapid-fire questions, deep diving, can't let go",
    promptDescription: "rapid-fire questions, deep diving, can't let go",
    scholarTitle: "You dig into ideas",
    scholarBlurb: "Asking question after question because you have to know.",
    emoji: "🔥",
  },
  emotional_engagement: {
    type: "emotional_engagement",
    teacherLabel: "Emotional engagement",
    teacherDescription: "Strong reactions to ideas, empathy, moral reasoning",
    promptDescription: "strong reactions to ideas, empathy, moral reasoning",
    scholarTitle: "You care about ideas",
    scholarBlurb: "Reacting strongly when something matters, and saying why.",
    emoji: "💜",
  },
  cross_domain_thinking: {
    type: "cross_domain_thinking",
    teacherLabel: "Cross-domain thinking",
    teacherDescription: "Connecting ideas across subjects unprompted",
    promptDescription: "connecting ideas across subjects unprompted",
    scholarTitle: "You connect across subjects",
    scholarBlurb: "Spotting the same pattern in two different subjects.",
    emoji: "🔗",
  },
  productive_struggle: {
    type: "productive_struggle",
    teacherLabel: "Productive struggle",
    teacherDescription: "Wrestling with difficulty constructively",
    promptDescription: "wrestling with difficulty constructively",
    scholarTitle: "You stay in the struggle",
    scholarBlurb: "Letting a hard thing be hard until it teaches you something.",
    emoji: "⛰️",
  },
  metacognition: {
    type: "metacognition",
    teacherLabel: "Metacognition",
    teacherDescription: "Thinking about own thinking, noticing own confusion",
    promptDescription: "thinking about own thinking, noticing own confusion",
    scholarTitle: "You notice your own thinking",
    scholarBlurb: "Catching your own confusion and naming it out loud.",
    emoji: "🪞",
  },
};

export function sessionSignalMeta(
  type: string,
): LearningSignalMetadata | undefined {
  if (!Object.prototype.hasOwnProperty.call(SESSION_SIGNAL_META, type)) {
    return undefined;
  }
  return SESSION_SIGNAL_META[type as SessionSignalType];
}
