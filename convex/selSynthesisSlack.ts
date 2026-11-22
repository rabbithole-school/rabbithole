/**
 * Weekly SEL write-ups, posted straight into each class's Slack channel.
 *
 * The write-ups used to sit behind a Rounds board link nobody opened (no
 * Rounds meeting was ever created on prod), while teachers DO read and act on
 * their class channel. So once an institution's weekly batch completes, each
 * linked group's channel gets a short summary message (who has strengths, who
 * has something to watch, who had a quiet week) with each scholar's write-up in
 * full as its own threaded reply — the text itself, not a pointer to it. A
 * single message carrying every write-up was too long to read and overflowed
 * Slack's message length.
 *
 * Routing reuses the class-channel opt-in (`scholarGroups.slackChannelId`, the
 * same link the daily EOD check-in uses): no linked channel, no post. Delivery
 * is at-most-once per (institution, week) — `claimSlackPost` stamps the run
 * BEFORE posting, so a crash mid-post drops a week's message rather than
 * duplicating it. A failed reply is logged, never retried on a later tick.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { scholarPath, scholarSlug, siteUrl, withBase } from "./lib/channels";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { postMessage } from "./lib/slackApi";
import { greyLineMessage, type SlackPart } from "./lib/slackGreyLine";
import { escapeSlackText } from "./lib/slackText";
import { scholarInstitutionId } from "./lib/scholarEnrollment";

type Claim = { text: string };

export type SelSlackScholar = {
  name: string;
  url: string;
  synthesis: { strengths: Claim[]; watch: Claim[]; quiet: boolean };
};

export type SelSlackChannelPost = {
  channel: string;
  groupNames: string[];
  scholars: SelSlackScholar[];
};

/** "Thu, Oct 29" in the school's own clock — the meeting the week closes at. */
export function selWeekEndingLabel(endMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(endMs);
}

/** A Slack message: Block Kit `blocks` plus the plain `text` fallback that
 *  notifications and screen readers use. */
export type SelSlackMessage = { text: string; blocks?: unknown[] };

const HTML_ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(quot|apos|lt|gt|amp));/gi;
const NAMED_ENTITY: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  amp: "&",
};

/** Model text can arrive HTML-escaped ("&#39;"); escaping that again for Slack
 *  would show the entity literally. Decode it once, in one pass, so "&amp;lt;"
 *  becomes "&lt;" rather than "<". */
