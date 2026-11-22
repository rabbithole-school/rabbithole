// Scholar-UI helpers for TRA-519 PR3: the server functions the done screen and
// Quest page call. Web and native twins.
import { api } from "@/lib/convex";

/** sessions.startFreePlay({ sessionId, idea? }) — "Build it now". */
export const startFreePlayRef = api.sessions.startFreePlay;

/** sessions.questFromParkedIdea({ sessionId, text }) — "Make it a Quest". */
export const questFromParkedIdeaRef = api.sessions.questFromParkedIdea;
