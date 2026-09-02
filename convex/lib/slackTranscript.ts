// Slack thread → Anthropic messages. Pure module (unit-tested).
//
// The multi-user attribution scheme from review/slack-bot-plan.md: every
// human turn is prefixed with the speaker's display name so the model can
// track who's asking what in a group thread; the bot's own messages become
// assistant turns. Anthropic requires strictly alternating roles starting
// with "user", so consecutive same-role messages merge and a leading bot
// message (e.g. a Phase-3 notification at the thread root) is folded into
// the first user turn as quoted context. Inline media (images/PDFs) is
// likewise legal ONLY on user turns, so the bot's own attachments are hoisted
// onto the next one — see the hoist pass in buildSlackTranscript.

import type { SlackAttachment, SlackMessage } from "./slackApi";
import type { SlackSurface } from "./slackTools";
import type { ImageMime } from "./imageBytes";
import { imageMediaType } from "./ingestMimes";

/** A base64 image content block, shaped exactly like Anthropic's image param
 * (so a transcript turn can be handed to the SDK as message content
 * unchanged). `media_type` is the SDK's supported-raster union. */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageMime; data: string };
}

export interface TextBlock {
  type: "text";
  text: string;
}

/** A base64 PDF content block, shaped exactly like Anthropic's document param
 * — so a transcript turn can be handed to the SDK as message content unchanged
 * and the model reads the PDF's actual pages (text + layout), not just a
 * `[attached file: …]` descriptor. */
export interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
  title?: string;
}

/** An EXTRACTED-TEXT document block (Anthropic's `source.type: "text"` variant),
 * used for the file types we parse ourselves rather than hand over as bytes —
 * Word documents, RTF, and plain/markdown/CSV text. Same shape the in-app aide
 * uses for the identical file kinds (`textDocumentBlock` in lib/aideAttachments),
 * so both surfaces present a parsed upload to the model the same way. */
export interface TextDocumentBlock {
  type: "document";
  source: { type: "text"; media_type: "text/plain"; data: string };
  title?: string;
}

/** One block of a block-form turn. Exported so callers that rebuild a turn's
 *  content (injectResolvedLinks, appendUserContext) stay in lockstep with this
 *  union instead of hand-rolling their own copy — which silently went stale
 *  when TextDocumentBlock was added. */
export type TranscriptBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | TextDocumentBlock;

/** A turn's content: a plain string (the common, text-only case — kept for
 * readability + byte-stable prompt caching) OR a block array when the turn
 * carries an inline image, PDF, or parsed text document the model should
 * actually see. */
export type TranscriptContent = string | TranscriptBlock[];

export interface TranscriptTurn {
  role: "user" | "assistant";
  content: TranscriptContent;
}

/** slackFileId → decoded image, ready to drop into the transcript as an
 * inline vision block. Built by the caller (which does the authed download
 * + base64 encode); the pure builder just interleaves it. */
export type ImageAttachmentMap = ReadonlyMap<
  string,
  { mediaType: ImageMime; dataBase64: string }
>;

/** slackFileId → decoded PDF, ready to drop into the transcript as an inline
 * document block. Built by the caller (authed download + base64 encode); the
 * pure builder just interleaves it. Runs on both DM and channel surfaces —
 * reading a PDF is orthogonal to whether it's a sensitive scholar record
 * (that STORAGE step stays DM-only; see mirrorDmFiles). */
export type DocumentAttachmentMap = ReadonlyMap<
  string,
  { dataBase64: string; name?: string }
>;

/** slackFileId → text we extracted OURSELVES from a non-PDF document (Word,
 * RTF, plain/markdown/CSV), ready to drop into the transcript as a text
 * document block. Built by the caller (authed download + parse via the same
 * `classifyAideUpload` / `extractDirectText` pair the in-app aide uses for
 * uploads); the pure builder just interleaves it. Like PDFs, reading one is
 * orthogonal to whether it's a sensitive scholar record — the DM-only gate
 * stays on document STORAGE (see mirrorDmFiles). */
export type TextAttachmentMap = ReadonlyMap<
  string,
  { text: string; name?: string }
>;

/** Every `<@USERID>` referenced in `text` (mentions in the message body),
 * whether or not that user has posted in the thread. Used to pre-resolve the
 * names of people who are only mentioned (e.g. "@Lehua") so they render as
 * @DisplayName instead of the "@user" fallback. */
