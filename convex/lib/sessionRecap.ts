import type { GrowthStory } from "./growthStories";

export type SessionRecapGrowthStory = Pick<
  GrowthStory,
  "conceptLabel" | "domain" | "latestAt" | "excerpt" | "studentInitiated"
>;

export type SessionRecapLine = {
  key: string;
  text: string;
  excerpt: string | null;
  conceptLabel: string;
  domain: string;
  tier: "growth" | "mirror" | "tiny";
};

export type SessionRecapObservation = {
  conceptLabel: string;
  domain: string;
  observedAt: number;
};

export const MAX_SESSION_RECAP_LINES = 3;
const MAX_EXCERPT_LENGTH = 160;
export const TINY_SESSION_RECAP_TEXT =
  "Short visit — this will be here when you want it.";

export function recapLinesFromGrowthStories(
  stories: SessionRecapGrowthStory[],
  maxLines = MAX_SESSION_RECAP_LINES,
): SessionRecapLine[] {
  return stories.slice(0, maxLines).map((story, index) => {
    const concept = conceptPhrase(story.conceptLabel);
    return {
      key: `${story.conceptLabel}:${story.latestAt}`,
      text: story.studentInitiated
        ? `You connected your own question to ${concept}.`
        : index === 0
          ? `You figured out something new about ${concept}.`
          : `You worked out another piece of ${concept}.`,
      excerpt: cleanExcerpt(story.excerpt),
      conceptLabel: story.conceptLabel,
      domain: story.domain,
      tier: "growth",
    };
  });
}

export function recapLinesFromSessionObservations(
  observations: readonly SessionRecapObservation[],
  maxConcepts = MAX_SESSION_RECAP_LINES,
): SessionRecapLine[] {
  const latestByConcept = new Map<string, SessionRecapObservation>();
  for (const observation of observations) {
    const key = observation.conceptLabel.trim().toLowerCase();
    if (!key) continue;
    const current = latestByConcept.get(key);
    if (!current || observation.observedAt > current.observedAt) {
      latestByConcept.set(key, observation);
    }
  }
  const concepts = [...latestByConcept.values()]
    .sort((a, b) => b.observedAt - a.observedAt)
    .slice(0, maxConcepts);
  if (concepts.length === 0) return [];

  const phrases = concepts.map((observation) =>
    conceptPhrase(observation.conceptLabel),
  );
  const joined =
    phrases.length === 1
      ? phrases[0]
      : phrases.length === 2
        ? `${phrases[0]} and ${phrases[1]}`
        : `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
  return [
    {
      key: `mirror:${concepts.map((observation) => observation.conceptLabel).join("|")}`,
      text: `Today you worked on ${joined}.`,
      excerpt: null,
      conceptLabel: concepts.map((observation) => observation.conceptLabel).join(", "),
      domain: concepts.map((observation) => observation.domain).join(", "),
      tier: "mirror",
    },
  ];
}

export function tinySessionRecap(): SessionRecapLine[] {
  return [
    {
      key: "tiny-close",
      text: TINY_SESSION_RECAP_TEXT,
      excerpt: null,
      conceptLabel: "",
      domain: "",
      tier: "tiny",
    },
  ];
}

function conceptPhrase(label: string): string {
  const trimmed = label.trim().replace(/[.!?]+$/g, "");
  if (!trimmed) return "this idea";
  return /^[A-Z][a-z]/.test(trimmed)
    ? `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`
    : trimmed;
}

function cleanExcerpt(excerpt: string | null): string | null {
  const clean = excerpt?.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").trim();
  if (!clean) return null;
  if (clean.length <= MAX_EXCERPT_LENGTH) return clean;
  return `${clean.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`;
}
