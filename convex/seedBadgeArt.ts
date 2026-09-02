"use node";

// Quest-badge art for the rich-cohort seed — the ONE-OFF generator + the
// per-seed attach step. Split from badges.ts / seedRichCohort.ts on purpose:
//
//  • `generate` calls the REAL Gemini image pipeline (buildBadgePrompt →
//    geminiGenerateImage → removeGreenScreen), downscales, and stores each
//    badge design once. It's a manual tool — run via the build script — never
//    part of a seed. Its output is baked into convex/seed/rich/badgeArtAssets.ts.
//
//  • `attach` runs during `pnpm db:seed:rich` (see scripts/db-seed.sh): it takes
//    the PRE-BAKED PNGs from badgeArtAssets.ts, uploads them into Convex storage,
//    and patches each seeded badge row (imageStorageId + artStatus "ready"). No
//    model call, cheap, idempotent — so re-seeding never triggers gen art.
//
// Both live here (a "use node" module) because generate runs the chroma-key +
// downscale pipeline (lib/chromaImage, which needs pngjs). The DB helpers they
// call (badges.seedBadgeRows / badges.setBadgeArt) live in badges.ts (V8
// runtime — actions can't hold queries/mutations).

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildBadgePrompt, isBadgeColorway, type BadgeColorway, type BadgeStyle } from "./lib/badgeArt";
import { geminiGenerateImage } from "./lib/gemini";
import { removeGreenScreen } from "./lib/chromaImage";
import { toStorageBlob, base64ToBytes } from "./lib/imageBytes";
import { recordImageUsage } from "./usage";
import { badges as seedBadges } from "./seed/rich/execution";
import { scholars as seedScholars } from "./seed/rich/roster";
import { BADGE_ART_ASSETS } from "./seed/rich/badgeArtAssets";

// Longest edge for the baked art. The largest on-screen badge is the detail
// dialog at 360px; 384 keeps it crisp while bounding the base64 bundle size.
const TARGET_PX = 384;

/**
 * ONE-OFF: render each distinct seed badge design through the real Gemini
 * pipeline, downscale, and store the transparent PNG. Returns { art, url } per
 * design so the build script can download + bake them into badgeArtAssets.ts.
 * Run via `node scripts/build-badge-art-assets.mjs` — NOT part of any seed.
 * Pass `only` (slugs) to re-roll just those designs (a bad chroma-key roll).
 */
export const generate = internalAction({
  args: { size: v.optional(v.number()), only: v.optional(v.array(v.string())) },
  handler: async (ctx, { size, only }) => {
    const target = size ?? TARGET_PX;
    const onlySet = only && only.length ? new Set(only) : null;
    const seen = new Set<string>();
    const results: { art: string; url: string; bytes: number }[] = [];
    for (const b of seedBadges) {
      if (!b.art || seen.has(b.art)) continue;
      if (onlySet && !onlySet.has(b.art)) continue;
      seen.add(b.art);
      const colorway: BadgeColorway =
        b.colorway && isBadgeColorway(b.colorway) ? b.colorway : "auto";
      const prompt = buildBadgePrompt({
        unitTitle: b.title,
        description: b.description ?? null,
        subject: null,
        style: (b.style ?? "patch") as BadgeStyle,
        colorway,
      });
      const image = await geminiGenerateImage([{ text: prompt }], {
        aspectRatio: "1:1",
      });
      if (!image) {
        throw new Error(`Gemini returned no image for badge art "${b.art}"`);
      }
      void recordImageUsage(ctx, { source: "badge-art", model: image.model });
      // Chroma-key the green screen to transparency and downscale to `target`
      // in one alpha-correct pass (lib/chromaImage).
      const small = removeGreenScreen(image.bytes, { maxDim: target });
      const storageId = await ctx.storage.store(toStorageBlob(small, "image/png"));
      const url = await ctx.storage.getUrl(storageId);
      if (!url) throw new Error(`No serving URL for stored badge art "${b.art}"`);
      results.push({ art: b.art, url, bytes: small.byteLength });
    }
    return results;
  },
});

/**
 * SEED STEP: attach the pre-baked PNGs (badgeArtAssets.ts) to the seeded badge
 * rows. Uploads each committed image into Convex storage and patches the
 * matching scholarUnitBadges row. Matched by (scholar username, snapshot title)
 * from the rich fixture. Idempotent — skips rows that already have art.
 * Wired into scripts/db-seed.sh under the rich cohort.
 */
export const attach = internalAction({
  args: {},
  handler: async (ctx): Promise<{ attached: number; skipped: number; missing: string[] }> => {
    const keyToUsername = new Map(seedScholars.map((s) => [s.key, s.username]));
    const rows = await ctx.runQuery(internal.badges.seedBadgeRows, {});
    const rowByKey = new Map(
      rows
        .filter((r) => r.scholarUsername)
        .map((r) => [`${r.scholarUsername}::${r.title}`, r]),
    );

    let attached = 0;
    let skipped = 0;
    const missing: string[] = [];
    for (const b of seedBadges) {
      if (!b.art) continue;
      const b64 = BADGE_ART_ASSETS[b.art];
      if (!b64) {
        missing.push(`asset:${b.art}`);
        continue;
      }
      const username = keyToUsername.get(b.scholarKey);
      const row = username ? rowByKey.get(`${username}::${b.title}`) : undefined;
      if (!row) {
        missing.push(`row:${b.scholarKey}/${b.title}`);
        continue;
      }
      if (row.hasImage) {
        skipped++;
        continue;
      }
      const storageId = await ctx.storage.store(
        toStorageBlob(base64ToBytes(b64), "image/png"),
      );
      await ctx.runMutation(internal.badges.setBadgeArt, {
        badgeId: row._id,
        imageStorageId: storageId,
      });
      attached++;
    }
    return { attached, skipped, missing };
  },
});
