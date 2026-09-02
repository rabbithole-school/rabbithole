/**
 * Escape Slack's three control characters in untrusted text before
 * interpolating it into mrkdwn. Slack decodes these entities when rendering.
 */
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