export function extractMentionedUserIds(text: string): string[] {
  const ids: string[] = [];
  const re = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/** Subtypes that are channel noise, never conversation. */
const IGNORED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "message_changed",
  "message_deleted",
  "thread_broadcast_deleted",
  // Slackbot's "A comment was added" notice that roots a Slack List row's
  // comment thread — pure noise in the transcript (the actual row is injected
  // as context separately). Its `slack_list` metadata is still read off the
  // raw thread before this filter runs.
  "list_record_comment",
]);

/**
 * Replace Slack mention tokens: our own bot's mention vanishes (it's the
 * summons, not content); other users' mentions become @DisplayName when
 * known. Also unescapes Slack's &amp;/&lt;/&gt; HTML entities.
 */
export function cleanSlackText(
  text: string,
  botUserId: string | null,
  names: ReadonlyMap<string, string>,
): string {
  let out = text;
  out = out.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => {
    if (botUserId && id === botUserId) return "";
    const name = names.get(id);
    return name ? `@${name}` : "@user";
  });
  // Slack link syntax <https://url|label> / <https://url> → label or url.
  out = out.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)");
  out = out.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  out = out
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return out.trim();
}

// A tool-activity CONTEXT line, exactly as buildToolContext (slackBot.ts) emits
// it: "⋯  <running>" or "✓  <done>", where the leader is U+22EF / U+2713 — NOT
// the ✅ (:white_check_mark:) the bot uses in prose, so this can't match a real
// checklist bullet.
const TOOL_ACTIVITY_LINE = /^\s*(?:\u22EF|\u2713) {2}/u;

/**
 * Strip the bot's own tool-activity chrome from a reconstructed assistant turn.
 *
 * The bot posts a small live "progress" block ("⋯  Checking website preview…",
 * "✓  Website PR task dispatched.") as its OWN Slack message via
 * buildToolContext. That's UI chrome, never conversation — but the thread the
 * transcript is rebuilt from contains those messages, and replaying them as
 * assistant turns poison the model two ways:
 *   1. it learned to OPEN its own replies with "⋯  Checking website preview…"
 *      (the literal chrome leaked into the user-visible answer), and
 *   2. it saw every stale PR number and preview URL it had ever rendered and
 *      "corrected" them into freshly fabricated ones (#59 → #60 → #61, and a
 *      guessed vercel.app host) instead of re-reading a fresh tool result.
 * A message that is ONLY chrome collapses to "" and drops out of the transcript
 * entirely; a reply that merely got the chrome glued onto its head keeps its
 * prose.
 */
