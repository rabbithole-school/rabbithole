// Minimal Slack Web API client over fetch — just the methods the
// Rabbithole bot uses. No SDK dependency: Bolt wants to own the HTTP
// server (we already have Convex HTTP actions), and the Web API is a
// plain JSON-over-POST surface.
//
// All functions take the bot token explicitly (callers read
// process.env.SLACK_BOT_TOKEN) so tests can drive them against a
// stubbed `fetch` without env plumbing.
//
// Streaming: `SlackStreamer` wraps chat.startStream/appendStream/
// stopStream (the Oct-2025 AI-apps streaming surface; thread-only) with
// buffered flushing so we don't hit rate limits posting every LLM
// delta. Falls back to plain postMessage when streaming isn't available
// (e.g. the workspace/app combination rejects startStream).

import { quipHtmlToMarkdown } from "./canvasHtml";
export { escapeSlackText } from "./slackText";

const SLACK_API = "https://slack.com/api";

type SlackResult = {
  ok: boolean;
  error?: string;
  status: number;
  retryAfterMs?: number;
} & Record<string, unknown>;

function retryAfterMs(response: Response): number | undefined {
  // Some unit tests intentionally use the smallest Response-shaped mock. A
  // missing header collection is equivalent to Slack omitting Retry-After.
  const seconds = Number(response.headers?.get?.("Retry-After"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function transportFailure(error: unknown): SlackResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Slack request failed:", error);
  return { ok: false, error: `request_failed: ${message}`, status: 0 };
}

function splitTrailingUrlPunctuation(url: string): [string, string] {
  let end = url.length;
  while (end > 0 && /[.,!?;:]/.test(url[end - 1]!)) end--;

  const pairs: Array<[string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  for (const [open, close] of pairs) {
    let opens = 0;
    let closes = 0;
    for (let i = 0; i < end; i++) {
      if (url[i] === open) opens++;
      if (url[i] === close) closes++;
    }
    while (end > 0 && url[end - 1] === close && closes > opens) {
      end--;
      closes--;
    }
  }
  return [url.slice(0, end), url.slice(end)];
}

/**
 * Slack's markdown_text autolinker can absorb punctuation and following prose.
 * Convert outbound URLs to Slack's explicit link form after the model is done.
 */
export function normalizeSlackLinks(text: string): string {
  let output = "";
  let cursor = 0;
  let changed = false;

  while (cursor < text.length) {
    if (text[cursor] === "<") {
      const end = text.indexOf(">", cursor + 1);
      if (end !== -1 && /^https?:\/\//.test(text.slice(cursor + 1, end))) {
        output += text.slice(cursor, end + 1);
        cursor = end + 1;
        continue;
      }
    }

    if (text[cursor] === "[") {
      const labelEnd = text.indexOf("](", cursor + 1);
      if (labelEnd !== -1) {
        const urlStart = labelEnd + 2;
        if (/^https?:\/\//.test(text.slice(urlStart))) {
          let depth = 1;
          let end = urlStart;
          while (end < text.length && depth > 0) {
            if (text[end] === "(") depth++;
            else if (text[end] === ")") depth--;
            end++;
          }
          if (depth === 0) {
            const label = text.slice(cursor + 1, labelEnd);
            const url = text.slice(urlStart, end - 1);
            output += `<${url}|${label}>`;
            cursor = end;
            changed = true;
            continue;
          }
        }
      }
    }

    if (text.startsWith("http://", cursor) || text.startsWith("https://", cursor)) {
      const match = /^https?:\/\/[^\s<>]+/.exec(text.slice(cursor));
      if (match) {
        const [url, trailing] = splitTrailingUrlPunctuation(match[0]);
        if (url) {
          output += `<${url}>${trailing}`;
          cursor += match[0].length;
          changed = true;
          continue;
        }
      }
    }

    output += text[cursor]!;
    cursor++;
  }

  return changed ? output : text;
}

/**
 * Normalize model-authored Markdown for Slack's supported surface.
 *
 * Claude can wrap text grounded in a tool result with `<cite index="…">`.
 * Slack has no citation renderer and displays those tags literally, so retain
 * the cited prose while removing only the unsupported wrapper.
 */
export function normalizeSlackMarkdown(text: string): string {
  const withoutCitationTags = text.replace(/<\/?cite\b[^>]*>/gi, "");
  return normalizeSlackLinks(withoutCitationTags);
}

// JSON body — for the "write" methods that accept marshalled JSON
// (chat.postMessage, the streaming methods, assistant.threads.*). These
// take string/array args Slack parses from JSON.
async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<SlackResult> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    return transportFailure(error);
  }
  let json: SlackResult;
  try {
    json = (await res.json()) as SlackResult;
  } catch (error: unknown) {
    return {
      ...transportFailure(error),
      status: res.status,
      retryAfterMs: retryAfterMs(res),
    };
  }
  json.status = res.status;
  json.retryAfterMs = retryAfterMs(res);
  if (!json.ok) {
    console.error(`Slack ${method} failed:`, json.error ?? res.status);
  }
  return json;
}

// Form-encoded body — REQUIRED for the read/lookup methods
// (users.lookupByEmail, users.info, conversations.replies). Slack rejects
// a JSON body for these with `invalid_arguments` (verified 2026-06-13):
// they only read `application/x-www-form-urlencoded` (or query) params.
// All values are coerced to strings.
async function slackCallForm(
  token: string,
  method: string,
  params: Record<string, string | number>,
): Promise<SlackResult> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: form.toString(),
    });
  } catch (error: unknown) {
    return transportFailure(error);
  }
  let json: SlackResult;
  try {
    json = (await res.json()) as SlackResult;
  } catch (error: unknown) {
    return {
      ...transportFailure(error),
      status: res.status,
      retryAfterMs: retryAfterMs(res),
    };
  }
  json.status = res.status;
  json.retryAfterMs = retryAfterMs(res);
  if (!json.ok) {
    console.error(`Slack ${method} failed:`, json.error ?? res.status);
  }
  return json;
}

// ── Messages ────────────────────────────────────────────────────────────

