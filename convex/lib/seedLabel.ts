const ARROW_CONNECTOR_RE =
  /\s*(?:-{1,}>|[–—]+>|={1,}>|→|➜|➡|➔|➙|➛|➝|➞|➟|➠|➢|➤|➥|➦|➧|➨|➩|➪|➫|➬|➭|➮|➯|➱|➲|➳|➵|➸|➺|➻|➼|➽|➾|⟶|⟹|⇒|↦|↔|⟷|⇄|⇆)\s*/u;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function cleanSeedLabel(topic: string): string {
  const compact = collapseWhitespace(topic);
  const [head] = compact.split(ARROW_CONNECTOR_RE, 1);
  const label = collapseWhitespace(head ?? "");
  return label || compact;
}

/**
 * The text a scholar may read about a seed: the one rule every scholar-facing
 * read uses (the Sky, the Quests list, the seed list, the bake menu, card
 * copy).
 *
 * It never reads `rationale`: that field is teacher-private (it may name the
 * scholar, the gap, the misconception) and a teacher can edit it on any seed
 * (`seeds.update`). A scholar sees `scholarInvitation`, or nothing. The one
 * exception is a `badge_follow` seed written before that path also set
 * `scholarInvitation`: its trail line is rebuilt from `topic` and
 * `connectionTo` (the inspirer's name), using the same wording
 * `seeds.followBadge` writes, so it can't carry a teacher's note.
 */
export function seedScholarText(seed: {
  origin?: string;
  topic?: string;
  connectionTo?: string;
  scholarInvitation?: string;
}): string | null {
  if (seed.scholarInvitation) return seed.scholarInvitation;
  if (seed.origin === "badge_follow" && seed.topic && seed.connectionTo) {
    return `Inspired by the “${seed.topic}” badge ${seed.connectionTo} earned — chase the same trail and make it your own.`;
  }
  return null;
}
