import { FINISH_AND_SEND_CONFIRM } from "@/shared/finishAndSend";

/** Ask before finishing an activity with no rubric (shared/finishAndSend.ts).
 *  The browser's own confirm, like the other confirmations here. */
export function confirmFinishAndSend(): boolean {
  if (typeof window === "undefined") return false;
  return window.confirm(
    `${FINISH_AND_SEND_CONFIRM.title}\n\n${FINISH_AND_SEND_CONFIRM.body}`,
  );
}
