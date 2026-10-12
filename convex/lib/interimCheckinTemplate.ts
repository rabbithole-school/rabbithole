/**
 * The Interim Check-In evaluation template — the ONE definition of what the
 * form asks. Both the backend (validating which item keys a write may touch)
 * and the web editor (laying the form out) read it, so the form and the
 * stored ratings cannot drift apart.
 *
 * Transcribed from the school's "Interim Check-In evaluations" Google Doc
 * (Interim Academic & Whole Child Evaluation). Typos in the source are fixed
 * here, headings are sentence case, and the Cooking / PE "Approach to learning"
 * blocks — mis-headed "Social Sciences" in the source — are named for their
 * subject.
 *
 * Every item is rated on the doc's single "General progress scale". The
 * "not a preferred subject" line under each subject is a yes/no flag, not a
 * rating. Item keys are stored, so never rename one; retire it instead.
 *
 * Pure data — no server imports — so the web client can import it directly.
 */

export const INTERIM_RATINGS = [
  { value: "consistently", label: "Consistently" },
  { value: "usually", label: "Usually" },
  { value: "developing", label: "Developing" },
  { value: "needsSupport", label: "Needs support" },
  { value: "notObserved", label: "Not observed" },
] as const;

export type InterimRating = (typeof INTERIM_RATINGS)[number]["value"];

export type InterimItem = { key: string; label: string };
export type InterimGroup = {
  key: string;
  /** Sub-heading; omitted where the source form has none. */
  title?: string;
  items: InterimItem[];
};
export type InterimSection = {
  key: string;
  title: string;
  /** "academic" = a subject block; "wholeChild" = a general development area. */
  part: "academic" | "wholeChild";
  groups: InterimGroup[];
  /** The subject-level "not a preferred subject" yes/no flag, if any. */
  preferenceFlag?: InterimItem;
};

const approach = (
  subject: string,
  title: string,
  opts: { risk: "intellectual" | "creative" | null },
): InterimGroup => ({
  key: `${subject}.approach`,
  title,
  items: [
    { key: `${subject}.approach.curiosity`, label: "Shows curiosity and enthusiasm for learning" },
    { key: `${subject}.approach.persistence`, label: "Persists when work is challenging" },
    ...(opts.risk
      ? [{ key: `${subject}.approach.risks`, label: `Takes appropriate ${opts.risk} risks` }]
      : []),
  ],
});

const preference = (subject: string, label: string): InterimItem => ({
  key: `${subject}.notPreferred`,
  label,
});

