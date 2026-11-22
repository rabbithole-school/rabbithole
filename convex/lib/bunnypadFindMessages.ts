// What the aide says back after a find. Pure, so the wording a parent or
// staffer reads is testable without APNs. Every sentence is a fact the code
// knows: "sent" means APNs accepted it, never "it's beeping".

export type FindOutcome = {
  /** APNs accepted the push for this many iPads. */
  sent: number;
  /** No usable token: an older build, never opened, or a token Apple retired. */
  unregistered: number;
  /** Rows skipped by the 30-second repeat guard. */
  recentlyFound: number;
  /** APNs refused, or didn't answer, so delivery is unconfirmed. */
  failed: number;
  /** APNs isn't configured on this deployment (no key in env). */
  notConfigured: boolean;
};

export function findOutcomeMessage(
  outcome: FindOutcome,
  subject: { kind: "child"; name: string } | { kind: "staff" },
): string {
  const whose =
    subject.kind === "child" ? `${subject.name}'s BunnyPad` : "the iPad";
  const n = (count: number, one: string, many: string) =>
    count === 1 ? one : `${count} ${many}`;
  if (outcome.notConfigured) {
    return "Find sounds aren't set up yet, so nothing was sent. The school needs to finish setting up notifications first.";
  }
  const parts: string[] = [];
  if (outcome.sent > 0) {
    parts.push(
      `Sent a find sound to ${subject.kind === "child" ? whose : n(outcome.sent, "the iPad", "iPads")}. If it's on and connected to Wi-Fi, it plays a loud tone for about 30 seconds within a few seconds. It stays silent while Do Not Disturb is on, and it can't reach a BunnyPad that's off, out of battery, or offline.`,
    );
  }
  if (outcome.recentlyFound > 0) {
    parts.push(
      `A find sound went to ${outcome.sent > 0 ? n(outcome.recentlyFound, "another iPad", "other iPads") : whose} less than 30 seconds ago, so I didn't send another. Ask again once it finishes.`,
    );
  }
  if (outcome.unregistered > 0) {
    parts.push(
      `${outcome.sent + outcome.recentlyFound > 0 ? n(outcome.unregistered, "One iPad", "iPads") : whose[0].toUpperCase() + whose.slice(1)} can't play a find sound yet. Open Rabbithole on it once, updating it first if it's an older version.`,
    );
  }
  if (outcome.failed > 0) {
    parts.push(
      `Apple didn't confirm ${n(outcome.failed, "one find sound", "find sounds")}, so ${outcome.failed === 1 ? "that iPad" : "those iPads"} may not play it. Try again in a minute.`,
    );
  }
  return parts.join(" ");
}
