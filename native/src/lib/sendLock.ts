// Single-flight guard for the "claim + persist" phase of a tutor turn.
//
// The composer deliberately stays editable while the tutor streams (a submit
// mid-reply STEERS: stop the in-flight reply, send the new turn), and the
// composer is deliberately cleared only AFTER sessions.sendMessage resolves so
// a rejected send never loses the scholar's text. Those two choices leave a
// window — between the submit and the mutation resolving — in which the same
// unchanged text is still in the box and another submit (Return pressed twice,
// Return + a tap on the send arrow, a hardware-keyboard key repeat) would
// persist a SECOND identical user message.
//
// The lock closes that window: it is claimed SYNCHRONOUSLY, before the first
// await, so a second submit in the same or a later tick no-ops, and it is
// released the moment the mutation settles — so steering with genuinely new
// text (which happens once the tutor is actually streaming) still works, and a
// failed send can be retried immediately with the text still in the composer.
//
// Web's equivalent is hooks/useSendLock.ts (`runWithSendLock`), which wraps the
// same phase of components/SessionInterface.tsx's handleSend.
export type SendLock = {
  /** True while a send's claim+persist phase is pending. */
  isLocked: () => boolean;
  /** Claim the lock. Returns false if a send is already pending. */
  acquire: () => boolean;
  /**
   * Release the outstanding claim. This frees WHOEVER holds the lock — it is
   * not scoped to the caller — so call it exactly once per successful
   * `acquire()`. A second call after another holder has claimed the lock would
   * hand that holder's window away; callers that release from more than one
   * code path (a happy path plus a `finally` safety net) must guard with their
   * own once-flag.
   */
  release: () => void;
};

export function createSendLock(): SendLock {
  let locked = false;
  return {
    isLocked: () => locked,
    acquire: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    release: () => {
      locked = false;
    },
  };
}

/**
 * Identity of a composer submission — its text plus any attached image.
 *
 * The send lock closes the window while a send is in flight; this key closes
 * the much narrower one AFTER it, because clearing the composer is a React
 * state update that commits on a later task. The caller stamps the key of the
 * send it just persisted and refuses a submission that matches it, so the
 * already-rendered submit handler cannot re-send the text it closed over.
 * Image-only sends are covered too: the attachment id is part of the key, so a
 * newly attached image is always a new submission.
 */
export function composerPayloadKey(
  text: string,
  imageId: string | null | undefined,
): string {
  // The image id leads and can't contain NUL, so the delimiter is unambiguous
  // however the free-form text ends.
  return `${imageId ?? ""}\u0000${text}`;
}