export async function postMessage(
  token: string,
  args: {
    channel: string;
    text: string;
    threadTs?: string;
    metadata?: SlackMessageMetadata;
    /** Markdown rendering: Slack's `markdown_text` accepts standard md. */
    markdown?: boolean;
    /**
     * Let Slack unfurl links/media in this message. Defaults to false — see
     * the unfurl_links/unfurl_media note on the body below.
     */
    unfurl?: boolean;
  },
): Promise<{
  ok: boolean;
  ts?: string;
  error?: string;
  retryAfterMs?: number;
  /**
   * Slack documents internal_error and fatal_error as potentially
   * partially-successful. A lost response is equally ambiguous.
   */
  ambiguous?: boolean;
}> {
  const body: Record<string, unknown> = {
    channel: args.channel,
    ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
    // Default OFF: every Rabbithole app route answers an anonymous scraper with
    // the same content-free shell (one root OG block — a stock image + tagline),
    // so an unfurl just staples that noise under a message that already said
    // everything. `unfurl: true` is the opt-in for messages whose EXTERNAL
    // links are worth previewing. Probed live 2026-08-18: with the flag off a
    // known-unfurlable link stays clean for 90s+, with it on the card appears
    // within 15s. (Slack's STREAMING surface — chat.startStream/appendStream —
    // takes no unfurl argument and never unfurls at all, so streamed replies
    // need no equivalent; only these chat.postMessage paths do.)
    unfurl_links: args.unfurl ?? false,
    unfurl_media: args.unfurl ?? false,
  };
  if (args.markdown) {
    body.markdown_text = normalizeSlackMarkdown(args.text);
  } else {
    body.text = args.text;
  }
  const res = await slackCall(token, "chat.postMessage", body);
  // `error` is Slack's own failure code ("channel_not_found",
  // "not_in_channel", …) — surfaced so a caller that must explain WHY a post
  // didn't land can log something actionable instead of a bare false.
  const error = res.error as string | undefined;
  return {
    ok: res.ok,
    ts: res.ts as string | undefined,
    error,
    retryAfterMs: res.retryAfterMs,
    ambiguous:
      !res.ok &&
      (res.status >= 500 ||
        error === "internal_error" ||
        error === "fatal_error" ||
        error?.startsWith("request_failed:") === true),
  };
}

/**
 * Open a conversation with one or more users and return its channel id.
 *
 * ONE user opens (or re-finds) the 1:1 IM — `im:write`. TWO OR MORE opens a
 * GROUP DM (mpim) containing the bot and every listed user — `mpim:write`,
 * which must be granted in slack/manifest.template.json AND the app
 * REINSTALLED before the live token carries it (a token keeps its old scope
 * set until reinstall; the failure is `missing_scope`).
 *
 * Idempotent: re-opening an existing conversation returns the same id and
 * posts nothing, so a retry can never spawn a duplicate group DM. Slack
 * accepts a JSON body here (verified against the live API 2026-07-25) — this
 * is a write method, not one of the form-only lookups above.
 */
export async function openConversation(
  token: string,
  userIds: string[],
): Promise<{ ok: boolean; channelId?: string; error?: string }> {
  const users = userIds.map((id) => id.trim()).filter(Boolean);
  if (users.length === 0) return { ok: false, error: "no_users" };
  const res = await slackCall(token, "conversations.open", {
    users: users.join(","),
  });
  const channel = res.channel as { id?: string } | undefined;
  return { ok: res.ok, channelId: channel?.id, error: res.error };
}

type SlackFileUploadArgs = {
  channel: string;
  threadTs?: string;
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
  title?: string;
  initialComment?: string;
};

/**
 * Upload a file into a thread via Slack's external-upload flow. Best-effort:
 * returns { ok } and never throws so an attachment failure cannot sink a reply.
 */
export async function uploadFileToSlack(
  token: string,
  args: SlackFileUploadArgs,
): Promise<{ ok: boolean; fileId?: string }> {
  try {
    const start = await slackCallForm(token, "files.getUploadURLExternal", {
      filename: args.filename,
      length: args.bytes.byteLength,
    });
    const uploadUrl = start.upload_url as string | undefined;
    const fileId = start.file_id as string | undefined;
    if (!start.ok || !uploadUrl || !fileId) return { ok: false };

    const form = new FormData();
    form.append(
      "file",
      new Blob([args.bytes as unknown as BlobPart], {
        type: args.mimeType ?? "application/octet-stream",
      }),
      args.filename,
    );
    const up = await fetch(uploadUrl, { method: "POST", body: form });
    if (!up.ok) return { ok: false };

    const complete = await slackCall(token, "files.completeUploadExternal", {
      files: [{ id: fileId, title: args.title ?? args.filename }],
      channel_id: args.channel,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      ...(args.initialComment ? { initial_comment: args.initialComment } : {}),
    });
    return { ok: complete.ok, fileId };
  } catch (e) {
    console.error("uploadFileToSlack failed:", e);
    return { ok: false };
  }
}

export async function uploadImageToSlack(
  token: string,
  args: Omit<SlackFileUploadArgs, "mimeType">,
): Promise<{ ok: boolean; fileId?: string }> {
  return uploadFileToSlack(token, args);
}

/**
 * Post a subtle "context block" message — small gray text, Slack's idiomatic
 * treatment for system/aside notes. We use it to render coalesced tool
 * activity inline between assistant utterances (mirrors the web UI's gray
 * tool-activity rows) without the visual weight of a normal message.
 */
export async function postContext(
  token: string,
  args: { channel: string; text: string; threadTs?: string },
): Promise<{ ok: boolean; ts?: string }> {
  const body: Record<string, unknown> = {
    channel: args.channel,
    ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    // Default OFF: every Rabbithole app route answers an anonymous scraper with
    // the same content-free shell (one root OG block — a stock image + tagline),
    // so an unfurl just staples that noise under a message that already said
    // everything. `unfurl: true` is the opt-in for messages whose EXTERNAL
    // links are worth previewing. A context block is a small gray aside for
    // tool activity, so it takes no opt-in — a preview is never wanted here.
    unfurl_links: false,
    unfurl_media: false,
    // Fallback text for notifications / clients that can't render blocks.
    text: args.text,
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: args.text }],
      },
    ],
  };
  const res = await slackCall(token, "chat.postMessage", body);
  return { ok: res.ok, ts: res.ts as string | undefined };
}

/**
 * Rewrite a context-block message in place. Same block shape as postContext, so
 * a row posted live as "⋯ Creating event drafts…" can settle into the "✓ …"
 * record without posting a second message.
 */
export async function updateContext(
  token: string,
  args: { channel: string; ts: string; text: string },
): Promise<{ ok: boolean }> {
  const res = await slackCall(token, "chat.update", {
    channel: args.channel,
    ts: args.ts,
    text: args.text,
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: args.text }],
      },
    ],
  });
  return { ok: res.ok };
}

/** Delete one of the bot's own messages (`chat:write`, no extra scope). Used to
 *  retract a live tool-activity block when the turn ends in react_only. */
