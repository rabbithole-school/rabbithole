import { useCallback, useEffect, useState } from "react";

// iOS presents only one view controller at a time. When a React Native
// `<Modal>` turns visible while another modal is already up (a chat bubble's
// Copy menu, another overlay), UIKit refuses it ("Attempt to present … which
// is already presenting …"), but React still renders the modal as visible.
// Its host view then sits invisibly over the whole app and swallows every tap:
// the back arrow, the activity stepper and Continue all go dead while a focused
// text field keeps taking keystrokes. Nothing on screen explains it, so a
// scholar cannot close it, and it stays until the app restarts (TRA-331,
// reproduced on a BunnyPad by awarding a badge while a Copy menu was open).
//
// A refused presentation never fires `onShow`. So if `onShow` has not arrived
// within SHOW_TIMEOUT_MS, take the modal down, which removes the invisible
// host, and try again RETRY_GAP_MS later. Once whatever was in the way closes,
// the next attempt presents normally.
//
// The timeout is generous because `onShow` waits for the presentation
// animation, and taking a modal down mid-animation would flicker it.
export const SHOW_TIMEOUT_MS = 2_000;
export const RETRY_GAP_MS = 1_000;

export function useModalPresentationRetry(requested: boolean) {
  const [shown, setShown] = useState(false);
  const [held, setHeld] = useState(false);

  // A modal that closes starts over next time it opens.
  const [prevRequested, setPrevRequested] = useState(requested);
  if (prevRequested !== requested) {
    setPrevRequested(requested);
    if (!requested) {
      setShown(false);
      setHeld(false);
    }
  }

  useEffect(() => {
    if (!requested || shown) return;
    if (held) {
      const retry = setTimeout(() => setHeld(false), RETRY_GAP_MS);
      return () => clearTimeout(retry);
    }
    const giveUp = setTimeout(() => setHeld(true), SHOW_TIMEOUT_MS);
    return () => clearTimeout(giveUp);
  }, [requested, shown, held]);

  // An onShow that lands after the hold began (a stalled JS thread, the
  // screen locking mid-animation) still counts: the modal really is up, so
  // keep it, rather than leave it hidden with no retry pending.
  const markShown = useCallback(() => {
    setShown(true);
    setHeld(false);
  }, []);

  return { visible: requested && !held, markShown };
}