export function stripToolActivityChrome(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TOOL_ACTIVITY_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cap one forwarded/unfurled item so a single paste can't blow the input
 *  budget. Mirrors RESOLVED_MSG_MAX_CHARS on the permalink path. */
const ATTACHMENT_MAX_CHARS = 4000;
/** Cap how many attachments one message contributes. A link-heavy post can
 *  unfurl many previews; the first few carry the intent. */
const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** How many of the bot's OWN attachments (newest first) get hoisted onto a
 *  user turn so the model can still see them. See the hoist pass in
 *  buildSlackTranscript for why they can't stay on the assistant turn. Small
 *  because the whole thread is re-sent every turn. */
const MAX_HOISTED_BOT_MEDIA = 2;
/** Marks hoisted blocks as the BOT's own output, not something staff attached
 *  — without it the model reads its generated image as a staff-supplied photo
 *  (and the marketing lane treats those differently: photo-consent rules). */
const HOISTED_MEDIA_NOTE =
  "[Attached below: the file(s) Rabbithole itself posted earlier in this thread — its own output, not something the requester sent.]";

/**
 * Render a message's attachments — FORWARDED Slack messages and link previews
 * — into transcript text.
 *
 * Why this exists: when a human forwards a message, Slack leaves `text` holding
 * only whatever comment they typed and puts the quoted content in
 * `attachments`. A bot reading only `text` therefore sees an empty message and
 * answers confidently about nothing, which is worse than refusing. Forwarding
 * is an obvious thing for staff to try, so the silent-drop is a trap.
 *
 * ⚠️ DELIBERATELY NOT authorization-gated, unlike `resolveSharedSlackLinks`.
 * The distinction is whether Slack has already rendered the content into this
 * channel:
 *
 *   • A bare PERMALINK renders nothing. Reading it with the bot token would
 *     surface content the channel cannot see, so that path first verifies the
 *     REQUESTER's membership of the source conversation and fails closed.
 *   • A FORWARD embeds a copy of the text in the destination message. Slack
 *     warns the sharer about exactly this, and does not mask private content.
 *     Every human in the channel can already read it. Gating the bot would be
 *     theater: it would refuse to read words that are on screen.
 *
 * The invariant to preserve: **render what Slack already rendered; never fetch
 * beyond it.** Following `title_link`/`from_url` to pull more of the source
 * thread would cross back into unseen content and must go through the gated
 * permalink path instead.
 */
export function renderSlackAttachments(
  attachments: SlackAttachment[] | undefined,
  botUserId: string | null,
  names: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const a of (attachments ?? []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
    const body = truncate(
      cleanSlackText(a.text ?? a.fallback ?? "", botUserId, names),
    );
    const fileNote = describeAttachmentFiles(a);
    if (!body && !fileNote && !a.title) continue;

    const isForward = a.is_share || a.is_msg_unfurl;
    const header = isForward
      ? forwardHeader(a)
      : a.title
        ? `[link preview: ${a.title}${a.title_link ? ` (${a.title_link})` : ""}]`
        : "[link preview]";

    out.push([header, body, fileNote].filter(Boolean).join("\n"));
  }
  return out;
}

function forwardHeader(a: SlackAttachment): string {
  const who = a.author_name?.trim();
  const where = a.channel_name?.trim();
  const parts = [who && `from ${who}`, where && `in #${where}`]
    .filter(Boolean)
    .join(" ");
  return parts ? `[forwarded message — ${parts}]` : "[forwarded message]";
}

/**
 * Name any files on the ORIGINAL message. They aren't downloaded (they belong
 * to a conversation we may have no access to), but naming them beats silently
 * pretending a screenshot-only forward was empty.
 */
function describeAttachmentFiles(a: SlackAttachment): string {
  const names = (a.files ?? [])
    .map((f) => f.name ?? f.title)
    .filter((n): n is string => !!n);
  if (names.length === 0) return "";
  return `[forwarded message also had ${names.length} file(s), not readable here: ${names.join(", ")}]`;
}

function truncate(s: string): string {
  return s.length <= ATTACHMENT_MAX_CHARS
    ? s
    : `${s.slice(0, ATTACHMENT_MAX_CHARS)}… [truncated]`;
}

/** One-line description of an attached file, kept in the transcript so a
 * later turn (e.g. "yes, attach it") can still reference it. When the file
 * has been mirrored into Convex storage (slackFiles table), the storageRef
 * is included — that token is what upload_scholar_document consumes. */
export function describeFile(
  f: {
    id: string;
    name?: string;
    mimetype?: string;
    size?: number;
  },
  storageRef?: string,
): string {
  const size = f.size ? ` ${Math.round(f.size / 1024)}KB` : "";
  const ref = storageRef ? ` storageRef=${storageRef}` : "";
  return `[attached file: ${f.name ?? "untitled"} (${f.mimetype ?? "unknown"},${size} slackFileId=${f.id}${ref})]`;
}

/**
 * Build alternating Anthropic turns from a chronological Slack thread.
 * `names` maps slackUserId → display name (unknown ids become "Someone").
 *
 * Turns accumulate internally as `{ role, text, images }`; a turn collapses
 * to a plain string when it carries no image (the common case, kept for
 * readability + a byte-stable prompt-cache prefix) and to a `[text, …image]`
 * block array when it does — so the model actually SEES an attached image
 * instead of only reading a `[attached file: …]` descriptor.
 */
export function buildSlackTranscript(args: {
  messages: SlackMessage[];
  botUserId: string | null;
  names: ReadonlyMap<string, string>;
  /** slackFileId → Convex storage id, for files mirrored into storage. */
  fileRefs?: ReadonlyMap<string, string>;
  /** slackFileId → decoded image bytes, shown inline as a vision block. */
  images?: ImageAttachmentMap;
  /** slackFileId → decoded PDF bytes, shown inline as a document block. */
  documents?: DocumentAttachmentMap;
  /** slackFileId → text extracted from a Word/RTF/plain-text file, shown
   *  inline as a text document block. */
  texts?: TextAttachmentMap;
}): TranscriptTurn[] {
  const { messages, botUserId, names, fileRefs, images, documents, texts } = args;

  // Internal accumulator: text + any inline media (images/PDFs/parsed docs),
  // merged per role run. `media` preserves the order the blocks were appended.
  type MediaBlock = ImageBlock | DocumentBlock | TextDocumentBlock;
  type Draft = { role: TranscriptTurn["role"]; text: string; media: MediaBlock[] };
  const drafts: Draft[] = [];

  // The images/documents maps are keyed by FILE ID, but the same file can be
  // shared into several thread messages (each a separate occurrence). The
  // download budget (collectThreadImages/collectThreadDocuments) counts each
  // accepted file ONCE, so we must emit its base64 block once too — otherwise a
  // single 15MB PDF shared twice would inline 30MB, blowing the very byte cap
  // the budget exists to enforce (a hard Anthropic 400). Track which ids have
  // already been emitted; a later occurrence of the same id degrades to the
  // text descriptor (still referenceable in a follow-up turn).
  const emittedMediaIds = new Set<string>();

  for (const m of messages) {
    if (m.subtype && IGNORED_SUBTYPES.has(m.subtype)) continue;

    const isBot = !!m.bot_id || (botUserId !== null && m.user === botUserId);
    const pieces: string[] = [];
    const mediaBlocks: MediaBlock[] = [];
    // Bot messages: drop the tool-activity progress chrome ("⋯ …" / "✓ …") the
    // bot posts as its own messages, so the model never re-ingests it (see
    // stripToolActivityChrome). Human text is cleaned but never chrome-stripped.
    const cleaned = cleanSlackText(m.text ?? "", botUserId, names);
    const text = isBot ? stripToolActivityChrome(cleaned) : cleaned;
    if (text) pieces.push(text);
    // Forwarded messages / link previews. Must come after `text` (which holds
    // only the forwarder's own comment) so the quote reads as its elaboration.
    //
    // Skipped on the bot's OWN messages: the only attachments there are
    // unfurls of links the bot itself just posted (canvas, PR, preview), so
    // they carry zero new information and would re-inflate every later turn —
    // a compounding token cost now that the campaign flow posts a canvas link
    // each turn. Forwarded human content never arrives on a bot message.
    if (!isBot) {
      pieces.push(...renderSlackAttachments(m.attachments, botUserId, names));
    }
    for (const f of m.files ?? []) {
      // A label preserves the `storageRef=<id>` token whenever the file was
      // ALSO mirrored into storage (the DM document-intake path), so
      // upload_scholar_document can still attach it across turns even though
      // it's now shown inline too (dropping it silently broke the "add this
      // to Kai's profile" flow for inline files).
      const storageRef = fileRefs?.get(f.id);
      const refToken = storageRef ? ` storageRef=${storageRef}` : "";
      const img = images?.get(f.id);
      const doc = documents?.get(f.id);
      const txt = texts?.get(f.id);
      if (img && !emittedMediaIds.has(f.id)) {
        emittedMediaIds.add(f.id);
        pieces.push(`[attached image: ${f.name ?? "image"}${refToken}]`);
        mediaBlocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
        });
      } else if (doc && !emittedMediaIds.has(f.id)) {
        emittedMediaIds.add(f.id);
        // Shown inline as a document block — the model reads the PDF's pages.
        pieces.push(`[attached PDF: ${f.name ?? "document.pdf"}${refToken}]`);
        mediaBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: doc.dataBase64 },
          title: f.name ?? "document.pdf",
        });
      } else if (txt && !emittedMediaIds.has(f.id)) {
        emittedMediaIds.add(f.id);
        // Shown inline as a TEXT document block — we parsed the file ourselves
        // (Word/RTF/plain text), so the model reads its actual contents rather
        // than the `[attached file: …]` descriptor it used to get.
        pieces.push(`[attached document: ${f.name ?? "document"}${refToken}]`);
        mediaBlocks.push({
          type: "document",
          source: { type: "text", media_type: "text/plain", data: txt.text },
          title: f.name ?? "document",
        });
      } else if (
        !emittedMediaIds.has(f.id) &&
        imageMediaType(f.mimetype ?? "") !== null
      ) {
        // An image we could NOT hand to the model as a vision block — a download
        // failure, an undecodable/unsupported raster, or one too large to shrink
        // under the per-image limit. Say so EXPLICITLY: a generic
        // "[attached file: …]" line let the bot assume it had actually seen the
        // screenshot (and, in the wild, hallucinate its contents). Keep the
        // slackFileId (and any storageRef) so a later turn can still reference it.
        const size = f.size ? ` ${Math.round(f.size / 1024)}KB` : "";
        pieces.push(
          `[attached image (NOT shown to you — could not load it): ${f.name ?? "image"} (${f.mimetype ?? "image"},${size} slackFileId=${f.id}${refToken})]`,
        );
      } else {
        // No decoded payload for this occurrence — unsupported non-image files,
        // OR a later occurrence of a file already emitted once above. Keep the
        // text descriptor (still lets a later turn reference the file) instead
        // of a duplicate base64 block.
        pieces.push(describeFile(f, storageRef));
      }
    }
    if (pieces.length === 0 && mediaBlocks.length === 0) continue;

    const body = pieces.join("\n");
    const text_ = isBot
      ? body
      : `${(m.user && names.get(m.user)) || "Someone"}: ${body}`;

    const role: TranscriptTurn["role"] = isBot ? "assistant" : "user";
    const prev = drafts[drafts.length - 1];
    if (prev && prev.role === role) {
      prev.text = prev.text ? `${prev.text}\n\n${text_}` : text_;
      prev.media.push(...mediaBlocks);
    } else {
      drafts.push({ role, text: text_, media: mediaBlocks });
    }
  }

  // ── Media can ride ONLY on user turns ────────────────────────────────
  // Anthropic rejects an image/document block inside an assistant turn outright
  // — `messages.N.content: 'image' blocks are not permitted within assistant
  // turns` — a hard 400 that kills the whole reply. The bot posts files of its
  // own (generate_brand_image uploads the generated image into the thread), so
  // the moment anyone replied after one, every later turn 400'd.
  //
  // Don't just drop them: that image IS the artifact under discussion ("make it
  // warmer"), and the model has never otherwise seen it (the tool returns text).
  // Hoist each bot attachment onto the NEXT user turn instead — the same move
  // the leading-assistant fold below already makes — with a note saying whose
  // it is, so the model doesn't read its own output as something staff sent.
  //
  // Capped at the most recent MAX_HOISTED_BOT_MEDIA: the whole thread is
  // rebuilt every turn, so an unbounded hoist would re-send every superseded
  // generation forever. Older ones still read as their `[attached image: …]`
  // descriptor in the assistant text.
  const hoisted: Array<{ target: number; block: MediaBlock }> = [];
  let carry: MediaBlock[] = [];
  for (let i = 0; i < drafts.length; i++) {
    if (drafts[i].role === "assistant") {
      carry.push(...drafts[i].media);
      drafts[i].media = [];
      continue;
    }
    for (const block of carry) hoisted.push({ target: i, block });
    carry = [];
  }
  // Anything left in `carry` trails the last user turn, so there is nowhere
  // legal to put it — dropped (the caller requires a user turn last anyway).
  const byTarget = new Map<number, MediaBlock[]>();
  for (const { target, block } of hoisted.slice(-MAX_HOISTED_BOT_MEDIA)) {
    byTarget.set(target, [...(byTarget.get(target) ?? []), block]);
  }
  for (const [target, blocks] of byTarget) {
    const d = drafts[target];
    // Prepended: the bot posted them BEFORE this human turn's own attachments.
    d.media = [...blocks, ...d.media];
    d.text = d.text ? `${d.text}\n\n${HOISTED_MEDIA_NOTE}` : HOISTED_MEDIA_NOTE;
  }

  // Anthropic requires the first turn to be "user": fold a leading bot
  // message (notification thread roots) into the next user turn as context.
  while (drafts.length > 0 && drafts[0].role === "assistant") {
    const lead = drafts.shift()!;
    if (drafts.length === 0) break;
    drafts[0] = {
      role: "user",
      text: `[Rabbithole posted earlier in this thread]:\n${lead.text}\n\n${drafts[0].text}`,
      media: [...lead.media, ...drafts[0].media],
    };
  }

  return drafts.map(({ role, text, media }): TranscriptTurn => {
    if (media.length === 0) return { role, content: text };
    const blocks: Array<TextBlock | MediaBlock> = [];
    if (text.trim()) blocks.push({ type: "text", text });
    blocks.push(...media);
    return { role, content: blocks };
  });
}

