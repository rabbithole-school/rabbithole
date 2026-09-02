"use node";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const OEMBED_URL = "https://www.youtube.com/oembed";
const FETCH_TIMEOUT_MS = 5_000;

export type VideoHealthStatus = "alive" | "dead" | "unknown";

/**
 * PROBED AGAINST THE LIVE ENDPOINT (2026-08-07), because the obvious guess is
 * wrong: a well-formed-but-nonexistent 11-char id does NOT return 404 from
 * YouTube's oEmbed — it returns **400**. Classifying only 401/403/404 as dead
 * therefore made this whole job inert: an unresolvable clip came back "unknown",
 * nothing was ever marked, and the daily run would have reported clean forever
 * while a child saw a dead frame.
 *
 * 400 is included as dead, with one caveat handled by the caller: 400 is also
 * exactly what OUR OWN malformed request would produce. A single encoding bug
 * must not blank every clip at once, so `checkInstructionVideos` refuses to
 * write when an entire multi-video run comes back dead (see the circuit breaker
 * there). Verify already constrains videoId to 11 chars of [A-Za-z0-9_-], so a
 * 400 on a request we built from a verified id means the video, not the URL.
 */
export function classifyOEmbedResponse(status: number, body: unknown): VideoHealthStatus {
  if (status === 400 || status === 401 || status === 403 || status === 404) return "dead";
  if (
    status === 200 &&
    typeof body === "object" &&
    body !== null &&
    "html" in body &&
    typeof body.html === "string"
  ) {
    return "alive";
  }
  return "unknown";
}

async function checkVideo(videoId: string): Promise<VideoHealthStatus> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `${OEMBED_URL}?url=${encodeURIComponent(watchUrl)}&format=json`;

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let body: unknown;
    if (response.status === 200) {
      try {
        body = await response.json();
      } catch {
        return "unknown";
      }
    }
    return classifyOEmbedResponse(response.status, body);
  } catch {
    return "unknown";
  }
}

type VideoContentRow = {
  contentId: Id<"instructionContent">;
  videoIds: string[];
};

/**
 * Daily link-health sweep. Fetches are intentionally sequential: this is a
 * tiny editorial corpus, and avoiding a burst is kinder to YouTube's endpoint.
 */
export const checkInstructionVideos = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    rows: number;
    videos: number;
    alive: number;
    dead: number;
    unknown: number;
    skippedAllDead?: boolean;
  }> => {
    const rows: VideoContentRow[] = await ctx.runQuery(
      internal.instruction.listPassedVideoContent,
      {},
    );
    const uniqueVideoIds = [...new Set(rows.flatMap((row) => row.videoIds))];
    const statuses = new Map<string, VideoHealthStatus>();

    for (const videoId of uniqueVideoIds) {
      statuses.set(videoId, await checkVideo(videoId));
    }

    const results = [...statuses.values()];

    // CIRCUIT BREAKER. `400` counts as dead (see classifyOEmbedResponse), and a
    // 400 is also precisely what a malformed request from US would return — so
    // the signature of "we broke the request format" is indistinguishable from
    // "every clip died", except by scale. Khan removing their entire catalogue
    // overnight is vastly less likely than one encoding bug here, and the cost of
    // guessing wrong is asymmetric: guessing "dead" strips instructional content
    // from every scholar, while guessing "leave it" merely delays a fix by a day.
    // So when EVERY video in a multi-video run reads dead, write nothing and let
    // the next run (or a human) settle it.
    const deadCount = results.filter((status) => status === "dead").length;
    const allDead = uniqueVideoIds.length > 1 && deadCount === uniqueVideoIds.length;
    if (allDead) {
      console.error(
        `[instruction-video-health] refusing to write: all ${uniqueVideoIds.length} videos ` +
          `classified dead, which looks like a broken request rather than a dead corpus`,
      );
      return {
        rows: rows.length,
        videos: uniqueVideoIds.length,
        alive: 0,
        dead: deadCount,
        unknown: 0,
        skippedAllDead: true,
      };
    }

    const checkedAt = Date.now();
    for (const row of rows) {
      await ctx.runMutation(internal.instruction.recordVideoHealthResults, {
        contentId: row.contentId,
        checkedAt,
        results: row.videoIds.map((videoId) => ({
          videoId,
          status: statuses.get(videoId) ?? "unknown",
        })),
      });
    }

    return {
      rows: rows.length,
      videos: uniqueVideoIds.length,
      alive: results.filter((status) => status === "alive").length,
      dead: results.filter((status) => status === "dead").length,
      unknown: results.filter((status) => status === "unknown").length,
    };
  },
});
