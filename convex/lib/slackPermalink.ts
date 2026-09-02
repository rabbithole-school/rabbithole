// Slack permalink (archive URL) → message coordinates. Pure module
// (unit-tested), so the bot can resolve a forwarded Slack link into the
// underlying message and act on its contents.
//
// A Slack "Copy link" permalink looks like:
//   https://<workspace>.slack.com/archives/<CHANNEL>/p<DIGITS>
//     [?thread_ts=<parent_ts>&cid=<CHANNEL>]
//
// The message `ts` is the `p`-digits with a '.' inserted before the LAST SIX
// digits (Slack drops the dot in the path): p1783662930395019 →
// 1783662930.395019. Query params refine it:
//   • cid       — the canonical channel id (overrides the path segment when
//                 present; the two normally agree)
//   • thread_ts — the parent thread's ts, present when the link points at a
//                 reply (so a reader can fetch the whole thread)

export interface SlackPermalinkRef {
  /** Channel / conversation id (public C…, private/group G…, DM D…). */
  channelId: string;
  /** The linked message's ts, e.g. "1783662930.395019". */
  ts: string;
  /** Parent thread ts when the link points at a threaded reply. */
  threadTs?: string;
}

// One Slack archive permalink. The URL body stops at whitespace or Slack's
// link-wrapping delimiters (`<`, `>`, `|`) and at common closing punctuation
// so a link pasted mid-sentence or inside Slack's `<url|label>` form still
// parses. Case-insensitive host; channel + digits are the two captures, with
// an optional query string.
const ARCHIVE_RE =
  /https?:\/\/[a-z0-9][a-z0-9.-]*\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{7,})(?:\?([^\s<>|)\]"']*))?/i;

// Slack HTML-escapes the message `text` it delivers over the Events API —
// INCLUDING inside a `<url>` / `<url|label>` link token — so a permalink's
// query string arrives as `?thread_ts=…&amp;cid=…`, not `?thread_ts=…&cid=…`
// (Slack escapes `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`). Left escaped, the literal
// `&` inside `&amp;` makes URLSearchParams split there (`&amp;cid=…` parses to a
// key `amp;cid`), so every param AFTER the first `&` — `cid` and/or `thread_ts`,
// depending on order — is silently dropped. Undo the escaping on the query
// before parsing so all params survive regardless of ordering. `&amp;` is
// unescaped LAST so an entity like `&amp;lt;` decodes to `&lt;`, not `<`.
function decodeSlackEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/g, "&");
}

/** Turn the run of `p`-digits into a Slack `ts` (dot before the last six). */
function digitsToTs(digits: string): string | null {
  if (digits.length < 7) return null; // need ≥1 whole-second digit + 6 fractional
  const whole = digits.slice(0, digits.length - 6);
  const frac = digits.slice(digits.length - 6);
  return `${whole}.${frac}`;
}

/** Leading Slack-id run (uppercase alphanumeric), dropping any trailing
 *  punctuation captured from a mid-sentence URL. */
function sanitizeChannelId(raw: string): string | null {
  const m = raw.match(/^[A-Z0-9]+/i);
  return m ? m[0] : null;
}

/** Leading `digits(.digits)?` run — a Slack ts, minus any trailing junk. */
function sanitizeTs(raw: string): string | undefined {
  const m = raw.match(/^\d+(?:\.\d+)?/);
  return m ? m[0] : undefined;
}

function refFromMatch(m: RegExpMatchArray): SlackPermalinkRef | null {
  const pathChannel = m[1];
  const ts = digitsToTs(m[2]);
  if (!ts) return null;

  let channelId = pathChannel;
  let threadTs: string | undefined;

  const query = m[3];
  if (query) {
    const params = new URLSearchParams(decodeSlackEntities(query));
    const cid = params.get("cid");
    if (cid) {
      const clean = sanitizeChannelId(cid);
      if (clean) channelId = clean;
    }
    const parent = params.get("thread_ts");
    if (parent) threadTs = sanitizeTs(parent);
  }

  return { channelId, ts, ...(threadTs ? { threadTs } : {}) };
}

/**
 * Parse a single Slack archive/permalink URL. Returns null for anything that
 * isn't a Slack `…/archives/<channel>/p<digits>` link (a plain web page, a
 * Slack team/app URL, garbage, …). Tolerant of surrounding text.
 */
export function parseSlackPermalink(url: string): SlackPermalinkRef | null {
  const m = url.match(ARCHIVE_RE);
  return m ? refFromMatch(m) : null;
}

/**
 * Find every distinct Slack permalink in a block of message text (deduped by
 * channel+ts), capped at `max` (default 3) so one message can't fan out into
 * an unbounded number of Slack reads. Handles Slack's `<url>` / `<url|label>`
 * wrapping and links pasted mid-sentence.
 */
export function extractSlackPermalinks(
  text: string,
  max = 3,
): SlackPermalinkRef[] {
  const re = new RegExp(ARCHIVE_RE.source, "gi");
  const refs: SlackPermalinkRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && refs.length < max) {
    const ref = refFromMatch(m);
    if (!ref) continue;
    const key = `${ref.channelId}:${ref.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * Whether the REQUESTER is allowed to have a forwarded permalink resolved.
 *
 * Slack authorizes the read methods (conversations.replies / .members) against
 * the BOT token, not the human — so without this check a staffer could paste a
 * link to any conversation the BOT is in (a leadership channel, a group DM,
 * someone else's bot-DM) that THEY are not in, and the bot would read it. This
 * enforces "the bot acts with the permissions of the person it's answering":
 *
 *   • same conversation the request came from → trivially allowed (no API call);
 *   • otherwise → allowed only if the requester is in the target's member set.
 *
 * `memberSet` null/undefined means membership couldn't be established — the
 * caller MUST fail closed (return value is false), never resolve on doubt.
 */
export function isRequesterAllowed(
  refChannel: string,
  currentChannel: string | null | undefined,
  memberSet: ReadonlySet<string> | null | undefined,
  authorId: string,
): boolean {
  if (currentChannel && refChannel === currentChannel) return true;
  if (!memberSet) return false;
  return memberSet.has(authorId);
}
