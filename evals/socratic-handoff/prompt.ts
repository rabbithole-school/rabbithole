/**
 * The handoff prompt now SHIPS from convex/lib/practice/handoff.ts. This
 * re-export keeps the eval testing exactly what ships — they cannot drift.
 * See that module for the prompt text and FINDINGS.md for the leak measurements.
 * (The shipped copy folds in the rule-6 closing-turn fix — the fast-follow the
 * v3 run recommended — so re-run the harness to confirm it holds.)
 */
export {
  buildHandoffPrompt,
  type HandoffPacket,
  type HandoffEntryMode,
  type ScholarCoachContext,
} from "../../convex/lib/practice/handoff";
