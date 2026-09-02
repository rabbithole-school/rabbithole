/**
 * "Find an image" — web image search for the slides editor, backed by the
 * Brave Image Search API (design: review/slides-web-image-search-plan.html).
 *
 * Two client-facing actions:
 *  - `searchWebImages`: query → Brave (safesearch=strict) → thumbnail grid
 *    results. Thumbnails are Brave-proxied, so rendering the grid never lets a
 *    source site see the child's device.
 *  - `pickWebImage`: the tapped result → server-side download of the original
 *    (Brave's ~500px proxy rendition as fallback) → Convex storage →
 *    `slideAssets` registration with provenance → storage id back to the
 *    client, which inserts an ordinary image element — the same landing path
 *    "Make an image" uses.
 *
 * GUARDRAIL SEAM (deliberately empty): per Andy 2026-08-25, this PR ships NO
 * query guardrail and NO pick-time moderation — a separate guardrail-revamp
 * session layers its gate in here (between the rate-cap claim and the Brave
 * call in `searchWebImages`). Nothing deploys to students in the interim.
 * What this PR does keep: safesearch=strict, the per-scholar rate cap, and
 * provenance on every registered asset.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalQuery } from "./_generated/server";
import {
  braveImageSearch,
  downloadWithProxyFallback,
  IMAGE_SEARCH_WINDOW_MS,
  verifyPickToken,
} from "./lib/imageSearch";
import {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  type WebImageSearchResponse,
} from "../shared/slidesScene";

const MAX_SOURCE_URL_CHARS = 2048;

/** Server-side twin of shared WebImagePickResult, with a typed storage id. */
export type PickWebImageResult =
  | {
      status: "inserted";
      storageId: Id<"_storage">;
      width?: number;
      height?: number;
    }
  | { status: "error"; error: string };

/** Wire shape of one grid result (mirrors shared/slidesScene WebImageSearchResult). */
export const webImageResultValidator = v.object({
  resultId: v.string(),
  thumbnailUrl: v.string(),
  imageUrl: v.string(),
  proxyUrl: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  title: v.optional(v.string()),
  sourceHost: v.optional(v.string()),
  pickToken: v.string(),
});

/** Authorize a slide deck using the same artifact → owning-session rule as generation. */
export const slideImageSearchContext = internalQuery({
  args: {
    artifactId: v.id("artifacts"),
    uploaderId: v.id("users"),
  },
  returns: v.union(
    v.null(),
    v.object({
      sessionId: v.id("sessions"),
    }),
  ),
  handler: async (ctx, args): Promise<{ sessionId: Id<"sessions"> } | null> => {
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact || artifact.type !== "slides") return null;
    const session = await ctx.db.get(artifact.sessionId);
    if (!session || session.userId !== args.uploaderId) return null;
    return { sessionId: session._id };
  },
});