// ── May the bot stay silent this turn? ──────────────────────────────────
//
// The `react_only` affordance (convex/slackBot.ts) lets the model answer with
// a reaction instead of a reply, so it doesn't butt into conversation that
// isn't for it. That's right for a bystander in a busy channel thread and
// WRONG the moment the bot is the one being spoken to — and the model cannot
// reliably tell the two apart from a tool description, because the cue it
// keys on ("this message name-drops a human, not me") is present in both. On
// prod it stayed silent on staff who were answering its own yes/no question,
// losing the asks behind them.
//
// So the decision is made HERE, deterministically, from the raw thread rather
// than the assembled transcript. The transcript is the wrong input: it merges
// a run of same-role messages into one turn and FOLDS a leading bot message
// into the first user turn (Anthropic requires a `user` turn first), so in a
// bot-rooted thread — a Quality Pulse post, a notification — the bot's own
// question isn't a turn at all, and index arithmetic over turns silently
// reads nothing. The raw messages have neither problem.

/** Did the bot write this message? Same test buildSlackTranscript uses, so
 *  the two never disagree about who spoke. */
function isBotMessage(m: SlackMessage, botUserId: string | null): boolean {
  return !!m.bot_id || (botUserId !== null && m.user === botUserId);
}

/**
 * Does this message END on a question — i.e. leave one open for a human?
 *
 * Only the tail counts, so a rhetorical question mid-message ("Why does
 * sequence matter here? Because…") doesn't read as one the bot is waiting on.
 * But "the tail" is not simply the last paragraph: the system prompt tells the
 * bot to ask choice questions as a question line followed by a NUMBERED list
 * ("1. …\n2. …", so a human can reply with just "2"), which puts the list —
 * not the question — in the final paragraph. Those are the highest-stakes
 * questions to get right (a bare "2" is unresolvable without the list), so
 * trailing list/bullet lines are stripped before the final paragraph is taken.
 *
 * Slack markup goes first: `<@U123>` mentions and `<url|label>` links both live
 * in angle brackets, and a URL's own query string would otherwise read as a
 * question mark — the bot posts PR and preview links constantly.
 */
