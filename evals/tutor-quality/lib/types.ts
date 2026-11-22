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

/** The scholar-started chat a regenerate run rebuilds (TutorCase.sessionShape). */
export type SessionShape =
  | { kind: "ownQuestChat"; unitTitle: string }
  | { kind: "seedChat"; topic: string; domain: string | null };

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
  /** Regenerate mode: render the open-exploration "Wrap up" note, as the live
   *  tutor does for a session with no activity (set by --offers-wrap-up). */
  offersWrapUp?: boolean;
  /** Regenerate mode: rebuild the context of a chat the scholar started
   *  themselves, as getSessionContext assembles it: their own Quest's
   *  activity-less chat, or a seed chat with no activity. Both get the Wrap up
   *  note and no create_code. Absent = the bare prompt (no unit, no seed). */
  sessionShape?: SessionShape;
  scoringTarget?: string;
  preferredOutcome?: string;
  secondBeat?: FixtureSecondBeat;
}
