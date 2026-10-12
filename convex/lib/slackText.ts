/**
 * Escape Slack's three control characters in untrusted text before
 * interpolating it into mrkdwn. Slack decodes these entities when rendering.
 */
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A Slack `<@U…>` mention. The id comes from our own DB (an admin links it in
 * /admin), but it is still interpolated into markup — allowlist the characters
 * a member id can contain rather than trusting the column, so nothing can close
 * the mention early and inject its own markup.
 *
 * Lives beside `escapeSlackText` because it is the same job: the safe way to
 * put a value we did not author into Slack markup. Callers: the proposal
 * reviewer group DM and the `send_slack_dm` staff relay.
 */
export function slackMention(slackUserId: string): string {
  return `<@${slackUserId.replace(/[^A-Za-z0-9_-]/g, "")}>`;
}

/**
 * Escape a value for interpolation into ONE INLINE SPAN of a `markdown_text`
 * message — Slack's CommonMark field, not its own mrkdwn.
 *
 * `escapeSlackText` covers Slack's three control characters, which is enough
 * for a plain body. It is NOT enough for a value placed inside markup we are
 * asserting with, because CommonMark's own delimiters survive it: a display
 * name containing `**` and a newline can close the bold span it was dropped
 * into and open a fresh, equally convincing one. That matters wherever the
 * markup is load-bearing — the `send_slack_dm` relay's attribution line exists
 * precisely so a message cannot be mistaken for someone else's words.
 *
 * It STRIPS those delimiters rather than backslash-escaping them, because
 * escaping does not survive Slack. Probed live 2026-09-17: sending
 * `**From Eve\*\* …**` came back out of `conversations.replies` as
 * `*From Eve*** ***…` — CommonMark consumed the backslashes into literal
 * asterisks, and Slack's down-conversion to mrkdwn then emitted them RAW, so
 * its own renderer reinterprets them as markup. The escape is not merely
 * cosmetic-lossy; it is defeated. Deleting the characters is the only form
 * that holds across that round trip, and losing a `*` from a display name
 * costs nothing next to being able to forge an attribution line.
 */
export function escapeSlackInline(s: string): string {
  return escapeSlackText(s)
    .replace(/[\\`*_~[\]]/g, "")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}

/**
 * Decode a Slack message's `text` into a family-message body: Slack sends links
 * as `<url>` / `<url|label>` and escapes `&`, `<`, `>`. A labelled link becomes
 * the message body's own `[label](url)` form (lib/messageLinks.ts), so a
 * teacher replying from Slack keeps the link the parent can click.
 */
export function slackTextToMessageBody(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, (_m, url: string, label: string) =>
      /[[\]\n]/.test(label) ? `${label} (${url})` : `[${label}](${url})`,
    )
    .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
