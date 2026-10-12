// Validators for server-backed AI inside sandboxed apps: the authored spec an
// app carries (a conversational character and/or one-shot judges) and the
// tutor-spoken line delivered to the app through its `appStates` row. Limits on
// these strings live in shared/appAiPolicy.ts and are enforced by the writers.
import { v } from "convex/values";

export const characterSpecValidator = v.object({
  name: v.string(),
  // Server-only: never sent to the sandbox.
  persona: v.string(),
  moods: v.array(v.string()),
  verdicts: v.optional(v.array(v.string())),
  greeting: v.optional(v.string()),
  // For the directing tutor only: never sent to the sandbox, the character's
  // own model, or a scholar.
  directorNotes: v.optional(v.string()),
});

export const judgeSpecValidator = v.object({
  // Matches APP_JUDGE_ID_PATTERN; the app calls rabbithole.judge(id, answer).
  id: v.string(),
  // Server-only: never sent to the sandbox.
  rubric: v.string(),
  verdicts: v.array(v.string()),
});

export const appAiSpecValidator = v.object({
  character: v.optional(characterSpecValidator),
  judges: v.optional(v.array(judgeSpecValidator)),
  updatedAt: v.number(),
});

export const characterLineValidator = v.object({
  id: v.string(),
  line: v.string(),
  mood: v.optional(v.string()),
  verdict: v.optional(v.string()),
  requestedAt: v.number(),
});
