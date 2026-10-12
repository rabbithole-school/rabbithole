// Serving URLs for the media on a slide deck, scoped to that deck.
//
// A storage id is not authorization: `_storage` is one namespace shared with
// health documents and portfolio scans. Each deck surface authorizes its parent
// (the artifact's session, or the activity's edit access) and then resolves
// only ids the deck actually holds, plus ids the caller registered as slide
// media themselves — a picture just added renders before the deck write lands.
// Anything else comes back with a null url (TRA-389).

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { parsedPresentationDeck } from "./activityPresentationResources";
import type { Deck } from "../../shared/slidesScene";

export function deckAssetIds(deck: Deck | null): Set<string> {
  const ids = new Set<string>();
  for (const slide of deck?.slides ?? []) {
    for (const element of Object.values(slide.elements)) {
      if (element.type === "image" || element.type === "video") {
        ids.add(element.assetId);
      }
    }
  }
  return ids;
}

/** Parse stored deck JSON; null when it is missing or invalid. */
export function storedDeck(raw: string | undefined): Deck | null {
  return parsedPresentationDeck(raw);
}

/**
 * Every media asset in the resulting deck must be registered to `ownerId`.
 * Checking the validated deck (rather than the ops/payload that produced it)
 * covers whole-deck creates, addElement, and addSlide restoration without
 * duplicating the slide-operation grammar.
 *
 * `skipIds`, when given, exempts asset ids already present before this edit —
 * so re-saving a deck never re-checks ownership of media it already held
 * (which may legitimately have been uploaded by another staffer in an
 * earlier version); only newly introduced ids are checked.
 */
export async function rejectForeignAssets(
  ctx: Pick<MutationCtx, "db">,
  deck: Deck,
  ownerId: Id<"users">,
  skipIds?: ReadonlySet<string>,
): Promise<string | null> {
  const assetIds = deckAssetIds(deck);
  for (const assetId of assetIds) {
    if (skipIds?.has(assetId)) continue;
    const row = await ctx.db
      .query("slideAssets")
      .withIndex("by_storage", (q) => q.eq("storageId", assetId as Id<"_storage">))
      .first();
    if (!row || row.uploaderId !== ownerId) {
      return "That media isn't available to this deck.";
    }
  }
  return null;
}

export async function resolveDeckAssetUrls(
  ctx: Pick<QueryCtx, "db" | "storage">,
  args: {
    storageIds: Id<"_storage">[];
    deck: Deck | null;
    callerId: Id<"users">;
  },
): Promise<{ storageId: Id<"_storage">; url: string | null }[]> {
  const inDeck = deckAssetIds(args.deck);
  // Deduplicate: the same image may appear on several slides.
  const unique = Array.from(new Set(args.storageIds));
  return await Promise.all(
    unique.map(async (storageId) => {
      let allowed = inDeck.has(storageId);
      if (!allowed) {
        const registered = await ctx.db
          .query("slideAssets")
          .withIndex("by_storage", (q) => q.eq("storageId", storageId))
          .first();
        allowed = registered?.uploaderId === args.callerId;
      }
      return {
        storageId,
        url: allowed ? await ctx.storage.getUrl(storageId) : null,
      };
    }),
  );
}
