const FLAIR_EMOJIS = [
  "🪶",
  "🔎",
  "💡",
  "🎯",
  "🧭",
  "🌱",
  "🛠️",
  "🌈",
  "📚",
  "🧩",
  "🚀",
  "🎨",
] as const;

const SEMANTIC_EMOJIS: Array<{ pattern: RegExp; emoji: string }> = [
  { pattern: /\b(detail|specific|zoom|precis|observ|small moment)\w*/i, emoji: "🔎" },
  { pattern: /\b(sequence|order|organiz|structure|flow|follow)\w*/i, emoji: "🧭" },
  { pattern: /\b(evidence|source|cit|fact|reason|support)\w*/i, emoji: "🔬" },
  { pattern: /\b(explain|insight|idea|understand)\w*/i, emoji: "💡" },
  { pattern: /\b(creativ|original|imagin|design)\w*/i, emoji: "🎨" },
  { pattern: /\b(voice|tone|dialogue|speak)\w*/i, emoji: "🎙️" },
  { pattern: /\b(revis|edit|improv|polish)\w*/i, emoji: "🛠️" },
  { pattern: /\b(persist|effort|challenge|try)\w*/i, emoji: "🌱" },
  { pattern: /\b(compare|contrast|link|connect)\w*/i, emoji: "🔗" },
  { pattern: /\b(conclusion|goal|focus|claim|argument)\w*/i, emoji: "🎯" },
  { pattern: /\b(story|narrative|opening)\w*/i, emoji: "🪶" },
  { pattern: /\b(math|calculat|pattern|number)\w*/i, emoji: "🧩" },
];

export function flairEmojiForCriterion(
  criterionId: string,
  label = "",
): string {
  const semanticMatch = SEMANTIC_EMOJIS.find(({ pattern }) =>
    pattern.test(label),
  );
  if (semanticMatch) return semanticMatch.emoji;

  let hash = 0;
  for (const character of criterionId) {
    hash = (Math.imul(hash, 31) + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return FLAIR_EMOJIS[hash % FLAIR_EMOJIS.length];
}
