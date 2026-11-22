// What a scholar (or staff, in the app) wrote in a wonder or Quest conversation, as it reads in that
// conversation's Slack thread (TRA-693). Pure: the text only. The post, its
// checks and its retries live in convex/aboutSlackCopy.ts.
//
//   Kai wrote in Rabbithole:
//   > I also want the jaws to snap shut at 0.
//   (sent a picture — see it in Rabbithole)

import { escapeSlackText } from "./slackText";

/** Slack refuses a very long `text`; a longer message is cut with a pointer. */
const MAX_WORDS = 3000;

export const PICTURE_LINE = "(sent a picture — see it in Rabbithole)";
export const FILE_LINE = "(sent a file — see it in Rabbithole)";

export type CopyAttachment = "picture" | "file" | null;

/**
 * The thread reply for one scholar message. The words are escaped, so a
 * scholar can't write a Slack mention, link or channel call; an attachment
 * is named, never sent.
 */
export function scholarCopyText(
  label: string,
  words: string,
  attachment: CopyAttachment,
): string {
  return copyText(`${escapeSlackText(label)} wrote in Rabbithole:`, words, attachment);
}

/** The thread reply for a message staff wrote to the scholar in the app. */
export function staffCopyText(
  staffName: string,
  scholarLabel: string,
  words: string,
  attachment: CopyAttachment,
): string {
  return copyText(
    `${escapeSlackText(staffName)} wrote to ${escapeSlackText(scholarLabel)} in Rabbithole:`,
    words,
    attachment,
  );
}

function copyText(heading: string, words: string, attachment: CopyAttachment): string {
  const lines = [heading];
  const trimmed = words.trim();
  if (trimmed) {
    const cut =
      trimmed.length > MAX_WORDS
        ? `${trimmed.slice(0, MAX_WORDS).trimEnd()}… (the rest is in Rabbithole)`
        : trimmed;
    for (const line of escapeSlackText(cut).split("\n")) lines.push(`> ${line}`);
  }
  if (attachment) lines.push(attachment === "picture" ? PICTURE_LINE : FILE_LINE);
  return lines.join("\n");
}