export async function deleteMessage(
  token: string,
  args: { channel: string; ts: string },
): Promise<{ ok: boolean }> {
  const res = await slackCall(token, "chat.delete", {
    channel: args.channel,
    ts: args.ts,
  });
  return { ok: res.ok };
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  files?: SlackFile[];
  subtype?: string;
  metadata?: SlackMessageMetadata;
  /**
   * Forwarded messages and link previews. Slack puts NOTHING in `text` when a
   * human forwards a message — the quoted content lands here instead, so a bot
   * reading only `text` sees an empty message and answers confidently about
   * nothing.
   */
  attachments?: SlackAttachment[];
  /**
   * Present on the Slackbot system message that ROOTS a Slack List record's
   * comment thread (`subtype: "list_record_comment"`). It's the only place the
   * comment surface exposes WHICH row was commented on — the human replies only
   * point at the row, whose content lives in the List, not the thread.
   */
  slack_list?: { list_id?: string; list_record_id?: string };
  /**
   * The rich_text rendering of the message. Only needed by callers that show a
   * Slack message to a human OUTSIDE Slack — it is where the emoji codepoints
   * live (see `resolveSlackEmoji`).
   */
  blocks?: unknown;
}

/**
 * Slack puts emoji in `text` as `:shortcode:` — so anything that replays a
 * Slack message somewhere Slack isn't rendering it shows a literal `:rabbit2:`
 * to the reader. A staff reply to a Workshop idea is read by a CHILD, so it has
 * to be resolved.
 *
 * No emoji table is needed: Slack already hands us the codepoint in the message's
 * rich_text blocks (`{type:"emoji", name:"rabbit2", unicode:"1f407"}`), so this
 * harvests those and substitutes them back into the text. Custom workspace emoji
 * carry no `unicode` and are left as-is rather than deleted — never silently drop
 * a human's characters.
 */
