// Walkie-talkie on the Folio's mic key. A quick press keeps the toggle (press
// to start, press again to send); a press held at least HOLD_TO_TALK_MS is
// push-to-talk, and letting go sends.
//
// Nothing runs on a timer: the release itself decides, from how long the key
// was down. So a keyboard that never reports the key coming up (iPadOS's
// press type 504 is undocumented) behaves exactly like the toggle, where the
// next press sends.

export const HOLD_TO_TALK_MS = 1_000;

type HeldTarget = {
  readonly state: string;
  confirm: () => void;
};

// A reader, not a target: voice targets are re-read on every call, so an
// object kept from the press would still say "idle" at the release. The reader
// returns undefined once the screen that took the press is gone.
let held: { read: () => HeldTarget | undefined; downAt: number } | null = null;

/** The mic key started a take on the target `read` returns. */
export function micKeyStartedTake(
  read: () => HeldTarget | undefined,
  now = Date.now(),
): void {
  held = { read, downAt: now };
}

/**
 * The mic key came back up (or iPadOS cancelled the press). Sends the take
 * when the key was held long enough; a short press leaves it recording.
 * Returns true when it sent.
 */
export function micKeyReleased(now = Date.now()): boolean {
  const press = held;
  held = null;
  if (!press || now - press.downAt < HOLD_TO_TALK_MS) return false;
  const target = press.read();
  // Escape (or a screen change) already ended the take while the key was held.
  if (!target) return false;
  if (target.state !== "connecting" && target.state !== "recording") {
    return false;
  }
  target.confirm();
  return true;
}
