/**
 * Shared types for the tutor-quality eval. A "case" is one conversation to
 * judge. Two sources: hand-authored fixtures and real shipped transcripts pulled
 * from Convex (--case prod:<projectId>).
 */

export interface ScholarContext {
  name: string | null;
  readingLevel: string | null;
}

export interface AnchorContext {
  unitTitle: string | null;
  lessonTitle: string | null;
  activityTitle: string | null;
  activityKind: "online" | "offline" | "shareBack" | null;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface FixtureSecondBeat {
  scholarReply: string;
  followThroughMust: string[];
  followThroughMustNot: string[];
}

/** A whole conversation to evaluate. */
export interface TutorCase {
  id: string;
  description: string;
  scholar: ScholarContext;
  anchor: AnchorContext | null; // null = Independent Study
  turns: Turn[];                 // ordered; first turn is usually "<start>"
  source: "fixture" | "prod";
  stallType?: "scalable" | "conceptual" | "representational" | "missing-prerequisite";
  masteryContext?: Array<{
    concept: string;
    domain: string;
    level: number;
    confidence: number;
    evidence: string;
    studentInitiated: boolean;
  }>;
  practiceSkillsContext?: {
    domain: string;
    fluentLabels: string[];
    advancedLabels: string[];
    frontierLabels: string[];
    dueLabels: string[];
  };
  scoringTarget?: string;
  preferredOutcome?: string;
  secondBeat?: FixtureSecondBeat;
}