export function resolveSlackEmoji(text: string, blocks: unknown): string {
  if (!text.includes(":")) return text;
  const byName = new Map<string, string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (
      rec.type === "emoji" &&
      typeof rec.name === "string" &&
      typeof rec.unicode === "string"
    ) {
      try {
        byName.set(
          rec.name,
          String.fromCodePoint(
            ...rec.unicode.split("-").map((hex) => Number.parseInt(hex, 16)),
          ),
        );
      } catch {
        // A malformed codepoint just means the shortcode stays as written.
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(blocks);
  if (byName.size === 0) return text;
  return text.replace(
    /:([a-z0-9_+'-]+):/gi,
    (whole, name: string) => byName.get(name) ?? whole,
  );
}

export interface SlackMessageMetadata {
  event_type: string;
  event_payload: Record<string, unknown>;
}

export function messageWithDeliveryMetadata(
  messages: SlackMessage[],
  eventType: string,
  deliveryId: string,
): SlackMessage | undefined {
  return messages.find(
    (message) =>
      message.metadata?.event_type === eventType &&
      message.metadata.event_payload.delivery_id === deliveryId &&
      Boolean(message.ts),
  );
}

/**
 * A Slack message attachment: either a FORWARDED message (`is_share`) or a
 * link preview Slack unfurled.
 *
 * Both carry content Slack has ALREADY RENDERED into the destination channel,
 * which is why reading them needs no authorization gate — see
 * `renderSlackAttachments`.
 */
export interface SlackAttachment {
  /** True when this is a forwarded Slack message rather than a link preview. */
  is_share?: boolean;
  /** Set on an unfurled permalink to another Slack message. */
  is_msg_unfurl?: boolean;
  /** Display name of the ORIGINAL message's author. */
  author_name?: string;
  /** Name of the conversation the original message came from, sans `#`. */
  channel_name?: string;
  channel_id?: string;
  /** The original message's body. */
  text?: string;
  /** Link-preview title (and its URL). */
  title?: string;
  title_link?: string;
  /** Plain-text stand-in Slack generates; last resort when `text` is absent. */
  fallback?: string;
  /** Files attached to the ORIGINAL message. Not downloaded — named only. */
  files?: SlackFile[];
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  filetype?: string;
  mimetype?: string;
  pretty_type?: string;
  mode?: string;
  editable?: boolean;
  size?: number;
  url_private_download?: string;
}

/**
 * Read a thread (or a single message) via conversations.replies, surfacing
 * Slack's `ok`/`error` so the caller can distinguish "the bot isn't in that
 * conversation" (`not_in_channel`) from a real fetch. `ts` may be a thread
 * parent OR any message-in-thread ts; for an unthreaded message Slack returns
 * a one-element array. Form-encoded per the read-method quirk above.
 */
export async function fetchConversationReplies(
  token: string,
  channel: string,
  ts: string,
  limit = 200,
): Promise<{
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  messages: SlackMessage[];
}> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  // An ambiguous reply can be older than a busy thread's first page. Reconcile
  // all bounded pages before retrying the write; fail closed if the scan caps.
  for (let page = 0; page < 10; page += 1) {
    const res = await slackCallForm(token, "conversations.replies", {
      channel,
      ts,
      limit,
      include_all_metadata: "true",
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error as string | undefined,
        retryAfterMs: res.retryAfterMs,
        messages: [],
      };
    }
    messages.push(...((res.messages as SlackMessage[] | undefined) ?? []));
    const nextCursor = (
      res.response_metadata as { next_cursor?: string } | undefined
    )?.next_cursor;
    if (!nextCursor) {
      return { ok: true, messages };
    }
    cursor = nextCursor;
  }
  return { ok: false, error: "reconciliation_scan_incomplete", messages: [] };
}

/**
 * Read the bounded recent top-level history with Slack message metadata. This is
 * used to reconcile an ambiguous write before a caller considers sending it
 * again; callers must fail closed if this read itself cannot be confirmed.
 */
export async function fetchConversationHistory(
  token: string,
  channel: string,
  options: { oldest?: string; limit?: number } = {},
): Promise<{
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  messages: SlackMessage[];
}> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  // A bounded scan prevents a busy channel from hiding a prior accepted post
  // behind the first page while also avoiding unbounded work in an action.
  for (let page = 0; page < 10; page += 1) {
    const res = await slackCallForm(token, "conversations.history", {
      channel,
      limit: options.limit ?? 200,
      include_all_metadata: "true",
      ...(options.oldest ? { oldest: options.oldest } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error as string | undefined,
        retryAfterMs: res.retryAfterMs,
        messages: [],
      };
    }
    messages.push(...((res.messages as SlackMessage[] | undefined) ?? []));
    const nextCursor = (
      res.response_metadata as { next_cursor?: string } | undefined
    )?.next_cursor;
    if (!nextCursor) {
      return { ok: true, messages };
    }
    cursor = nextCursor;
  }
  return { ok: false, error: "reconciliation_scan_incomplete", messages: [] };
}

export async function fetchThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
  maxMessages = 50,
): Promise<SlackMessage[]> {
  const res = await fetchConversationReplies(token, channel, threadTs, 200);
  if (!res.ok || maxMessages <= 0) return [];
  if (res.messages.length <= maxMessages) return res.messages;
  if (maxMessages === 1) return [res.messages[res.messages.length - 1]];

  // Keep the root for the thread's durable context, then the newest turns.
  // fetchConversationReplies is intentionally exhaustive for reconciliation
  // callers; the aide must not inherit that unbounded model context.
  return [
    res.messages[0],
    ...res.messages.slice(-(maxMessages - 1)),
  ];
}

/**
 * List the member user ids of a conversation via conversations.members,
 * surfacing Slack's `ok`/`error`. Used to authorize a REQUESTER against a
 * conversation a forwarded permalink points at (Slack authorizes the read
 * methods against the BOT token, so a membership check is what enforces the
 * human's own access). Form-encoded per the read-method quirk above; paginates
 * with `cursor` but caps the number of pages (school conversations are small).
 * `not_in_channel` means the BOT itself isn't a member.
 *
 * NOTE: needs a `*:read` scope (channels/groups/im/mpim) — distinct from the
 * `*:history` scopes used to read messages. Callers must treat a non-ok result
 * (incl. `missing_scope`) as "cannot verify" and fail CLOSED.
 */
export async function fetchConversationMembers(
  token: string,
  channel: string,
  maxMembers = 1000,
): Promise<{ ok: boolean; error?: string; members: string[] }> {
  const members: string[] = [];
  let cursor: string | undefined;
  // Hard page cap: 200/page × 8 = 1600 ids max, well beyond any school channel.
  for (let page = 0; page < 8; page++) {
    const params: Record<string, string | number> = { channel, limit: 200 };
    if (cursor) params.cursor = cursor;
    const res = await slackCallForm(token, "conversations.members", params);
    if (!res.ok) {
      return { ok: false, error: res.error as string | undefined, members };
    }
    for (const m of (res.members as string[] | undefined) ?? []) members.push(m);
    cursor =
      (res.response_metadata as { next_cursor?: string } | undefined)
        ?.next_cursor || undefined;
    if (!cursor || members.length >= maxMembers) break;
  }
  return { ok: true, members };
}

/**
 * What KIND of conversation this is: 1:1 DM, group DM (mpim), or channel.
 *
 * Needed because `app_mention` events carry NO `channel_type` field at all
 * (probed live 2026-07-26 — `message` events have it, `app_mention` events do
 * not), so a mention is the one entry point that cannot classify its own
 * surface from the payload. Do NOT substitute the channel-id prefix: a group
 * DM comes back `C`-prefixed, and `conversations.info` on one reports
 * `is_channel: true` alongside `is_mpim: true` — so the two DM flags must be
 * read FIRST, in this order (also verified live against a real mpim, im, and
 * public channel).
 *
 * Read-shaped, so form-encoded like the other lookups. Needs the matching
 * `*:read` scope (all four are granted). Returns null when we cannot tell —
 * callers pick their own default rather than getting a silent wrong answer.
 */
export async function fetchConversationKind(
  token: string,
  channel: string,
): Promise<"dm" | "mpim" | "channel" | null> {
  const res = await slackCallForm(token, "conversations.info", { channel });
  if (!res.ok) return null;
  const info = res.channel as
    | { is_im?: boolean; is_mpim?: boolean }
    | undefined;
  if (!info) return null;
  if (info.is_im) return "dm";
  if (info.is_mpim) return "mpim";
  return "channel";
}

/** Archive URL for one message — the "Copy link" permalink, resolved by
 * Slack rather than hand-built from the workspace domain (which we don't
 * store). Read-shaped, so form-encoded like users.info. Null on any
 * failure: a permalink is always a nice-to-have, never load-bearing. */
export async function getMessagePermalink(
  token: string,
  channelId: string,
  messageTs: string,
): Promise<string | null> {
  const res = await slackCallForm(token, "chat.getPermalink", {
    channel: channelId,
    message_ts: messageTs,
  });
  if (!res.ok) return null;
  return typeof res.permalink === "string" ? res.permalink : null;
}

// ── Users ───────────────────────────────────────────────────────────────
export async function fetchSlackUserInfo(
  token: string,
  slackUserId: string,
): Promise<{ name: string | null; email: string | null }> {
  const res = await slackCallForm(token, "users.info", { user: slackUserId });
  if (!res.ok) return { name: null, email: null };
  const user = res.user as
    | {
        real_name?: string;
        name?: string;
        profile?: { display_name?: string; real_name?: string; email?: string };
      }
    | undefined;
  const name =
    user?.profile?.display_name ||
    user?.profile?.real_name ||
    user?.real_name ||
    user?.name ||
    null;
  return { name, email: user?.profile?.email ?? null };
}

export async function lookupSlackUserByEmail(
  token: string,
  email: string,
): Promise<{ slackUserId: string; name: string | null } | null> {
  const res = await slackCallForm(token, "users.lookupByEmail", { email });
  if (!res.ok) return null;
  const user = res.user as { id: string; real_name?: string } | undefined;
  return user ? { slackUserId: user.id, name: user.real_name ?? null } : null;
}

export async function fetchSlackBotIdentity(
  token: string,
): Promise<{ userId: string; teamId: string | null } | null> {
  const res = await slackCallForm(token, "auth.test", {});
  if (
    !res.ok ||
    typeof res.user_id !== "string" ||
    typeof res.bot_id !== "string"
  ) {
    return null;
  }
  return {
    userId: res.user_id,
    teamId: typeof res.team_id === "string" ? res.team_id : null,
  };
}

// ── Assistant-thread niceties (DM split-pane surface) ───────────────────

export async function setAssistantStatus(
  token: string,
  args: { channelId: string; threadTs: string; status: string },
): Promise<void> {
  await slackCall(token, "assistant.threads.setStatus", {
    channel_id: args.channelId,
    thread_ts: args.threadTs,
    status: args.status,
  });
}

export async function setAssistantTitle(
  token: string,
  args: { channelId: string; threadTs: string; title: string },
): Promise<void> {
  await slackCall(token, "assistant.threads.setTitle", {
    channel_id: args.channelId,
    thread_ts: args.threadTs,
    title: args.title,
  });
}

export async function setSuggestedPrompts(
  token: string,
  args: {
    channelId: string;
    prompts: Array<{ title: string; message: string }>;
  },
): Promise<void> {
  // Agent messaging experience (agent_view): prompts pin to the top of the
  // Messages tab, so thread_ts is not needed (docs: "In this experience, the
  // thread_ts parameter is not needed").
  await slackCall(token, "assistant.threads.setSuggestedPrompts", {
    channel_id: args.channelId,
    prompts: args.prompts,
  });
}

/**
 * Whether the DM channel already holds any messages. Used to fire the
 * one-time welcome only on a genuinely fresh DM — `app_home_opened` (the
 * agent_view DM-open signal) fires on EVERY open, unlike the old one-shot
 * `assistant_thread_started`. Needs the `im:history` scope; on error we
 * report "not empty" so a transient failure suppresses the greeting rather
 * than risking a repeat.
 */
export async function dmHasMessages(
  token: string,
  channel: string,
): Promise<boolean> {
  const res = await slackCallForm(token, "conversations.history", {
    channel,
    limit: 1,
  });
  if (!res.ok) return true;
  return ((res.messages as SlackMessage[] | undefined) ?? []).length > 0;
}

// ── Reactions (instant acknowledgement) ─────────────────────────────────

/**
 * Sub-second "I saw this" signal: react to the triggering message before
 * any model work starts. Needs the `reactions:write` scope — degrades to
 * a logged no-op (missing_scope) on apps installed before the scope was
 * added, so it's safe to call unconditionally.
 */
export async function addReaction(
  token: string,
  args: { channel: string; timestamp: string; name: string },
): Promise<void> {
  await slackCall(token, "reactions.add", {
    channel: args.channel,
    timestamp: args.timestamp,
    name: args.name,
  });
}

/**
 * Remove a reaction the bot previously added (same `reactions:write` scope as
 * addReaction — no new permission). Used to reconcile the auto-👀 "working on
 * it" ack when the model decides to stay silent / react-only instead of
 * replying, so we don't leave a dangling "working" signal on a message the bot
 * chose not to answer. Best-effort: Slack returns `no_reaction` if it was never
 * added (e.g. reactions:write missing on an old install) — the caller ignores it.
 */
export async function removeReaction(
  token: string,
  args: { channel: string; timestamp: string; name: string },
): Promise<void> {
  await slackCall(token, "reactions.remove", {
    channel: args.channel,
    timestamp: args.timestamp,
    name: args.name,
  });
}

// ── Conversation topic ──────────────────────────────────────────────────

/** Slack caps a conversation topic at 250 characters. */
export const SLACK_TOPIC_MAX = 250;

/**
 * Stamp a self-documenting topic on a channel we just linked to a Rabbithole
 * entity, so the channel reads as "what is this wired to?". Needs the
 * `*:write.topic` scopes (channels/groups/im/mpim). Form-encoded, like the
 * other lookup methods.
 *
 * BEST-EFFORT by construction: a topic write must NEVER fail the link that
 * triggered it, so this swallows every error (network throw, `ok:false`) and
 * returns an `{ ok, error }` shape instead of throwing. Callers only stamp on
 * the explicit human LINK action and only on a channel they just linked — never
 * a background job, and never overwriting a topic we didn't set.
 */
export async function setConversationTopic(
  token: string,
  channelId: string,
  topic: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed =
    topic.length > SLACK_TOPIC_MAX ? topic.slice(0, SLACK_TOPIC_MAX) : topic;
  try {
    const res = await slackCallForm(token, "conversations.setTopic", {
      channel: channelId,
      topic: trimmed,
    });
    return res.ok
      ? { ok: true }
      : { ok: false, error: (res.error as string | undefined) ?? "unknown" };
  } catch (err) {
    console.error("Slack conversations.setTopic threw:", err);
    return { ok: false, error: String(err) };
  }
}

// ── File download (Phase 4 document intake) ─────────────────────────────

export async function downloadSlackFile(
  token: string,
  urlPrivateDownload: string,
): Promise<Blob | null> {
  const res = await fetch(urlPrivateDownload, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Slack file download failed: ${res.status}`);
    return null;
  }
  return await res.blob();
}

// ── Canvases (weekly Quality Pulse report) ──────────────────────────────
//
// API contracts verified against the live docs + node-slack-sdk types
// (2026-07-03):
//   • canvases.create — JSON body { title?, document_content:{type:"markdown",
//     markdown}, channel_id? }. Response carries the new canvas id at the
//     TOP LEVEL as `canvas_id` (node-slack-sdk CanvasesCreateResponse:
//     `canvas_id?: string`). Needs the `canvases:write` bot scope.
//     https://docs.slack.dev/reference/methods/canvases.create
//   • canvases.access.set — JSON body { canvas_id, access_level:"read"|"write",
//     channel_ids?:string[] | user_ids?:string[] } (the two are mutually
//     exclusive). https://docs.slack.dev/reference/methods/canvases.access.set
//   • canvases.edit — JSON body { canvas_id, changes:[{operation, …}] }. Only
//     ONE operation per call. `{operation:"replace", document_content}` with NO
//     section_id replaces the ENTIRE canvas; `{operation:"rename",
//     title_content}` renames it. Needs `canvases:write`. This is the "revise
//     that brief" path — edit the existing canvas instead of creating a second.
//     https://docs.slack.dev/reference/methods/canvases.edit
//   • files.info — a READ method (→ form-encoded, like users.info). A canvas
//     id IS a file id, so files.info returns the canvas's `permalink`
//     (`files:read` scope). https://docs.slack.dev/reference/methods/files.info
//
// All three degrade gracefully: on a workspace without `canvases:write` (the
// expected state until a human adds the scope + reinstalls) create returns
// `{ ok:false, error:"missing_scope" }`, and the caller falls back to posting
// the report as message text. NONE of these throw.

/**
 * Create a standalone canvas owned by the bot. Returns the new canvas id (a
 * file id) on success. `{ ok:false }` on any Slack error (e.g. missing_scope).
 */
export async function canvasCreate(
  token: string,
  args: { title?: string; markdown: string },
): Promise<{ ok: boolean; canvasId?: string; error?: string }> {
  const res = await slackCall(token, "canvases.create", {
    ...(args.title ? { title: args.title } : {}),
    document_content: { type: "markdown", markdown: args.markdown },
  });
  return {
    ok: res.ok,
    canvasId: res.canvas_id as string | undefined,
    error: res.error as string | undefined,
  };
}

/**
 * Grant a channel (or list of channels) access to a canvas. Defaults to
 * `read` — the Quality Pulse canvas is a report, not a shared doc. Returns
 * `{ ok }`; never throws.
 */
export async function canvasSetAccess(
  token: string,
  args: {
    canvasId: string;
    channelIds: string[];
    accessLevel?: "read" | "write";
  },
): Promise<{ ok: boolean; error?: string }> {
  const res = await slackCall(token, "canvases.access.set", {
    canvas_id: args.canvasId,
    access_level: args.accessLevel ?? "read",
    channel_ids: args.channelIds,
  });
  return { ok: res.ok, error: res.error as string | undefined };
}

/**
 * Replace an existing canvas's ENTIRE content (and optionally rename it) — the
 * "revise that brief" path. `canvases.edit` allows only one operation per call,
 * so a rename is a second call: we replace the document first, then best-effort
 * rename (a failed rename is non-fatal — the content already updated). Returns
 * `{ ok }`; never throws.
 */
export async function canvasEdit(
  token: string,
  args: { canvasId: string; markdown: string; title?: string },
): Promise<{ ok: boolean; error?: string }> {
  // `replace` with no section_id replaces the whole document.
  const replaced = await slackCall(token, "canvases.edit", {
    canvas_id: args.canvasId,
    changes: [
      {
        operation: "replace",
        document_content: { type: "markdown", markdown: args.markdown },
      },
    ],
  });
  if (!replaced.ok) {
    return { ok: false, error: replaced.error as string | undefined };
  }
  if (args.title) {
    const renamed = await slackCall(token, "canvases.edit", {
      canvas_id: args.canvasId,
      changes: [
        {
          operation: "rename",
          title_content: { type: "markdown", markdown: args.title },
        },
      ],
    });
    if (!renamed.ok) {
      console.error(
        `canvases.edit rename failed (content already updated): ${renamed.error}`,
      );
    }
  }
  return { ok: true };
}

/**
 * Read a canvas's CURRENT contents as markdown — the READ counterpart to
 * canvasCreate/canvasEdit, so the bot can see the inline edits staff made to a
 * canvas instead of only being able to overwrite it. A canvas id IS a file id,
 * so files.info (READ → form-encoded) yields its `url_private`; downloading
 * that with the bot token returns the body as quip HTML, which we convert to
 * markdown. Needs only `files:read` (NOT canvases:write). Never throws.
 *
 * Returns `{ ok:true, markdown, title }` on success, else `{ ok:false, error }`
 * carrying the Slack error code (e.g. "missing_scope") so a caller can render
 * the exact human-fix line.
 */
export async function fetchCanvasContent(
  token: string,
  canvasId: string,
): Promise<{
  ok: boolean;
  markdown?: string;
  title?: string;
  error?: string;
}> {
  let info: SlackResult;
  try {
    info = await slackCallForm(token, "files.info", { file: canvasId });
  } catch (err) {
    console.error("fetchCanvasContent: reading canvas metadata threw:", err);
    return { ok: false, error: "request_failed" };
  }
  if (!info.ok) {
    return {
      ok: false,
      error: info.error?.startsWith("request_failed:")
        ? "request_failed"
        : ((info.error as string | undefined) ?? "unknown"),
    };
  }
  const file = info.file as
    | {
      filetype?: string;
      mimetype?: string;
      mode?: string;
      pretty_type?: string;
      editable?: boolean;
      url_private?: string;
      url_private_download?: string;
      title?: string;
    }
    | undefined;
  if (!isSlackCanvasFile(file)) {
    return { ok: false, error: "not_a_canvas" };
  }
  const url = file?.url_private_download ?? file?.url_private;
  if (!url) {
    return { ok: false, error: "no_content_url" };
  }
  let blob: Blob | null;
  try {
    blob = await downloadSlackFile(token, url);
  } catch (err) {
    console.error("fetchCanvasContent: downloading canvas threw:", err);
    return { ok: false, error: "request_failed" };
  }
  if (!blob) {
    return { ok: false, error: "download_failed" };
  }
  let html: string;
  try {
    html = await blob.text();
  } catch (err) {
    console.error("fetchCanvasContent: reading canvas bytes threw:", err);
    return { ok: false, error: "request_failed" };
  }
  return { ok: true, markdown: quipHtmlToMarkdown(html), title: file?.title };
}

/**
 * Slack exposes a Canvas as a Quip-backed Slack document, not as
 * `filetype: "canvas"`. Require its three machine-readable document markers;
 * URLs alone are not discriminating because ordinary uploads have private URLs.
 */
function isSlackCanvasFile(
  file:
    | {
      filetype?: string;
      mimetype?: string;
      mode?: string;
    }
    | undefined,
): boolean {
  return (
    file?.filetype === "quip" &&
    file.mimetype === "application/vnd.slack-docs" &&
    file.mode === "quip"
  );
}

/**
 * A shareable permalink for a file id. Canvas ids are file ids, so this yields
 * the canvas's public-in-workspace link. `null` on any error (READ method →
 * form-encoded, per the users.info/conversations.replies precedent above).
 */
export async function getFilePermalink(
  token: string,
  fileId: string,
): Promise<string | null> {
  const res = await slackCallForm(token, "files.info", { file: fileId });
  if (!res.ok) return null;
  const file = res.file as { permalink?: string } | undefined;
  return file?.permalink ?? null;
}

/**
 * The full "publish a weekly report as a Slack canvas" flow, shared by every
 * digest that posts a canvas (the Quality Pulse and the usage/cost report):
 * create the canvas, grant every linked alert channel read access, fetch a permalink.
 * Best-effort and NEVER throws — the caller always still posts its teaser.
 *
 * Returns `{ canvasUrl, canvasError, canvasId }`:
 *   - success            → { canvasUrl: <link>, canvasError: null, canvasId: <id> }
 *   - Slack not linked    → { canvasUrl: null, canvasError: null, canvasId: null }  (not a failure)
 *   - create/permalink bad → { canvasUrl: null, canvasError: <code>, canvasId: <id>|null }
 * `canvasError` carries the Slack error code (e.g. "missing_scope") so the
 * caller can render the exact human-fix line. `canvasId` is returned even when
 * the permalink lookup fails, so a caller can still remember + later edit the
 * canvas it just created.
 */
export async function publishReportCanvas(
  token: string | undefined,
  args: {
    title: string;
    markdown: string;
    channelIds: string[];
    logTag?: string;
    /**
     * Channel access level. Defaults to `read`, which is right for a REPORT
     * (Quality Pulse, usage/cost) — nobody should edit a generated report.
     * Pass `write` for a working DRAFT the channel is meant to mark up: a
     * campaign brief exists to be commented on and edited, and read-only
     * access quietly defeats that.
     */
    accessLevel?: "read" | "write";
  },
): Promise<{
  canvasUrl: string | null;
  canvasError: string | null;
  canvasId: string | null;
}> {
  const tag = args.logTag ?? "canvas";
  if (!token) {
    console.log(`[${tag}] no SLACK_BOT_TOKEN — canvas not attempted; teaser posts alone`);
    return { canvasUrl: null, canvasError: null, canvasId: null };
  }
  try {
    const created = await canvasCreate(token, {
      title: args.title,
      markdown: args.markdown,
    });
    if (!created.ok || !created.canvasId) {
      const canvasError = created.error ?? "unknown_error";
      console.log(`[${tag}] canvas create failed (${canvasError}) — teaser + error line`);
      return { canvasUrl: null, canvasError, canvasId: null };
    }
    if (args.channelIds.length > 0) {
      const access = await canvasSetAccess(token, {
        canvasId: created.canvasId,
        channelIds: args.channelIds,
        accessLevel: args.accessLevel,
      });
      if (!access.ok) {
        console.error(`[${tag}] canvas access.set failed (continuing): ${access.error}`);
      }
    }
    const canvasUrl = await getFilePermalink(token, created.canvasId);
    console.log(
      `[${tag}] canvas created (${created.canvasId}), permalink ${canvasUrl ? "ok" : "unavailable"}`,
    );
    return {
      canvasUrl,
      canvasError: canvasUrl ? null : "permalink_unavailable",
      canvasId: created.canvasId,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${tag}] canvas creation FAILED (teaser + error line): ${msg}`);
    return { canvasUrl: null, canvasError: "request_failed", canvasId: null };
  }
}

/**
 * Update an EXISTING canvas in place — the "revise that brief" path shared with
 * publish_campaign_brief: replace its content, optionally rename it, and fetch
 * a fresh permalink. Same `{ canvasUrl, canvasError }` shape and never-throws
 * contract as publishReportCanvas; `edited` distinguishes a successfully
 * replaced document whose permalink lookup failed from an edit failure. The
 * caller must only fall back to CREATING a new canvas when `edited` is false
 * (e.g. the canvas was deleted).
 */
export async function editReportCanvas(
  token: string | undefined,
  args: {
    canvasId: string;
    title?: string;
    markdown: string;
    logTag?: string;
  },
): Promise<{
  edited: boolean;
  canvasUrl: string | null;
  canvasError: string | null;
}> {
  const tag = args.logTag ?? "canvas";
  if (!token) {
    return { edited: false, canvasUrl: null, canvasError: null };
  }
  try {
    const edited = await canvasEdit(token, {
      canvasId: args.canvasId,
      markdown: args.markdown,
      title: args.title,
    });
    if (!edited.ok) {
      const canvasError = edited.error ?? "unknown_error";
      console.log(`[${tag}] canvas edit failed (${canvasError})`);
      return { edited: false, canvasUrl: null, canvasError };
    }
    const canvasUrl = await getFilePermalink(token, args.canvasId);
    console.log(
      `[${tag}] canvas edited (${args.canvasId}), permalink ${canvasUrl ? "ok" : "unavailable"}`,
    );
    return {
      edited: true,
      canvasUrl,
      canvasError: canvasUrl ? null : "permalink_unavailable",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${tag}] canvas edit FAILED: ${msg}`);
    return { edited: false, canvasUrl: null, canvasError: "request_failed" };
  }
}

// ── Lists (slackLists.*) ────────────────────────────────────────────────
// Slack's native task/table surface (public API GA 2025-09-02). A List is a
// file (`F…`) of typed columns; rows are items/records with `fields` cells.
// All these methods accept a JSON body (verified against live workspaces via
// the justadityaraj/slack-lists-mcp reference), so they use slackCall.

/**
 * Fetch ONE record (row) by its `Rec…` id via `slackLists.items.info`. The
 * response carries the record's `fields` (cell values) AND the List's column
 * schema at `list.list_metadata.schema`.
 *
 * NOTE: this is also the ONLY working way to read a List's schema — the
 * seemingly-obvious `slackLists.info` is `unknown_method` on the live API (it
 * doesn't exist), and `slackLists.items.list` returns rows without the schema.
 * So schema always comes from an `items.info` on some record.
 */
export async function listItemInfo(
  token: string,
  listId: string,
  recordId: string,
): Promise<SlackResult> {
  return slackCall(token, "slackLists.items.info", {
    list_id: listId,
    id: recordId,
  });
}

/** One (cursor-paginated) page of a List's rows. */
export async function listItems(
  token: string,
  listId: string,
  opts?: { limit?: number; cursor?: string },
): Promise<SlackResult> {
  return slackCall(token, "slackLists.items.list", {
    list_id: listId,
    limit: opts?.limit ?? 100,
    ...(opts?.cursor ? { cursor: opts.cursor } : {}),
  });
}

/** Create a row. `initialFields` are cell payloads from buildListCell(). */
export async function listItemCreate(
  token: string,
  listId: string,
  initialFields: Array<Record<string, unknown>>,
  parentItemId?: string,
): Promise<SlackResult> {
  return slackCall(token, "slackLists.items.create", {
    list_id: listId,
    initial_fields: initialFields,
    ...(parentItemId ? { parent_item_id: parentItemId } : {}),
  });
}

/** Update cells on an existing row. Each `cell` = a buildListCell() payload + `row_id`. */
export async function listItemUpdate(
  token: string,
  listId: string,
  cells: Array<Record<string, unknown>>,
): Promise<SlackResult> {
  return slackCall(token, "slackLists.items.update", { list_id: listId, cells });
}

/** Delete a row by its record id (`Rec…`). Note: the param is `id`, not `row_id`. */
export async function listItemDelete(
  token: string,
  listId: string,
  itemId: string,
): Promise<SlackResult> {
  return slackCall(token, "slackLists.items.delete", { list_id: listId, id: itemId });
}

// ── Streaming responses ─────────────────────────────────────────────────

/**
 * Buffered streamed reply in a thread. Usage:
 *   const s = new SlackStreamer(token, { channel, threadTs, recipientTeamId, recipientUserId });
 *   await s.start();          // OPTIONAL eager start: message appears immediately
 *   s.taskUpdate({...});      // live "thinking / running tool" progress chunks
 *   s.append(textDelta);      // cheap, buffers
 *   await s.flush();          // optional explicit flush
 *   await s.finish();         // stop the stream (or post buffered text if streaming unavailable)
 *
 * Eager start + task updates are the responsiveness affordance: without
 * them nothing renders until the FIRST TEXT token, which on a tool-heavy
 * turn is the last thing the model produces. If chat.startStream is
 * rejected (older workspace / missing feature), everything degrades to a
 * single chat.postMessage on finish().
 */
export class SlackStreamer {
  private token: string;
  private channel: string;
  private threadTs: string;
  private recipientTeamId?: string;
  private recipientUserId?: string;

  private streamTs: string | null = null;
  private streamingUnavailable = false;
  private buffer = "";
  private fullText = "";
  private sentAnything = false;
  private discarded = false;
  private lastFlush = 0;
  private inFlight: Promise<void> = Promise.resolve();
  /** Optional ordering gate: the stream won't open (and thus won't claim its
   * Slack ts / ordering slot) until this resolves. Used to keep a fresh
   * utterance's message strictly after the context-block message that
   * precedes it. */
  private startGate?: Promise<unknown>;

  /** Flush when the buffer exceeds this many chars (or on explicit flush).
   * Modest values keep the streamed text crawling in small, frequent
   * increments (a more "live" shimmer) while staying well clear of Slack's
   * chat.appendStream rate limit. */
  static FLUSH_CHARS = 250;
  /** ...or when this much time has passed since the last flush. */
  static FLUSH_MS = 800;

  constructor(
    token: string,
    args: {
      channel: string;
      threadTs: string;
      recipientTeamId?: string;
      recipientUserId?: string;
      /** See `startGate`: delays the first chat.startStream until resolved. */
      startGate?: Promise<unknown>;
    },
  ) {
    this.token = token;
    this.channel = args.channel;
    this.threadTs = args.threadTs;
    this.recipientTeamId = args.recipientTeamId;
    this.recipientUserId = args.recipientUserId;
    this.startGate = args.startGate;
  }

  /** Open the stream NOW so Slack renders the reply container before any
   * model output exists. Safe to skip — doFlush lazily starts too. */
  async start(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.ensureStream().then(() => {}));
    await this.inFlight;
  }

  /**
   * Live progress: render/advance an entry in the message's task timeline
   * ("Thinking…", "Reading Kai's mastery ✓"). Serialized with text flushes;
   * silently no-ops when streaming is unavailable (the postMessage fallback
   * has no task surface). title/details capped per Slack (256 chars).
   */
  taskUpdate(args: {
    id: string;
    title: string;
    status: "pending" | "in_progress" | "complete" | "error";
    details?: string;
  }): void {
    this.inFlight = this.inFlight.then(async () => {
      if (this.streamingUnavailable) return;
      if (!(await this.ensureStream())) return;
      const res = await slackCall(this.token, "chat.appendStream", {
        channel: this.channel,
        ts: this.streamTs!,
        chunks: [
          {
            type: "task_update",
            id: args.id,
            title: args.title.slice(0, 256),
            status: args.status,
            ...(args.details ? { details: args.details.slice(0, 256) } : {}),
          },
        ],
      });
      // Non-fatal: a rejected task chunk must not kill the text stream.
      if (!res.ok) {
        console.error("Slack task_update rejected (continuing):", res.error);
      }
    });
  }

  append(text: string): void {
    this.fullText += text;
    this.buffer += text;
    const due =
      this.buffer.length >= SlackStreamer.FLUSH_CHARS ||
      Date.now() - this.lastFlush >= SlackStreamer.FLUSH_MS;
    if (due) {
      // Serialize flushes; appendStream chunks must arrive in order.
      this.inFlight = this.inFlight.then(() => this.doFlush());
    }
  }

  async flush(): Promise<void> {
    this.inFlight = this.inFlight.then(() => this.doFlush());
    await this.inFlight;
  }

  /** Start the stream if it isn't started; false = streaming unavailable. */
  private async ensureStream(): Promise<boolean> {
    if (this.streamTs) return true;
    if (this.streamingUnavailable) return false;
    // Hold for the ordering gate (e.g. a preceding context-block message)
    // before claiming this message's Slack ts. Never let a gate failure block.
    if (this.startGate) {
      try {
        await this.startGate;
      } catch {
        /* gate failure must not strand the reply */
      }
      this.startGate = undefined;
    }
    const res = await slackCall(this.token, "chat.startStream", {
      channel: this.channel,
      thread_ts: this.threadTs,
      ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
      ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
    });
    if (!res.ok || !res.ts) {
      this.streamingUnavailable = true;
      return false;
    }
    this.streamTs = res.ts as string;
    return true;
  }

  private async doFlush(): Promise<void> {
    if (!this.buffer || this.streamingUnavailable) return;
    const chunk = this.buffer;
    this.buffer = "";
    this.lastFlush = Date.now();

    if (!(await this.ensureStream())) {
      // Streaming not available — buffer everything for a postMessage.
      this.buffer = chunk + this.buffer;
      return;
    }

    const res = await slackCall(this.token, "chat.appendStream", {
      channel: this.channel,
      ts: this.streamTs!,
      markdown_text: chunk,
    });
    if (res.ok) this.sentAnything = true;
    else {
      this.streamingUnavailable = true;
      this.buffer = chunk + this.buffer;
    }
  }

  /**
   * Finalize. When streaming worked, stop the stream; when it never did,
   * post the whole accumulated reply as one message. `fallbackText`
   * replaces an empty reply so the user never gets silence.
   */
  async finish(fallbackText = "(no response)"): Promise<void> {
    await this.inFlight;
    // Retracted mid-turn (react_only) — discard() already stopped+deleted any
    // open message; do NOT resurrect it as a postMessage fallback.
    if (this.discarded) return;
    if (this.streamTs && !this.streamingUnavailable) {
      // Flush any tail buffer, then stop.
      if (this.buffer) {
        const tail = this.buffer;
        this.buffer = "";
        await slackCall(this.token, "chat.appendStream", {
          channel: this.channel,
          ts: this.streamTs,
          markdown_text: tail,
        });
      }
      await slackCall(this.token, "chat.stopStream", {
        channel: this.channel,
        ts: this.streamTs,
      });
      const finalText = this.fullText.trim() || fallbackText;
      const normalized = normalizeSlackMarkdown(finalText);
      if (normalized !== finalText) {
        await slackCall(this.token, "chat.update", {
          channel: this.channel,
          ts: this.streamTs,
          markdown_text: normalized,
        });
      }
      return;
    }
    // Fallback: single message.
    const text = this.fullText.trim() || fallbackText;
    this.buffer = "";
    await postMessage(this.token, {
      channel: this.channel,
      text,
      threadTs: this.threadTs,
      markdown: true,
    });
    this.sentAnything = true;
  }

  /**
   * Abandon this reply WITHOUT committing it, deleting any Slack message that
   * was already opened. Used when the model decides mid-turn to stay silent
   * (Slack's react_only affordance): the SDK runs a tool BETWEEN stream yields,
   * so a lead-in the model streamed BEFORE the react_only tool_use block has
   * already opened a streaming message via chat.startStream — finalizing it
   * would commit visible text that contradicts the "react only, no reply"
   * decision. This stops that stream and deletes the message so Slack shows
   * only the reaction. Best-effort and idempotent: a no-op when nothing was
   * rendered yet (streamTs null, or streaming fell back to a not-yet-sent
   * postMessage); never throws. After discard(), finish() is a no-op.
   */
  async discard(): Promise<void> {
    await this.inFlight.catch(() => {});
    this.discarded = true;
    this.buffer = "";
    this.fullText = "";
    const ts = this.streamTs;
    this.streamTs = null;
    if (!ts) return; // nothing was rendered in Slack yet
    // Stop the (possibly still-open) stream, then delete the message. Both are
    // best-effort — a retract failure must never surface to the caller — and
    // use the same `chat:write` scope the bot already streams with (no new
    // permission). chat.delete removes the bot's own message.
    await slackCall(this.token, "chat.stopStream", {
      channel: this.channel,
      ts,
    }).catch(() => {});
    await slackCall(this.token, "chat.delete", {
      channel: this.channel,
      ts,
    }).catch(() => {});
  }
}