function endsOnAQuestion(text: string): boolean {
  const stripped = text
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const lines = stripped.split("\n");
  while (
    lines.length > 0 &&
    /^\s*(?:[-*•]|\d+[.)])?\s*$|^\s*(?:[-*•]|\d+[.)])\s+\S/.test(
      lines[lines.length - 1],
    )
  ) {
    lines.pop();
  }
  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paragraphs[paragraphs.length - 1];
  return !!last && last.includes("?");
}

/** Who a bot message is asking.
 *
 *  An @-mention in the bot's own message wins: the notices that ping a
 *  requester ("…Want me to try again? <@U123>") are put to THAT person, not to
 *  whoever happened to speak last, and reading them as the latter makes the
 *  real addressee look like an uninvolved bystander whose answer may be
 *  swallowed. Otherwise it's the author of the nearest human message before it
 *  — null in a bot-rooted thread (a scheduled post, a notification), where the
 *  question is addressed to the thread at large. */
function addresseeOf(
  msgs: readonly SlackMessage[],
  botIndex: number,
  botUserId: string | null,
): string | null {
  const explicit = extractMentionedUserIds(msgs[botIndex].text ?? "").find(
    (id) => id !== botUserId,
  );
  if (explicit) return explicit;
  for (let j = botIndex - 1; j >= 0; j--) {
    if (!isBotMessage(msgs[j], botUserId)) return msgs[j].user ?? null;
  }
  return null;
}

