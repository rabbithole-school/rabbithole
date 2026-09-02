/**
 * An External App's tile icon LOCATION, resolved once for every read that
 * hands an app to a scholar-facing surface.
 *
 * The catalog stores an icon two ways — an uploaded asset (`iconStorageId`)
 * or a staff-entered link (`iconUrl`) — and only the second one is a URL
 * already. Every reader therefore has to resolve the storage id, and until
 * this module four of them did it inline with the same five lines. That is
 * exactly the shape of drift that let `pushes.hydratePush` return the raw
 * `app.iconUrl` field: an app whose logo was UPLOADED drew its icon in the
 * launcher and fell through to the emoji/initial on the focus card beside it,
 * for the same app, on the same screen.
 *
 * Deciding it here means the icon a surface renders is a property of the app,
 * not of which query happened to fetch it. What to DRAW from the resolved
 * value stays in `shared/appTileMark.ts` — this module only answers "where do
 * the pixels live", never "which rung of the chain wins".
 *
 * (Not to be confused with `native/src/lib/externalAppIcon.ts`, which is the
 * iPad's renderer-side adapter for that shared chain.)
 */

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * The uploaded asset wins over the entered link: staff who upload a logo
 * after typing a URL expect the upload to be what shows. A storage id that no
 * longer resolves (the asset was deleted) falls back to the link rather than
 * blanking the tile — the same "keep going down the chain" reflex the mark
 * resolver applies to a URL that won't load.
 */
export async function resolveAppIconUrl(
  ctx: Pick<QueryCtx, "storage">,
  app: Pick<Doc<"externalApps">, "iconStorageId" | "iconUrl">,
): Promise<string | null> {
  if (app.iconStorageId) {
    const url = await ctx.storage.getUrl(app.iconStorageId);
    if (url) return url;
  }
  return app.iconUrl ?? null;
}
