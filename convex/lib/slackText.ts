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

/** A person the bot's reply may @-mention: their Slack id and the name the
 *  transcript shows the model for them. */
export interface SlackMentionTarget {
  slackUserId: string;
  name: string;
}

/** Text that continues a name: a letter, combining mark, digit or "_". */
const NAME_CHAR = /[\p{L}\p{M}\p{N}_]/u;
/** Characters that may sit between a space and a mention's "@" without
 *  making it part of a word: opening punctuation and emphasis
 *  ("(@Avery Stone)", "**@Avery Stone**"). */
const LEADING_PUNCTUATION = `([{"'\u201C\u2018*_~`;

/** Case-insensitive form for comparing names. Greek final sigma is folded to
 *  a plain sigma, because lowercasing picks one by position and a streamed
 *  prefix ends where the full name doesn't. */
function foldName(s: string): string {
  return s.toLowerCase().replace(/\u03C2/g, "\u03C3");
}

/**
 * Turns `@Display Name` in the bot's reply into a real `<@U…>` mention, as
 * the reply streams.
 *
 * The model never sees a Slack id: the transcript shows every mention as
 * `@Display Name` (cleanSlackText). So when it addresses someone it writes
 * that plain text back, and Slack shows it as text that pings nobody (on
 * 2026-11-10 the bot put a question to a teacher that way, and she was never
 * notified). This maps the name back to the id, for the people in the thread.
 *
 * It works on deltas because the reply streams, so the mention is in the text
 * from the moment Slack first receives it rather than arriving in a later
 * edit. A delta can end mid-name ("@Avery St"), so `push` holds back a tail
 * that could still become a mention, `flush` releases it when the text run
 * ends, and `take` hands it over unread when the reply continues in a new
 * message.
 *
 * Only an exact (case-insensitive) display name, ending where the name does,
 * counts. A name two people share is left as text rather than guessed, and it
 * also stops a shorter name inside it from matching. An "@" counts only at
 * the start or after a space, possibly through opening punctuation or
 * emphasis ("(@…", "**@…"); after anything else it is an address or a link
 * ("lehua@…", "a_@…", "example.com/(@…"). Code spans and fenced blocks are
 * left alone.
 */
export class SlackMentionRewriter {
  /** Longest name first. `mention` is null for a name two people share. */
  private readonly targets: Array<{ name: string; folded: string; mention: string | null }>;
  private held = "";
  /** The character before the current position. */
  private prev = "";
  /** Whether an "@" here could open a mention. */
  private canOpen = true;
  /** Only spaces since the last line break: where a code fence can open or close. */
  private atLineStart = true;
  /** The code span or fenced block we are in, by its backtick run. */
  private code: { run: number; fence: boolean } | null = null;

  constructor(targets: readonly SlackMentionTarget[]) {
    const byName = new Map<string, { name: string; id: string | null }>();
    for (const t of targets) {
      const name = t.name.trim();
      if (!name) continue;
      const folded = foldName(name);
      const seen = byName.get(folded);
      byName.set(folded, {
        name: seen?.name ?? name,
        id: !seen || seen.id === t.slackUserId ? t.slackUserId : null,
      });
    }
    this.targets = [...byName]
      .map(([folded, { name, id }]) => ({
        name,
        folded,
        mention: id === null ? null : slackMention(id),
      }))
      .sort((a, b) => b.name.length - a.name.length);
  }

  /** Characters of the model's text held back so far, not yet returned. */
  get heldLength(): number {
    return this.held.length;
  }

  /** Rewrite a delta; returns the text that is safe to send now. */
  push(delta: string): string {
    const text = this.held + delta;
    this.held = "";
    return this.rewrite(text, false);
  }

  /** The text run ended: release whatever was held back. */
  flush(): string {
    const text = this.held;
    this.held = "";
    return this.rewrite(text, true);
  }

  /** Hand back a held, half-read name as the model wrote it, unsent, for the
   *  message the reply continues in. Flushing it here instead could read it
   *  as a shorter name ("@Avery St" as "@Avery"). Held backticks stay: they
   *  belong to this message's code. */
  take(): string {
    if (!this.held.startsWith("@")) return "";
    const text = this.held;
    this.held = "";
    return text;
  }

  private rewrite(text: string, final: boolean): string {
    if (this.targets.every((t) => t.mention === null)) return text;
    let out = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "`") {
        let end = i;
        while (text[end] === "`") end++;
        // The run may go on in the next delta, and its length decides
        // whether it opens, closes or sits inside code.
        if (end === text.length && !final) {
          this.held = text.slice(i);
          return out;
        }
        this.backticks(end - i);
        out += text.slice(i, end);
        i = end;
        continue;
      }
      if (ch === "@" && !this.code && this.canOpen) {
        const hit = this.match(text.slice(i + 1), final);
        if (hit === "wait") {
          this.held = text.slice(i);
          return out;
        }
        if (hit) {
          out += hit.mention;
          i += 1 + hit.length;
          this.see(">");
          continue;
        }
      }
      out += ch;
      this.see(ch);
      i++;
    }
    return out;
  }

  private see(ch: string): void {
    if (/\s/.test(ch)) this.canOpen = true;
    else if (!LEADING_PUNCTUATION.includes(ch)) this.canOpen = false;
    this.atLineStart = ch === "\n" || (this.atLineStart && (ch === " " || ch === "\t"));
    this.prev = ch;
  }

  /** A run of `run` backticks: opens or closes code the way CommonMark does,
   *  minus the finer points. A fence opens at the start of a line with three
   *  or more and closes only at the start of a line with at least as many; an
   *  inline span closes on a run of the same length. */
  private backticks(run: number): void {
    if (!this.code) {
      this.code = { run, fence: run >= 3 && this.atLineStart };
    } else if (
      this.code.fence ? this.atLineStart && run >= this.code.run : run === this.code.run
    ) {
      this.code = null;
    }
    this.see("`");
  }

  /** Does `rest` (the text after an "@") open with a target's name? "wait"
   *  when the answer depends on text that hasn't arrived yet. Compares
   *  equal-length slices of the original text, because lowercasing can change
   *  a string's length ("İ"). Underscores after a name end it when what
   *  follows them doesn't continue it: they close italics ("_ask @Avery
   *  Stone_"), not an identifier ("@Avery_Stone"). */
  private match(
    rest: string,
    final: boolean,
  ): { mention: string; length: number } | "wait" | null {
    for (const t of this.targets) {
      const n = t.name.length;
      if (rest.length < n) {
        if (!final && foldName(t.name.slice(0, rest.length)) === foldName(rest)) {
          return "wait";
        }
        continue;
      }
      if (foldName(rest.slice(0, n)) !== t.folded) continue;
      let after = n;
      while (rest[after] === "_") after++;
      const next = rest.codePointAt(after);
      if (next === undefined) {
        if (!final) return "wait";
      } else if (NAME_CHAR.test(String.fromCodePoint(next))) {
        continue;
      }
      // The longest name that fits decides, even a shared one (no mention).
      return t.mention ? { mention: t.mention, length: n } : null;
    }
    return null;
  }
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
