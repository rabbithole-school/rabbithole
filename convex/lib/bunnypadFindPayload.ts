// The APNs payload for "Find my BunnyPad": a visible notification that plays
// a loud bundled tone (native/assets/sounds/find-bunnypad.caf, bundled by the
// expo-notifications plugin). Pure, so both the sender and its tests use it.
//
// Today it is a Time Sensitive notification at the iPad's alert volume.
// Measured on a Pilot iPad (iPadOS 27.2, 2026-11-07):
//   - Locked, the tone plays its full ~29 s on the Lock Screen.
//   - Unlocked, iOS stops the tone when the banner times out, ~8 s in.
//   - With Do Not Disturb on it is suppressed outright: no banner, no tone.
//     Time Sensitive does NOT break through the default Do Not Disturb.
// The unlocked cutoff is why the sender repeats the push (FIND_FOLLOW_UPS).
// A Critical Alert would ignore Do Not Disturb, the volume and mute, but
// needs an entitlement Apple grants case by case. When Apple grants it, the
// app is re-signed with the entitlement and the sender passes
// `critical: true` (env APNS_CRITICAL_ALERTS=1); nothing else changes.

/** Must match the file name the native app bundles. */
export const FIND_SOUND_FILE = "find-bunnypad.caf";

/** Lets the native foreground handler recognize a find (and nothing else). */
export const FIND_NOTIFICATION_KIND = "find-bunnypad";

/** A find that APNs couldn't deliver within this window is dropped, not
 *  played later: a beep an hour after someone stopped looking is noise. */
export const FIND_EXPIRATION_SECONDS = 120;

/**
 * Follow-up pushes after the first, so an unlocked iPad keeps sounding past
 * its ~8 s banner cutoff (measured above). The interval sits just past that
 * cutoff, so the next banner arrives as the last one leaves: three pushes
 * cover ~27 s unlocked. Locked, each arrival restarts the tone (iOS stops
 * the playing alert first), so the locked iPad sounds for ~47 s in all. The
 * whole run ends inside FIND_REPEAT_GUARD_MS, so a repeated ask can't stack.
 */
export const FIND_FOLLOW_UPS = 2;
export const FIND_FOLLOW_UP_INTERVAL_MS = 9_000;

export function buildFindPayload(opts: { critical: boolean }) {
  return {
    aps: {
      alert: {
        title: "Find my BunnyPad",
        body: "Someone is looking for this BunnyPad.",
      },
      sound: opts.critical
        ? { critical: 1, name: FIND_SOUND_FILE, volume: 1.0 }
        : FIND_SOUND_FILE,
      "interruption-level": opts.critical ? "critical" : "time-sensitive",
    },
    rabbithole: { kind: FIND_NOTIFICATION_KIND },
  };
}