/**
 * Does the bot have a question outstanding that this message could be
 * answering?
 *
 * Walks the whole thread backwards (excluding the triggering message itself —
 * that's the candidate answer) looking for a bot message that ends on a
 * question and has NOT been followed by a reply from the person it was asked
 * of. Scanning every bot message rather than just the most recent run matters:
 * the bot's question and its answer are routinely separated by other traffic —
 * a bystander's message, a scheduled post, an async outcome notice — and if
 * the bot spoke again in between, a "last run only" check would read that
 * later message and conclude nothing was pending.
 *
 * "Answered" is scoped to the addressee, not to anyone: a third party chiming
 * in doesn't discharge a question put to a specific person. The deliberate
 * cost is a false positive — while a question sits unanswered, the bot will
 * also reply to unrelated bystander chatter in that thread instead of staying
 * silent. That direction is the cheap one: an extra reply is visible and
 * self-correcting, a swallowed request is neither.
 */
export function botLeftAnOpenQuestion(args: {
  messages: readonly SlackMessage[];
  botUserId: string | null;
}): boolean {
  return openQuestionAddressees(args).length > 0;
}

/**
 * Every question the bot still has outstanding, given as the person it was put
 * to — `null` for one asked of the thread at large (a bot-rooted thread).
 *
 * Same walk as `botLeftAnOpenQuestion` (which is now a thin "any?" wrapper);
 * it returns the addressees because `mayStaySilent` needs to know WHO the bot
 * is waiting on, not merely that it is waiting.
 */