export const INTERIM_SECTIONS: InterimSection[] = [
  {
    key: "math",
    title: "Mathematics",
    part: "academic",
    groups: [
      {
        key: "math.pcm",
        items: [
          { key: "math.core", label: "Core: demonstrates understanding of mathematical knowledge, concepts, and skills" },
          { key: "math.connections", label: "Connections: makes connections among mathematical concepts, other areas of learning and disciplines, and real-world situations" },
          { key: "math.practice", label: "Practice: applies mathematical skills, strategies, and reasoning to solve problems independently" },
        ],
      },
      approach("math", "Approach to learning mathematics", { risk: "intellectual" }),
    ],
    preferenceFlag: preference("math", "Math does not seem to be a preferred subject area; some resistance to learning"),
  },
  {
    key: "science",
    title: "Science",
    part: "academic",
    groups: [
      {
        key: "science.pcm",
        items: [
          { key: "science.core", label: "Core: demonstrates understanding of scientific knowledge, concepts, and principles" },
          { key: "science.connections", label: "Connections: makes connections among scientific ideas, areas of learning and disciplines, and the natural world" },
          { key: "science.practice", label: "Practice: uses observation, investigation, evidence, and scientific reasoning to explore questions and solve problems" },
        ],
      },
      approach("science", "Approach to learning science", { risk: "intellectual" }),
    ],
    preferenceFlag: preference("science", "Science does not seem to be a preferred subject area; some resistance to learning"),
  },
  {
    key: "humanities",
    title: "Humanities",
    part: "academic",
    groups: [
      {
        key: "humanities.pcm",
        items: [
          { key: "humanities.core", label: "Core: demonstrates understanding of essential ideas, events, cultures, and perspectives" },
          { key: "humanities.connections", label: "Connections: makes connections across history, geography, culture, literature, and contemporary life" },
          { key: "humanities.practice", label: "Practice: uses evidence, research, discussion, and analysis to develop and communicate ideas" },
        ],
      },
      approach("humanities", "Approach to learning humanities", { risk: "intellectual" }),
    ],
    preferenceFlag: preference("humanities", "Humanities does not seem to be a preferred subject area; some resistance to learning"),
  },
  {
    key: "studioArt",
    title: "Studio art",
    part: "academic",
    groups: [
      {
        key: "studioArt.participation",
        items: [
          { key: "studioArt.engagement", label: "Engagement" },
          { key: "studioArt.followsDirections", label: "Follows directions" },
          { key: "studioArt.collaboration", label: "Collaborates with others" },
        ],
      },
      approach("studioArt", "Approach to learning studio art", { risk: "creative" }),
    ],
    preferenceFlag: preference("studioArt", "Studio art does not seem to be a preferred subject area; some resistance to learning"),
  },
  {
    key: "cooking",
    title: "Cooking",
    part: "academic",
    groups: [
      {
        key: "cooking.participation",
        items: [
          { key: "cooking.engagement", label: "Engagement" },
          { key: "cooking.followsDirections", label: "Follows directions" },
          { key: "cooking.collaboration", label: "Collaborates with others" },
        ],
      },
      approach("cooking", "Approach to learning cooking", { risk: null }),
    ],
    preferenceFlag: preference("cooking", "Cooking does not seem to be a preferred subject area; some resistance to learning"),
  },
  {
    key: "pe",
    title: "Physical education / karate",
    part: "academic",
    groups: [
      {
        key: "pe.participation",
        items: [
          { key: "pe.engagement", label: "Engagement" },
          { key: "pe.followsRules", label: "Follows directions and rules" },
          { key: "pe.teamwork", label: "Teamwork and collaboration with others" },
          { key: "pe.sportsmanship", label: "Sportsmanship" },
        ],
      },
      approach("pe", "Approach to learning PE and karate", { risk: "intellectual" }),
    ],
    preferenceFlag: preference("pe", "Karate / PE does not seem to be a preferred subject area; some resistance to learning"),
  },
  {
    key: "creativity",
    title: "General creativity and inquiry",
    part: "wholeChild",
    groups: [
      {
        key: "creativity.items",
        items: [
          { key: "creativity.originalIdeas", label: "Generates original ideas and approaches" },
          { key: "creativity.questions", label: "Asks thoughtful and meaningful questions" },
          { key: "creativity.depth", label: "Explores ideas with curiosity, depth, and complexity" },
        ],
      },
    ],
  },
  {
    key: "executiveFunction",
    title: "Basic executive functions",
    part: "wholeChild",
    groups: [
      {
        key: "executiveFunction.items",
        items: [
          { key: "executiveFunction.attention", label: "Sustains attention appropriate to the task" },
          { key: "executiveFunction.organization", label: "Organizes materials and manages time" },
          { key: "executiveFunction.independence", label: "Begins and completes tasks with appropriate independence" },
        ],
      },
    ],
  },
  {
    key: "emotional",
    title: "Emotional development",
    part: "wholeChild",
    groups: [
      {
        key: "emotional.items",
        items: [
          { key: "emotional.frustration", label: "Manages frustration and disappointment appropriately" },
          { key: "emotional.feedback", label: "Responds appropriately to feedback and redirection" },
          { key: "emotional.recovery", label: "Recovers and moves forward after setbacks" },
        ],
      },
    ],
  },
  {
    key: "selfAwareness",
    title: "Self-awareness and responsibility",
    part: "wholeChild",
    groups: [
      {
        key: "selfAwareness.items",
        items: [
          { key: "selfAwareness.strengths", label: "Recognizes personal strengths and areas for growth" },
          { key: "selfAwareness.seeksHelp", label: "Seeks assistance when appropriate" },
          { key: "selfAwareness.responsibility", label: "Takes increasing responsibility for choices and learning" },
        ],
      },
    ],
  },
  {
    key: "social",
    title: "General social development",
    part: "wholeChild",
    groups: [
      {
        key: "social.items",
        items: [
          { key: "social.relationships", label: "Builds positive relationships with peers" },
          { key: "social.collaboration", label: "Collaborates and participates effectively" },
          { key: "social.empathy", label: "Demonstrates empathy and respect for others" },
        ],
      },
    ],
  },
];

export const INTERIM_COMMENT_FIELDS = [
  { key: "strengths", label: "Areas of strength and interest" },
  { key: "growth", label: "Areas for continued growth" },
  { key: "familyGoals", label: "Progress on family goals / next steps" },
] as const;

export type InterimCommentKey = (typeof INTERIM_COMMENT_FIELDS)[number]["key"];

/** Every ratable item key, in form order. */
export const INTERIM_ITEM_KEYS: string[] = INTERIM_SECTIONS.flatMap((s) =>
  s.groups.flatMap((g) => g.items.map((i) => i.key)),
);

/** Every "not a preferred subject" flag key. */
export const INTERIM_FLAG_KEYS: string[] = INTERIM_SECTIONS.flatMap((s) =>
  s.preferenceFlag ? [s.preferenceFlag.key] : [],
);

/** How many items carry a rating — the editor's and roster's progress read. */
export function interimRatedCount(ratings: Record<string, string>): number {
  return INTERIM_ITEM_KEYS.filter((k) => ratings[k] !== undefined).length;
}

/** Whether any part of a check-in has been filled in — the one "started" rule. */
export function interimHasContent(row: {
  ratings: Record<string, string>;
  flags: string[];
  comments: Record<string, string>;
}): boolean {
  return (
    interimRatedCount(row.ratings) > 0 ||
    row.flags.length > 0 ||
    Object.values(row.comments).some((c) => c.trim().length > 0)
  );
}
