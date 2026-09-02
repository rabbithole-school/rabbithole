/**
 * Runs one cast through one activity variant: simulate every kid, optionally
 * judge each session, aggregate. This is the inner unit both the Phase 1
 * analyze runner and the Phase 3 optimizer loop call — one variant evaluated
 * against the whole cast.
 */
import { runSession } from "./conversationDriver";
import { judgeSession, type SessionVerdict } from "./judge";
import { aggregate, type Aggregate } from "./score";
import type { ScholarProfile, SessionResult, SimActivity } from "./types";

export interface CastRun {
  sessions: SessionResult[];
  verdicts: SessionVerdict[]; // parallel to sessions; empty if judge disabled
  aggregate: Aggregate | null; // null if judge disabled
}

export async function runCastThroughActivity(
  activity: SimActivity,
  cast: ScholarProfile[],
  opts: {
    maxTurns?: number;
    offline?: boolean;
    judge?: boolean;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<CastRun> {
  const { maxTurns, offline = false, judge = false, onProgress } = opts;
  const sessions: SessionResult[] = [];
  const verdicts: SessionVerdict[] = [];
  for (const profile of cast) {
    onProgress?.(`  ▶ ${profile.name} (${profile.readingLevel})…`);
    const session = await runSession(profile, activity, { maxTurns, offline });
    sessions.push(session);
    if (judge) {
      const v = await judgeSession(activity, session, offline);
      verdicts.push(v);
      onProgress?.(`    ${session.stopReason} | goal ${v.goalAttainment}/5, struggle ${v.productiveStruggle}/5`);
    } else {
      onProgress?.(`    ${session.stopReason}`);
    }
  }
  return { sessions, verdicts, aggregate: judge ? aggregate(verdicts) : null };
}
