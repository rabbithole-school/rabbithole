"use node";

// The Friday screen-time roundup's charts, posted as one message of images in
// the roundup's thread. Scheduled by eodCheckin.runDaily once the roundup is
// in the channel. Best-effort: a failure costs the pictures, never the
// roundup. Its own action because resvg needs Node.

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  deliveryId,
  deliveryMetadata,
  EOD_MESSAGE_EVENT_TYPE,
} from "./lib/eodCheckin";
import {
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  postMessage,
  uploadFileToSlack,
} from "./lib/slackApi";
import { rasterizeChartSvg } from "./lib/chartRaster";
import { buildRoundupCharts } from "./lib/screenTimeRoundupCharts";

// Slack processes an upload for about two seconds before an image block may
// name it (the same wait the check-in's build screenshots use).
const POST_ATTEMPTS = 5;
const POST_WAIT_MS = 2_000;

export const postCharts = internalAction({
  args: {
    checkinId: v.id("eodCheckins"),
    channelId: v.string(),
    roundupTs: v.string(),
  },
  handler: async (ctx, { checkinId, channelId, roundupTs }) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return { posted: false, reason: "no Slack token" };
    try {
      const replies = await fetchConversationReplies(token, channelId, roundupTs);
      if (!replies.ok) {
        console.warn(
          `[EodCheckin] screen-time charts for ${checkinId}: thread read failed (${replies.error ?? "unknown error"}); posting none`,
        );
        return { posted: false, reason: "thread read failed" };
      }
      if (
        messageWithDeliveryMetadata(
          replies.messages,
          EOD_MESSAGE_EVENT_TYPE,
          deliveryId(checkinId, "screenTimeCharts"),
        )
      ) {
        return { posted: false, reason: "already posted" };
      }

      const week = await ctx.runQuery(internal.eodCheckin.screenTimeChartWeek, {
        checkinId,
      });
      if (!week || week.classes.length === 0) {
        return { posted: false, reason: "no class week" };
      }
      const rows = [];
      for (const dayKey of week.allDays) {
        rows.push(
          ...(await ctx.runQuery(internal.eodCheckin.screenTimeChartDay, {
            checkinId,
            dayKey,
          })),
        );
      }
      const charts = buildRoundupCharts({ ...week, rows });
      if (charts.length === 0) return { posted: false, reason: "nothing to draw" };

      const uploads: { fileId: string; title: string }[] = [];
      for (const chart of charts) {
        const png = await rasterizeChartSvg(chart.svg, chart.width);
        const uploaded = await uploadFileToSlack(token, {
          bytes: png,
          filename: `screen-time-${chart.name}.png`,
          mimeType: "image/png",
          title: chart.title,
        });
        if (uploaded.ok && uploaded.fileId) {
          uploads.push({ fileId: uploaded.fileId, title: chart.title });
        } else {
          console.warn(
            `[EodCheckin] screen-time chart ${chart.name} for ${checkinId} did not upload; skipping it`,
          );
        }
      }
      if (uploads.length === 0) return { posted: false, reason: "no uploads" };

      const blocks = uploads.map(({ fileId, title }) => ({
        type: "image",
        title: { type: "plain_text", text: title },
        slack_file: { id: fileId },
        alt_text: title,
      }));
      let error: string | undefined;
      for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, POST_WAIT_MS));
        const posted = await postMessage(token, {
          channel: channelId,
          threadTs: roundupTs,
          text: "Screen time charts",
          blocks,
          metadata: deliveryMetadata(checkinId, "screenTimeCharts"),
        });
        if (posted.ok) return { posted: true, images: uploads.length };
        error = posted.error;
        if (error !== "invalid_blocks") break;
      }
      console.warn(
        `[EodCheckin] screen-time charts for ${checkinId} did not post (${error ?? "unknown error"})`,
      );
      return { posted: false, reason: error ?? "post failed" };
    } catch (error: unknown) {
      console.warn(
        `[EodCheckin] screen-time charts for ${checkinId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { posted: false, reason: "error" };
    }
  },
});
