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
