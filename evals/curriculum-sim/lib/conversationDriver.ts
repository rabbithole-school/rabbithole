/**
 * The conversation driver — alternates the Scholar Simulator and the real tutor
 * for up to `maxTurns` exchanges, until the kid signals goal/stuck. This loop is
 * the seam that lets us measure CURRICULUM, not just prompt wording: the kid
 * reacts to whatever the tutor actually said, so the transcript is emergent.
 */
import { generateScholarTurn } from "./scholarSimulator";
import { generateTutorTurn } from "./runTutor";
import type { ScholarProfile, SessionResult, SimActivity, SimTurn } from "./types";

export async function runSession(
  profile: ScholarProfile,
  activity: SimActivity,
  opts: { maxTurns?: number; offline?: boolean; onTurn?: (t: SimTurn) => void } = {},
): Promise<SessionResult> {
  const maxTurns = opts.maxTurns ?? 12;
  const offline = opts.offline ?? false;
  const turns: SimTurn[] = [];
  const push = (t: SimTurn) => {
    turns.push(t);
    opts.onTurn?.(t);
  };

  // Tutor opens (the production <start> greeting).
  push({ role: "tutor", content: await generateTutorTurn(profile, activity, [], offline) });

  for (let i = 0; i < maxTurns; i++) {
    const reply = await generateScholarTurn(profile, activity, turns, offline);
    push({ role: "scholar", content: reply.text });
    if (reply.stop) return { profile, turns, stopReason: reply.stop };
    push({ role: "tutor", content: await generateTutorTurn(profile, activity, turns, offline) });
  }
  return { profile, turns, stopReason: "maxTurns" };
}
