/**
 * The problems-in-chat (⑮) tutor integration SHIPS from
 * convex/lib/practice/chatPractice.ts. This re-export keeps the eval testing
 * exactly what ships — the tutor-visible prompt section and the tool spec
 * cannot drift from what the live tutor would receive once the gate flips on.
 *
 * (The gate itself — chatPracticeEnabled() — is NOT exercised here: the eval's
 * whole point is to measure the section's behavior AS IF it were on, so we
 * import buildChatPracticeSection directly. In production the same text is
 * appended only when CHAT_PRACTICE_ENABLED is set. See that module + the
 * roadmap §8 for the risk framing, and FINDINGS.md for the measured scores.)
 */
export {
  buildActivitySection,
  type LessonActivityContext,
} from "../../convex/sessionHelpers";

export {
  buildChatPracticeSection,
  hasExplicitPracticeWithholdSignal,
  SERVE_PRACTICE_PROBLEM_TOOL,
  resolveChatPracticeSkill,
  serveChatItem,
  type ChatPracticeSectionCtx,
  type SkillCandidate,
} from "../../convex/lib/practice/chatPractice";