function decodeHtmlEntities(text: string): string {
  return text.replace(HTML_ENTITY, (match, dec?: string, hex?: string, named?: string) => {
    if (named) return NAMED_ENTITY[named.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex!, 16);
    // Keep NUL, lone surrogates and out-of-range codes as written: decoded,
    // they would make Slack reject the message.
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

function hasWriteUp(scholar: SelSlackScholar): boolean {
  const { strengths, watch, quiet } = scholar.synthesis;
  return !quiet && (strengths.length > 0 || watch.length > 0);
}

function scholarLink(scholar: SelSlackScholar): string {
  return `<${scholar.url}|${escapeSlackText(scholar.name)}>`;
}

/** "5 scholars: 3 with write-ups, 2 quiet." — reworded at the edges so it
 *  never says "0 with write-ups" or "1 with write-ups". */
function selSummaryCounts(written: number, quiet: number): string {
  const total = written + quiet;
  const scholars = `${total} ${total === 1 ? "scholar" : "scholars"}`;
  if (written === 0) return total === 1 ? "1 scholar, quiet this week." : `${scholars}, all quiet this week.`;
  const writeUps = written === 1 ? "1 with a write-up" : `${written} with write-ups`;
  if (quiet === 0) return total === 1 ? "1 scholar with a write-up." : `${scholars}, all with write-ups.`;
  return `${scholars}: ${writeUps}, ${quiet} quiet.`;
}

/**
 * The top-level post: a few lines a teacher can scan — who showed strengths,
 * who has something to watch, who had a quiet week — pointing at the thread
 * where each write-up lives (`selSynthesisSlackReplies`).
 */
export function selSynthesisSlackSummary(args: {
  groupNames: string[];
  weekEndingLabel: string;
  scholars: SelSlackScholar[];
}): SelSlackMessage {
  const written = args.scholars.filter(hasWriteUp);
  const quiet = args.scholars.filter((scholar) => !hasWriteUp(scholar));
  const names = (scholars: SelSlackScholar[]) => scholars.map(scholarLink).join(", ");
  const withStrengths = written.filter((s) => s.synthesis.strengths.length > 0);
  const withWatch = written.filter((s) => s.synthesis.watch.length > 0);

  const lines = [
    `:seedling: *SEL write-ups — ${escapeSlackText(args.groupNames.join(" & "))} · week ending ${args.weekEndingLabel}*`,
    selSummaryCounts(written.length, quiet.length),
  ];
  if (withStrengths.length > 0) lines.push(`*Strengths:* ${names(withStrengths)}`);
  if (withWatch.length > 0) lines.push(`*Watch:* ${names(withWatch)}`);
  if (quiet.length > 0) lines.push(`*Quiet week:* ${names(quiet)}`);
  const parts: SlackPart[] = [lines.join("\n")];
  // Where the write-ups are is an aside, so it sits in the grey context line.
  if (written.length > 0) parts.push({ grey: "_Each write-up is in the thread, strengths first ↓_" });
  return greyLineMessage(parts, { markdown: false });
}

type RichTextElement =
  | { type: "text"; text: string; style?: { bold: true } }
  | { type: "link"; url: string; text: string; style: { bold: true } };

function richSection(elements: RichTextElement[]) {
  return { type: "rich_text_section", elements };
}

/**
 * One threaded reply per scholar with a write-up (quiet scholars are named in
 * the summary and get none). The blocks are a `rich_text` block — the scholar's
 * name, then bold "Strengths" / "Watch" sub-headings over real bullet lists.
 * Rich-text elements are literal text, so claims go in unescaped; only the
 * mrkdwn fallback is escaped for Slack.
 */
export function selSynthesisSlackReplies(scholars: SelSlackScholar[]): SelSlackMessage[] {
  return scholars.filter(hasWriteUp).map((scholar) => {
    const textLines = [`*${scholarLink(scholar)}*`];
    const elements: unknown[] = [
      richSection([
        { type: "link", url: scholar.url, text: scholar.name, style: { bold: true } },
      ]),
    ];
    const group = (heading: string, claims: Claim[]) => {
      if (claims.length === 0) return;
      const items = claims.map((claim) => decodeHtmlEntities(claim.text));
      textLines.push(`*${heading}*`, ...items.map((item) => `• ${escapeSlackText(item)}`));
      elements.push(
        richSection([{ type: "text", text: `\n${heading}`, style: { bold: true } }]),
        {
          type: "rich_text_list",
          style: "bullet",
          indent: 0,
          elements: items.map((item) => richSection([{ type: "text", text: item }])),
        },
      );
    };
    group("Strengths", scholar.synthesis.strengths);
    group("Watch", scholar.synthesis.watch);
    return { text: textLines.join("\n"), blocks: [{ type: "rich_text", elements }] };
  });
}

/** chat.postMessage allows about one message per second per channel. */
export const REPLY_SPACING_MS = 1_100;
/** Total time one channel's replies may spend waiting out `ratelimited`
 *  answers. They run in their own action (10-minute limit), so a full class
 *  paced at REPLY_SPACING_MS plus this budget stays well under it. */
export const RATE_LIMIT_BUDGET_MS = 90_000;

export type ReplyClock = {
  sleep: (ms: number) => Promise<void>;
  /** Rate-limit waiting still allowed; spent as replies wait. */
  rateLimitBudgetMs: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Post a thread's replies in order, about one per second, as Slack's
 * per-channel limit asks. A `ratelimited` reply is retried after Slack's
 * Retry-After for as long as the shared budget lasts; only a reply that still
 * fails is logged. Returns how many replies failed.
 */
export async function postThreadReplies(
  replies: SelSlackMessage[],
  send: (
    reply: SelSlackMessage,
  ) => Promise<{ ok: boolean; error?: string; retryAfterMs?: number }>,
  clock: ReplyClock,
): Promise<number> {
  let failed = 0;
  for (const [index, reply] of replies.entries()) {
    if (index > 0) await clock.sleep(REPLY_SPACING_MS);
    let result = await send(reply);
    while (result.error === "ratelimited") {
      const waitMs = Math.max(result.retryAfterMs ?? 0, REPLY_SPACING_MS);
      if (waitMs > clock.rateLimitBudgetMs) break;
      clock.rateLimitBudgetMs -= waitMs;
      await clock.sleep(waitMs);
      result = await send(reply);
    }
    if (!result.ok) {
      failed += 1;
      console.error("[SelSynthesisSlack] thread reply failed:", result.error);
    }
  }
  return failed;
}

/** Take the week's post, only once its batch has completed. */
export const claimSlackPost = internalMutation({
  args: { institutionId: v.id("institutions"), weekKey: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("selSynthesisRuns")
      .withIndex("by_institution_week", (q) =>
        q.eq("institutionId", args.institutionId).eq("weekKey", args.weekKey),
      )
      .unique();
    if (!run || run.completedAt === undefined || run.slackClaimedAt !== undefined) {
      return false;
    }
    await ctx.db.patch(run._id, { slackClaimedAt: Date.now() });
    return true;
  },
});

/** One post per linked channel: that channel's groups' scholars who belong to
 *  this institution and have a write-up for the week, sorted by name. */
export const channelPosts = internalQuery({
  args: { institutionId: v.id("institutions"), weekKey: v.string() },
  handler: async (ctx, args): Promise<SelSlackChannelPost[]> => {
    const groups = (await ctx.db.query("scholarGroups").collect()).filter(
      (group): group is Doc<"scholarGroups"> & { slackChannelId: string } =>
        group.institutionId === args.institutionId && Boolean(group.slackChannelId),
    );
    const base = siteUrl();
    type ChannelEntry = {
      groupNames: string[];
      scholars: Map<Id<"users">, SelSlackScholar>;
    };
    const byChannel = new Map<string, ChannelEntry>();
    for (const group of groups) {
      const entry: ChannelEntry = byChannel.get(group.slackChannelId) ?? {
        groupNames: [],
        scholars: new Map(),
      };
      entry.groupNames.push(group.name);
      for (const scholarId of group.scholarIds) {
        if (entry.scholars.has(scholarId)) continue;
        // A group can hold a scholar from another school; never post their
        // write-up into this institution's channel.
        if ((await scholarInstitutionId(ctx, scholarId)) !== args.institutionId) {
          continue;
        }
        const synthesis = await ctx.db
          .query("selSyntheses")
          .withIndex("by_scholar_week", (q) =>
            q.eq("scholarId", scholarId).eq("weekKey", args.weekKey),
          )
          .unique();
        const scholar = await ctx.db.get(scholarId);
        if (!synthesis || !scholar || synthesis.institutionId !== args.institutionId) {
          continue;
        }
        entry.scholars.set(scholarId, {
          name: scholar.name?.trim() || scholar.username || "Scholar",
          url: withBase(base, scholarPath(scholarSlug(scholar.username, scholar._id))),
          synthesis: {
            strengths: synthesis.strengths,
            watch: synthesis.watch,
            quiet: synthesis.quiet,
          },
        });
      }
      byChannel.set(group.slackChannelId, entry);
    }
    return [...byChannel.entries()]
      .map(([channel, entry]) => ({
        channel,
        groupNames: entry.groupNames,
        scholars: [...entry.scholars.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      }))
      .filter((post) => post.scholars.length > 0);
  },
});

export const institutionTimeZone = internalQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) =>
    effectiveInstitutionTimeZone((await ctx.db.get(args.institutionId))?.timeZone),
});

export const postForWeek = internalAction({
  args: {
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    window: v.object({ startMs: v.number(), endMs: v.number() }),
  },
  handler: async (ctx, args): Promise<{ posted: number }> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      console.log("[SelSynthesisSlack] no SLACK_BOT_TOKEN — skipping");
      return { posted: 0 };
    }
    const claimed = await ctx.runMutation(internal.selSynthesisSlack.claimSlackPost, {
      institutionId: args.institutionId,
      weekKey: args.weekKey,
    });
    if (!claimed) return { posted: 0 };

    const [posts, timeZone] = await Promise.all([
      ctx.runQuery(internal.selSynthesisSlack.channelPosts, {
        institutionId: args.institutionId,
        weekKey: args.weekKey,
      }),
      ctx.runQuery(internal.selSynthesisSlack.institutionTimeZone, {
        institutionId: args.institutionId,
      }),
    ]);
    const weekEndingLabel = selWeekEndingLabel(args.window.endMs, timeZone);
    let posted = 0;
    for (const post of posts) {
      const summary = await postMessage(token, {
        channel: post.channel,
        ...selSynthesisSlackSummary({ ...post, weekEndingLabel }),
      });
      if (!summary.ok || !summary.ts) {
        console.error(`[SelSynthesisSlack] post to ${post.channel} failed:`, summary.error);
        continue;
      }
      posted += 1;
      // The paced replies run in their own action so their waiting never
      // counts against the hourly dispatcher, which runs every institution's
      // generation and post inside one 10-minute action.
      await ctx.scheduler.runAfter(0, internal.selSynthesisSlack.postThreadRepliesForChannel, {
        institutionId: args.institutionId,
        weekKey: args.weekKey,
        channel: post.channel,
        threadTs: summary.ts,
      });
    }
    return { posted };
  },
});

/** One channel's threaded write-ups, under the summary `postForWeek` posted.
 *  Rebuilds the replies from the same query rather than carrying blocks in
 *  the scheduled args. */
export const postThreadRepliesForChannel = internalAction({
  args: {
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    channel: v.string(),
    threadTs: v.string(),
  },
  handler: async (ctx, args): Promise<{ failed: number }> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return { failed: 0 };
    const posts = await ctx.runQuery(internal.selSynthesisSlack.channelPosts, {
      institutionId: args.institutionId,
      weekKey: args.weekKey,
    });
    const post = posts.find((candidate) => candidate.channel === args.channel);
    if (!post) return { failed: 0 };
    const failed = await postThreadReplies(
      selSynthesisSlackReplies(post.scholars),
      (reply) => postMessage(token, { channel: args.channel, threadTs: args.threadTs, ...reply }),
      { sleep, rateLimitBudgetMs: RATE_LIMIT_BUDGET_MS },
    );
    return { failed };
  },
});
