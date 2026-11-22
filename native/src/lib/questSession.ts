import { createContext, useContext } from "react";
import type { FunctionReturnType } from "convex/server";

import type { api } from "@/lib/convex";

/**
 * Whether the open session is an approved Quest's (TRA-720), looked up once
 * per session screen by `QuestShowingProvider` (components/QuestShowing.tsx)
 * and read here by what depends on it: the header's "I'm ready to show" pill,
 * and the hand-ins a Quest's session doesn't offer ("Send to teacher",
 * "Finish and send"). Its own module, free of UI imports, so a footer can read
 * it without pulling in the sheet.
 */
export type ApprovedQuest = FunctionReturnType<
  typeof api.questProposals.forSelf
>["approved"][number];

export type QuestSession = {
  /** The session's approved Quest; null when it isn't one; undefined while
   *  the read is on its way (so a hand-in doesn't flash up and vanish). */
  quest: ApprovedQuest | null | undefined;
  /** Opens the "How does it work?" sheet. */
  openReadyToShow: () => void;
};

export const QuestSessionContext = createContext<QuestSession>({
  quest: null,
  openReadyToShow: () => {},
});

export function useQuestSession(): ApprovedQuest | null | undefined {
  return useContext(QuestSessionContext).quest;
}
