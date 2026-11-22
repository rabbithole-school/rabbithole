// The school-night BunnyPad charge reminder: which BunnyPads need a text, and
// what the text says. Pure, so the rule is tested without a database.
//
// The rule (review/bunnypad-charge-reminder-plan.html):
//   1. Take the freshest battery level: the app's own check-in if it is under
//      APP_CHECKIN_FRESH_MS old, else SimpleMDM's if the device reported it
//      under MDM_READING_FRESH_MS ago.
//   2. No reading → no text. The reminder is only for a battery KNOWN to be low.
//   3. Not low (the shared `deviceBatteryBand` line, under 20%, the same one the
//      08:00 low-battery alert uses) → no text.
//   4. A fresh app check-in that says charging or full → no text.
//   5. Otherwise → text. A missing or stale check-in never counts as plugged
//      in: a closed lid looks exactly like a charging iPad from here.

import {
  DEVICE_BATTERY_STALE_AFTER_MS,
  deviceBatteryBand,
} from "../../shared/deviceBattery";

/** An app check-in older than this says nothing about tonight's charger. */
export const APP_CHECKIN_FRESH_MS = 15 * 60_000;
/**
 * A SimpleMDM battery level older than this is too stale to text about. The
 * same line the devices console uses to show "Unknown" instead of the level.
 */
export const MDM_READING_FRESH_MS = DEVICE_BATTERY_STALE_AFTER_MS;

export type AppBatteryState = "unplugged" | "charging" | "full" | "unknown";

export type BatteryEvidence = {
  /** The BunnyPad app's last check-in that carried battery fields. */
  app: { at: number; level: number | null; state: AppBatteryState } | null;
  /** SimpleMDM's level, dated by when the device last reported to SimpleMDM. */
  mdm: { at: number; level: number } | null;
};

export type ChargeVerdict =
  | { send: true; level: number }
  | { send: false; reason: "no-reading" | "not-low" | "charging" };

export function chargeReminderVerdict(
  evidence: BatteryEvidence,
  nowMs: number,
): ChargeVerdict {
  const appFresh =
    evidence.app !== null && nowMs - evidence.app.at <= APP_CHECKIN_FRESH_MS
      ? evidence.app
      : null;
  const mdmFresh =
    evidence.mdm !== null && nowMs - evidence.mdm.at <= MDM_READING_FRESH_MS
      ? evidence.mdm
      : null;

  const level = appFresh?.level ?? mdmFresh?.level ?? null;
  if (level === null) return { send: false, reason: "no-reading" };
  if (deviceBatteryBand(level) !== "low") return { send: false, reason: "not-low" };
  if (appFresh?.state === "charging" || appFresh?.state === "full") {
    return { send: false, reason: "charging" };
  }
  return { send: true, level: Math.round(level) };
}

/** "Juniper's", "Juniper's and Ollie's", "Ada's, Juniper's and Ollie's". */
function possessiveList(names: string[]): string {
  const owned = names.map((name) => `${name}'s`);
  if (owned.length <= 1) return owned.join("");
  return `${owned.slice(0, -1).join(", ")} and ${owned.at(-1)}`;
}

export type ChargeReminderKid = { name: string; level: number };

/**
 * The text. Plain GSM-7 (straight apostrophes, no emoji) so the usual case is
 * one 160-character segment. One kid carries the percent; several kids drop
 * it to stay in one segment. `afterBreak` is the night before school resumes.
 */
export function chargeReminderText(args: {
  schoolName: string;
  kids: ChargeReminderKid[];
  afterBreak: boolean;
}): string {
  const { schoolName, kids, afterBreak } = args;
  if (kids.length === 1) {
    const [kid] = kids;
    return afterBreak
      ? `${schoolName}: School starts again tomorrow! ${kid.name}'s BunnyPad is at ${kid.level}%. Please plug it in tonight so it's ready. Reply NO REMINDERS to stop these.`
      : `${schoolName}: ${kid.name}'s BunnyPad is at ${kid.level}% and going to sleep for the night. Please plug it in for school tomorrow. Reply NO REMINDERS to stop these.`;
  }
  const owners = possessiveList(kids.map((kid) => kid.name));
  return afterBreak
    ? `${schoolName}: School starts again tomorrow! Please plug in ${owners} BunnyPads tonight so they're ready. Reply NO REMINDERS to stop.`
    : `${schoolName}: ${owners} BunnyPads are going to sleep. Please plug them in so they're charged for school tomorrow. Reply NO REMINDERS to stop.`;
}

export const CHARGE_REMINDERS_OFF_REPLY =
  "OK, no more charging reminders. You can still text us about your child or their BunnyPad.";
export const CHARGE_REMINDERS_ON_REPLY =
  "OK, charging reminders are back on. You'll get one on a school night when a BunnyPad battery is low.";

/**
 * A whole text that turns the reminder off or on. Matched in code, before the
 * aide, like STOP and HELP, so the model never decides it. A sentence that
 * merely mentions reminders goes to the aide as usual.
 */
export function chargeReminderKeyword(body: string): "off" | "on" | null {
  const words = body
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(no reminders?|stop reminders?|reminders? off|turn off reminders?|noreminders)$/.test(
      words,
    )
  ) {
    return "off";
  }
  if (/^(reminders? on|start reminders?|turn on reminders?)$/.test(words)) {
    return "on";
  }
  return null;
}