export function openQuestionAddressees(args: {
  messages: readonly SlackMessage[];
  botUserId: string | null;
}): Array<string | null> {
  const msgs = args.messages.filter(
    (m) => !(m.subtype && IGNORED_SUBTYPES.has(m.subtype)),
  );
  // Humans who have spoken between the message under inspection and the
  // trigger — i.e. who already had their chance to answer.
  const spokenSince = new Set<string>();
  const open: Array<string | null> = [];
  let anyHumanSince = false;
  for (let i = msgs.length - 2; i >= 0; i--) {
    const m = msgs[i];
    if (!isBotMessage(m, args.botUserId)) {
      anyHumanSince = true;
      if (m.user) spokenSince.add(m.user);
      continue;
    }
    if (!endsOnAQuestion(m.text ?? "")) continue;
    const addressee = addresseeOf(msgs, i, args.botUserId);
    const answered =
      addressee === null ? anyHumanSince : spokenSince.has(addressee);
    if (!answered) open.push(addressee);
  }
  return open;
}

/**
 * Is this message ADDRESSED to a specific other human?
 *
 * Slack's convention is that a message opening with `@name` is aimed at that
 * person, so a LEADING mention is the signal — not a mention anywhere. That
 * distinction is load-bearing: "sure, and cc <@U2>" is a third party giving
 * the bot a GO-AHEAD while name-dropping a colleague (the exact shape #1188
 * was built to stop the bot swallowing), while "<@U2> what do you think?" is
 * that colleague's to answer. Only the second opens with the mention.
 *
 * The author's own id doesn't count (a self-mention addresses nobody else),
 * and neither does the bot's — being addressed IS the summons, and gate 2 has
 * already forced a reply by the time this runs.
 */