export const searchWebImages = action({
  args: {
    artifactId: v.id("artifacts"),
    query: v.string(),
  },
  returns: v.union(
    v.object({ status: v.literal("results"), results: v.array(webImageResultValidator) }),
    v.object({ status: v.literal("capped") }),
    v.object({ status: v.literal("unavailable") }),
    v.object({ status: v.literal("error"), error: v.string() }),
  ),
  handler: async (ctx, args): Promise<WebImageSearchResponse> => {
    const uploaderId = await getAuthUserId(ctx);
    if (!uploaderId) {
      return { status: "error", error: "Please sign in and try again." };
    }

    const query = args.query.trim();
    if (!query) {
      return { status: "error", error: "Type what you want to find." };
    }
    if (query.length > FIND_IMAGE_MAX_QUERY) {
      return {
        status: "error",
        error: `Please use ${FIND_IMAGE_MAX_QUERY} characters or fewer.`,
      };
    }

    const searchContext = await ctx.runQuery(
      internal.slidesImageSearch.slideImageSearchContext,
      { artifactId: args.artifactId, uploaderId },
    );
    if (!searchContext) {
      return {
        status: "error",
        error: "That slide deck isn't available to find an image.",
      };
    }

    // Check availability BEFORE claiming a rate slot, so a missing key or a dark
    // deployment doesn't burn one of the scholar's hourly searches.
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) return { status: "unavailable" };

    const allowance = await ctx.runMutation(
      internal.artifacts.claimSlideImageSearchAttempt,
      { uploaderId, since: Date.now() - IMAGE_SEARCH_WINDOW_MS },
    );
    if (!allowance.allowed) {
      return {
        status: "error",
        error: "Image search isn't available for your account.",
      };
    }
    if (!allowance.claimed) {
      return { status: "capped" };
    }

    // GUARDRAIL SEAM: the separate guardrail revamp inserts its query gate here.
    // Per Andy 2026-08-25, this PR deliberately ships no query or pick moderation.

    // Ask for more than we show so client-side shape filtering (any/square/
    // wide/tall, derived from each result's dimensions — Brave has no
    // server-side shape param) still has material for the rarer shapes.
    const outcome = await braveImageSearch(query, { count: 100 });
    if (outcome.status === "unavailable") return { status: "unavailable" };
    if (outcome.status === "error") {
      return { status: "error", error: FIND_IMAGE_COPY.errorFallback };
    }
    return { status: "results", results: outcome.results };
  },
});

export const pickWebImage = action({
  args: {
    artifactId: v.id("artifacts"),
    query: v.string(),
    image: webImageResultValidator,
  },
  returns: v.union(
    v.object({
      status: v.literal("inserted"),
      storageId: v.id("_storage"),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    }),
    v.object({ status: v.literal("error"), error: v.string() }),
  ),
  handler: async (ctx, args): Promise<PickWebImageResult> => {
    const uploaderId = await getAuthUserId(ctx);
    if (!uploaderId) {
      return { status: "error", error: "Please sign in and try again." };
    }

    const searchContext = await ctx.runQuery(
      internal.slidesImageSearch.slideImageSearchContext,
      { artifactId: args.artifactId, uploaderId },
    );
    if (!searchContext) {
      return {
        status: "error",
        error: "That slide deck isn't available to add an image.",
      };
    }

    // The URLs to fetch come ONLY from the signed token, never from the
    // client-supplied top-level fields — this is what stops pickWebImage being
    // an arbitrary-URL fetch proxy (SSRF). A tampered/expired token is refused.
    const sealed = await verifyPickToken(args.image.pickToken);
    if (!sealed) {
      return { status: "error", error: FIND_IMAGE_COPY.insertErrorFallback };
    }

    // Picks make the SERVER fetch a URL and write storage, so they carry the
    // same amplification risk as searches and share the same hourly budget —
    // an uncapped pick loop would be materially more abusable than uploads.
    const allowance = await ctx.runMutation(
      internal.artifacts.claimSlideImageSearchAttempt,
      { uploaderId, since: Date.now() - IMAGE_SEARCH_WINDOW_MS },
    );
    if (!allowance.allowed || !allowance.claimed) {
      return { status: "error", error: FIND_IMAGE_COPY.insertErrorFallback };
    }

    try {
      const blob = await downloadWithProxyFallback(
        sealed.imageUrl,
        sealed.proxyUrl,
      );
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.artifacts.registerWebSearchSlideAsset, {
        storageId,
        uploaderId,
        searchQuery: args.query.trim().slice(0, FIND_IMAGE_MAX_QUERY),
        sourceUrl: sealed.imageUrl.slice(0, MAX_SOURCE_URL_CHARS),
      });
      return {
        status: "inserted",
        storageId,
        width: args.image.width,
        height: args.image.height,
      };
    } catch (error) {
      console.error("[slides] web image insert failed:", error);
      return { status: "error", error: FIND_IMAGE_COPY.insertErrorFallback };
    }
  },
});
