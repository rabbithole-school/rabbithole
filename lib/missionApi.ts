// Scholar-UI helpers for TRA-519 PR3: the server functions the done screen and
// Quest page call. Web and native twins.
import { api } from "@/convex/_generated/api";
import { effectiveActivityKind } from "@/shared/appSurface";

/** sessions.startFreePlay({ sessionId, idea? }) — "Build it now". */
export const startFreePlayRef = api.sessions.startFreePlay;

/** sessions.questFromParkedIdea({ sessionId, text }) — "Make it a Quest". */
export const questFromParkedIdeaRef = api.sessions.questFromParkedIdea;

/**
 * The activities the in-session "Up next" walks, in unit order: every one that
 * opens a session here — online activities AND app activities (a Quest's build
 * step; the iPad's useUnitProgress counts them too).
 */
export function upNextCandidates<
  A extends { _id: string; title: string; kind: string; appActivity?: boolean | null },
>(ordered: readonly A[]): A[] {
  return ordered.filter((a) => {
    const kind = effectiveActivityKind(a);
    return kind === "online" || kind === "vibecode";
  });
}