function addressesAnotherHuman(
  text: string,
  botUserId: string | null,
  authorSlackId: string | null,
): boolean {
  const head = text.trimStart();
  const m = head.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>/);
  if (!m) return false;
  // A possessive is a reference, not an address: "<@U3>'s edits are approved"
  // is talking ABOUT U3 while the sentence after it may be aimed at the bot.
  if (/^['\u2019]s\b/.test(head.slice(m[0].length))) return false;
  const id = m[1];
  return id !== botUserId && id !== authorSlackId;
}

/**
 * May the bot answer this turn with a reaction instead of a reply?
 *
 * Silence is legitimate only for a genuine BYSTANDER turn: someone else's
 * message, in a shared thread the bot merely sits in, that the bot has no
 * outstanding obligation to answer. Each gate removes a case where that is
 * structurally untrue:
 *
 *   1. A 1:1 DM (`im`) is one-to-one. There is no human→human traffic to stay
 *      out of — every message in it is addressed to the bot by definition, and
 *      the dispatcher runs the loop on all of them. Silence there is never
 *      right, so it is the one surface that can never react-only.
 *   2. An actual @-mention IS the summons. The system prompt already said to
 *      reply when @-mentioned; this makes it true rather than advisory.
 *   3. The bot asked a question and the person it was put to is speaking.
 *      Whatever else their reply contains — including an @-mention of some
 *      OTHER human, which is exactly the cue that misfires — the bot's turn is
 *      owed. Ditto a question asked of the thread at large.
 *   4. …but a question the bot is owed by ONE person does not make every later
 *      message in the thread the bot's to answer. When someone the bot is NOT
 *      waiting on posts a message that OPENS by addressing another human, that
 *      is a human→human turn and the bot may stay out of it.
 *      Gate 3 used to swallow this case whole: the bot had asked a participant "Want
 *      me to write this up?", the participant had not answered, so when another
 *      participant later asked them a question — @-mentioning the person, not
 *      the bot — react_only was refused and the bot barged into their exchange.
 *      Because a courtesy offer is almost
 *      never explicitly declined, gate 3 alone stays open for the LIFE of a
 *      thread, which made the bystander restraint close to dead once the bot
 *      had spoken once. Note how narrow the opening is: a LEADING mention only
 *      (see `addressesAnotherHuman`), and never from someone whose answer the
 *      bot is still waiting on.
 *
 * A GROUP DM (`mpim`) is treated like a channel here. The bot otherwise
 * over-narrates messages plainly aimed at another
 * human ("@reviewer can you review this and send comments?") in group chats, and
 * a bystander should be able to just react or stay quiet. Gates 2 and 3 still
 * hold, so the group DM built to hand off a PR review still can't go silent
 * once the bot is @-mentioned (which that room's own notice asks for) or has a
 * question outstanding. The deliberately-accepted residual: a bare go-ahead in
 * a reviewer-handoff group DM that SKIPS that @-mention could now be
 * reacted-to rather than acted-on — the earlier `mpim`-always-replies gate
 * existed precisely to catch that, and losing it is the accepted cost of the
 * restraint. Group-DM messages arrive with `channel_type: "mpim"` (verified
 * by Slack), which is NOT `"im"`.
 *
 * Gate 1 is structural (surface is fixed for a thread) and is ALSO enforced by
 * simply not registering the tool in a 1:1 DM; 2 and 3 flip turn to turn and
 * so can only be refused here. See the registration comment in slackBot.ts.
 */
export function mayStaySilent(args: {
  surface: SlackSurface;
  /** Raw Slack text of the triggering message, mention tokens intact. */
  triggerText: string;
  botUserId: string | null;
  /** Slack delivered this turn as app_mention, even if bot identity was absent. */
  explicitAppMention: boolean;
  /** Slack id of the triggering message's author. */
  authorSlackId: string | null;
  /** The thread as Slack returned it, including the triggering message. */
  messages: readonly SlackMessage[];
}): boolean {
  if (args.surface === "dm") return false;
  if (args.explicitAppMention) return false;
  if (args.botUserId && args.triggerText.includes(`<@${args.botUserId}>`)) {
    return false;
  }
  const open = openQuestionAddressees({
    messages: args.messages,
    botUserId: args.botUserId,
  });
  if (open.length === 0) return true;
  // Both dispatch paths drop an event with no `user`, so this is unreachable
  // today — but an unidentified author cannot be shown NOT to be the person the
  // bot is waiting on, and guessing wrong here swallows a reply. Fail closed.
  if (!args.authorSlackId) return false;
  // The author is someone the bot is waiting on — this may BE the answer, and
  // swallowing it is the failure #1188 exists to prevent. Owed, unconditionally.
  if (open.includes(args.authorSlackId)) return false;
  // A question put to the thread at large (a bot-rooted notification thread —
  // a bug report, a digest) is owed by nobody in particular, so it must NOT
  // short-circuit the aimed-at-another-human check below. It used to, which
  // made that check unreachable in exactly the threads it was written for:
  // every bug thread opens with a triage note ending in "Next question/check:",
  // so the first human to speak always looked owed and the bot replied over a
  // human->human message. Falling through keeps #1188's
  // protection — a bare "yes please" addresses nobody, so it still reads as
  // owed — while letting a message that visibly opens at another human pass.
  //
  // Accepted residual: an answer to a thread-at-large question that OPENS with
  // a mention of a third party ("<@U3> yes, it was Chrome") reads as aimed
  // elsewhere and may be reacted to instead of answered. A question with a
  // known addressee is protected from that by the `authorSlackId` check above;
  // a thread-at-large one has no addressee to protect. Narrow, and the model
  // still has to CHOOSE silence — this only permits it.
  // Nobody the bot is waiting on is speaking. The turn is only NOT the bot's
  // if it is visibly aimed at another human; anything else (a bare "ok cool",
  // a third party's go-ahead) still gets a reply.
  return addressesAnotherHuman(
    args.triggerText,
    args.botUserId,
    args.authorSlackId,
  );
}
