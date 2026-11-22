const STOPPED_RESPONSE_MARKER = "[The user stopped this response here.]";

/** How a reply the person stopped reads to the model on later turns. One
 * marker for every surface: the in-app chats (renderStoppedAssistantContent)
 * and Slack, whose transcript finds a stopped reply by its "Stopped" line. */
export function markStoppedAssistantContent(content: string): string {
  return content.trim()
    ? `${content}\n\n${STOPPED_RESPONSE_MARKER}`
    : STOPPED_RESPONSE_MARKER;
}

export function renderStoppedAssistantContent(
  content: string,
  stopRequestedAt: number | undefined,
): string {
  if (stopRequestedAt === undefined) return content;
  return markStoppedAssistantContent(content);
}
