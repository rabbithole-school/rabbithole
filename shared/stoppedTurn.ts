const STOPPED_RESPONSE_MARKER = "[The user stopped this response here.]";

export function renderStoppedAssistantContent(
  content: string,
  stopRequestedAt: number | undefined,
): string {
  if (stopRequestedAt === undefined) return content;
  return content.trim()
    ? `${content}\n\n${STOPPED_RESPONSE_MARKER}`
    : STOPPED_RESPONSE_MARKER;
}
