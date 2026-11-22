/**
 * A Slack message whose asides sit in Slack's small grey `context` line: a
 * reply hint, a receipt, where something came from, a key to the markers.
 * Andy, 2026-11-15, on the day's-wonders note: the grey line lets a reader tell
 * the point of a message from what is said about it.
 *
 * Grey is only for text nobody has to act on. An alert, an error, money to fix
 * or a request to a named person stays full size.
 *
 * - Main text goes in `markdown` blocks when the caller writes CommonMark (what
 *   `postMessage({ markdown: true })` sends as `markdown_text`), or in
 *   `section` blocks when it writes Slack mrkdwn.
 * - A grey line is a `context` block, which only takes mrkdwn, so CommonMark
 *   `**bold**` and `[label](url)` are converted on the way in.
 * - `text` keeps the whole message in mrkdwn, so notifications and screen
 *   readers see every word, as before. Past Slack's 4,000-character cap beside
 *   blocks it is left empty: `postMessage` then omits it and Slack builds it
 *   from the blocks.
 * - Slack folds the line breaks of that `text` into spaces, so the bot reads
 *   its own message back from the blocks instead (`GREY_BLOCK_ID_PREFIX`).
 */
import { normalizeSlackMarkdown } from "./slackApi";

/** Main text, or `{ grey }` for a line in Slack's small grey context style. */
export type SlackPart = string | { grey: string };

/**
 * What `postMessage` takes for the message. With a grey line: blocks, and the
 * whole message in mrkdwn as `text` ("" when it is too long to send beside
 * blocks). Without one: the text alone, posted exactly as before (as
 * `markdown_text` for CommonMark), because Slack keeps the line breaks of a
 * message without blocks.
 */
export interface GreyLinePost {
  text: string;
  blocks?: unknown[];
  markdown?: boolean;
}

/** Slack refuses `text` over 4,000 characters beside `blocks` (msg_too_long). */
export const BLOCK_TEXT_FALLBACK_MAX = 4000;
/** Slack's limit for a section's text and for a context element's text. */
const MRKDWN_BLOCK_MAX = 3000;

/**
 * Slack mrkdwn from the CommonMark this repo writes for `markdown_text`: bold
 * is `*x*`, a link is `<url|label>`. Code spans are left alone. Only the two
 * constructs the bot's fixed text uses are converted; anything else passes
 * through as written.
 */
export function commonMarkToMrkdwn(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : piece
            .replace(/\*\*([^*\n]+?)\*\*/g, "*$1*")
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, "<$2|$1>"),
    )
    .join("");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Split mrkdwn into section-sized chunks at line breaks. */
function mrkdwnChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= MRKDWN_BLOCK_MAX) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    let rest = line;
    while (rest.length > MRKDWN_BLOCK_MAX) {
      chunks.push(rest.slice(0, MRKDWN_BLOCK_MAX));
      rest = rest.slice(MRKDWN_BLOCK_MAX);
    }
    current = rest;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * The block id every grey line here carries. The bot's thread reader rebuilds a
 * message marked with it from its blocks (lib/slackTranscript.ts
 * `greyLineReplyText`), because Slack folds the line breaks of `text` sent
 * beside blocks into spaces.
 */
export const GREY_BLOCK_ID_PREFIX = "rh_grey";

/** One grey line as its own context block. `index` keeps block ids unique in a message. */
export function greyBlock(mrkdwn: string, index = 0): { type: "context"; block_id: string; elements: unknown[] } {
  return {
    type: "context",
    block_id: `${GREY_BLOCK_ID_PREFIX}_${index}`,
    elements: [{ type: "mrkdwn", text: clip(mrkdwn, MRKDWN_BLOCK_MAX) }],
  };
}

/**
 * Blocks and fallback text for a message made of main text and grey lines, in
 * the order given. `markdown` says how the caller wrote the parts: CommonMark
 * (true) or Slack mrkdwn (false). `text` is the fallback before conversion,
 * for a caller whose plain string joined the parts differently; it defaults to
 * the parts joined by blank lines (CommonMark) or line breaks (mrkdwn).
 */
export function greyLineMessage(
  parts: SlackPart[],
  opts: { markdown: boolean; text?: string },
): GreyLinePost {
  const blocks: unknown[] = [];
  const plain: string[] = [];
  let greyCount = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      const body = part.trim();
      if (!body) continue;
      plain.push(body);
      if (opts.markdown) {
        blocks.push({ type: "markdown", text: normalizeSlackMarkdown(body) });
      } else {
        for (const chunk of mrkdwnChunks(body)) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
        }
      }
      continue;
    }
    const grey = part.grey.trim();
    if (!grey) continue;
    plain.push(grey);
    const line = opts.markdown ? commonMarkToMrkdwn(grey) : grey;
    // Grey lines in a row share one block: Slack spaces separate blocks apart.
    const last = blocks.at(-1) as ReturnType<typeof greyBlock> | undefined;
    if (last?.type === "context" && last.block_id.startsWith(GREY_BLOCK_ID_PREFIX)) {
      const element = last.elements[0] as { text: string };
      element.text = clip(`${element.text}\n${line}`, MRKDWN_BLOCK_MAX);
      continue;
    }
    blocks.push(greyBlock(line, greyCount++));
  }
  const whole = opts.text ?? plain.join(opts.markdown ? "\n\n" : "\n");
  // Nothing grey: post the text as before. As blocks, Slack would fold its line
  // breaks, and the bot's thread reader only rebuilds marked messages.
  if (greyCount === 0) return opts.markdown ? { text: whole, markdown: true } : { text: whole };
  const text = opts.markdown ? commonMarkToMrkdwn(whole) : whole;
  return { text: text.length <= BLOCK_TEXT_FALLBACK_MAX ? text : "", blocks };
}
