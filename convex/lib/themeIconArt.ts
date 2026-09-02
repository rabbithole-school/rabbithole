// Generative manipulative theme-icon art — the prompt builder for the charm
// layer. A manipulative's `theme.fill.label` (a short noun) becomes a single,
// bold, flat cartoon object rendered on the SAME flat chroma-green screen as
// quest badges, so `removeGreenScreen` (lib/chromaImage.ts) can strip it to a
// transparent PNG. See convex/manipulativeThemeIconActions.ts.
//
// Distinct house style from badges on purpose: a badge is an ornate patch shown
// large; a FILL ICON is tiled small (~30–48px) inside a grid cell, so it must
// read as ONE bold silhouette with a flat interior and a clean edge — no fine
// detail, no scene, no ground shadow.

import { CHROMA_KEY_RGB } from "./badgeArt";

const CHROMA_BG = `a solid, perfectly flat, uniform chroma-key green screen background (pure green, RGB ${CHROMA_KEY_RGB.join(
  ", ",
)} / hex #00B140), with absolutely no gradient, no glow, no vignette, and NO drop shadow beneath the object — every pixel around the object must be that one identical green so the background can be removed cleanly`;
const FLAIR_CHROMA_BG = "#FF00FF";

/** Hard cap on a label so a stray long string can't blow up the prompt. */
export const MAX_THEME_LABEL_LEN = 60;

/**
 * The human SUBJECT noun for a cache label. Cache keys are namespaced so a
 * manipulative "fish" and a world species "fish" don't collide — e.g. the
 * workbench resolves species icons under `world:<template>:<species>`
 * (native/components `useSimulatorSpeciesIcon`). That namespace is a KEY, not a subject:
 * feeding the raw `world:ecosystemgrid:fish` to the image model made it draw a
 * puzzle-collage of "world / ecosystem / agent" bits instead of one fish. So we
 * take only the final `:`-segment as the drawable noun ("fish"); an un-namespaced
 * label ("pig") passes through unchanged.
 */
export function themeIconSubject(label: string): string {
  const trimmed = label.replace(/\s+/g, " ").trim();
  const lastSegment = trimmed.includes(":")
    ? trimmed.slice(trimmed.lastIndexOf(":") + 1).trim()
    : trimmed;
  return (lastSegment || trimmed).slice(0, MAX_THEME_LABEL_LEN);
}

/**
 * Build the generation prompt for a fill-icon label. The label's drawable noun
 * is embedded as the subject; every other clause forces the small-tile-legible
 * SPRITE style + single-subject guard + the wordless guard + the green screen.
 *
 * ── Two prompt shapes, keyed off the `world:` namespace ──────────────────────
 * A world SPECIES label (`world:<setting phrase>:<species>`, composed by the
 * workbench's `composeSpeciesIconLabel`) gets the CHARM CAMERA instead of the
 * flat face-on manipulative icon: a three-quarter isometric side view, facing
 * left, grounded, so the sprite sits at the center of an isometric terrain tile
 * (the tile library the ecosystem worlds render on). A plain manipulative label
 * (no prefix — "pig", "cauldron") is untouched: it takes the original face-on
 * icon branch, byte-for-byte.
 *
 * WHY branch here in the PIPELINE template, not in the cache key: the perspective
 * directive is a dozen words of style that would blow the 60-char
 * `MAX_THEME_LABEL_LEN` cap the moment it rode the composed key, silently
 * un-caching every species icon (the exact failure the cap comment documents).
 * The `world:` prefix is already on the key, so the template reads the intent
 * for free — species get the camera, manipulative keys stay stable, and no
 * caller changes. Existing cached species rows keep their art (cache hit);
 * fresh labels render with the camera.
 */
export function buildThemeIconPrompt(label: string): string {
  const world = parseSimulatorSpeciesLabel(label);
  if (world) return buildSpeciesSpritePrompt(world.settingPhrase, world.species);

  const subject = themeIconSubject(label);
  return [
    `A single ${subject}, drawn as a friendly, simple, flat cartoon icon for young children — designed to be used as a small game SPRITE / token.`,
    `EXACTLY ONE subject: one ${subject} and nothing else. Do NOT draw a collage, montage, grid, puzzle, pattern, scene, or multiple objects; no extra creatures, characters, or props alongside it; no frame or border around it.`,
    `Face-on and upright, centered, occupying about 80% of the square frame with an even margin on all sides — do not crop it or let it touch the edges.`,
    `Sprite level of detail: a bold clean silhouette with a single clear outline and flat, cheerful fill colors (just a few colors); chunky simple shapes with minimal interior detail so it reads clearly when rendered very small (about 32–64 pixels wide). Sticker / emoji / game-token feel, NOT a detailed illustration and NOT a scene.`,
    `No background scenery, no ground, no shadow, no reflection.`,
    `IMPORTANT: the image must contain NO text, NO letters, NO words, and NO numbers — it is a purely pictorial icon.`,
    `Render it on ${CHROMA_BG}.`,
  ].join(" ");
}

/**
 * Bold lineal-color flair art, optimized for the 36px earned-flair chip.
 * Flair needs a stronger outline and less detail than manipulative sprites so
 * every criterion remains recognizable when several chips sit side by side.
 */
export function buildFlairArtPrompt(
  label: string,
  description?: string,
): string {
  const subject =
    label.replace(/\s+/g, " ").trim().slice(0, 160) || "achievement";
  const context = description
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);

  return `Create ONE compact, cheerful lineal-color icon representing "${subject}"${
    context ? ` in this sense: "${context}"` : ""
  }.

This is earned FLAIR in a learning app. It must remain instantly recognizable at exactly 36 × 36 pixels.

STYLE — BOLD LINEAL COLOR:
- one connected, face-on subject centered in a square canvas
- uniform near-black #17171C outline, about 5% of the canvas width
- rounded line caps, joins, and corners
- flat fills chosen only from #FFC64D, #FF6B57, #5AA9F5, #7FD3E8, and #FFF6E9
- use 2–4 fill colors with strong contrast and large uninterrupted color areas
- use the fewest interior marks needed to identify the subject
- friendly and lively, but not babyish, glossy, painterly, or retro
- generous clear space around the silhouette; nothing may touch the canvas edge

STRICT COMPOSITION:
- silently translate the achievement into ONE concrete, familiar pictorial metaphor, then draw only that object
- exactly ONE icon, not a collection, scene, landscape, sticker sheet, badge, seal, or app tile
- NO words, letters, numerals, stars, sparkles, ribbons, detached decoration, gradients, shadows, gloss, texture, perspective, or photorealism
- draw only the subject; do not add a border around the canvas

BACKGROUND:
- completely flat, uniform chroma magenta ${FLAIR_CHROMA_BG}
- no shadow, glow, ground plane, texture, or color variation in the background
- preserve a clean hard edge between the outlined icon and the magenta screen

Final self-check: at 36px, a child should identify "${subject}" immediately from its silhouette and 1–3 bold interior cues.`;
}

/** The namespace prefix the workbench stamps on a species-icon cache label. */
const SIMULATOR_LABEL_PREFIX = "world:";

/**
 * Split a `world:<setting phrase>:<species>` label into its setting phrase and
 * drawable species noun, or return null for a plain (manipulative) label. The
 * species is the LAST `:`-segment (the same segment `themeIconSubject` draws);
 * everything between the prefix and it is the authored setting phrase that
 * steers the referent ("coral reef ecosystem" → a reef fish, not a cow). Both
 * are length-clamped so a pathological label can't blow up the prompt.
 */
export function parseSimulatorSpeciesLabel(
  label: string,
): { settingPhrase: string; species: string } | null {
  const trimmed = label.replace(/\s+/g, " ").trim();
  if (!trimmed.toLowerCase().startsWith(SIMULATOR_LABEL_PREFIX)) return null;
  const rest = trimmed.slice(SIMULATOR_LABEL_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  const species = (lastColon >= 0 ? rest.slice(lastColon + 1) : rest).trim();
  const settingPhrase = (lastColon >= 0 ? rest.slice(0, lastColon) : "").trim();
  if (!species) return null;
  return {
    settingPhrase: settingPhrase.slice(0, MAX_THEME_LABEL_LEN),
    species: species.slice(0, MAX_THEME_LABEL_LEN),
  };
}

/**
 * The CHARM CAMERA for world species sprites. Same green screen + single-subject
 * + wordless + small-tile-legible guards as the manipulative icon, but a
 * three-quarter isometric side view FACING LEFT, feet grounded at the bottom-
 * center so the sprite drops onto an isometric tile's center. The setting phrase
 * steers the creature's design (a grazer of a "coral reef ecosystem" is a fish)
 * WITHOUT ever being drawn as background — the sprite stays alone on green.
 */
export function buildSpeciesSpritePrompt(
  settingPhrase: string,
  species: string,
): string {
  const belongs = settingPhrase
    ? `, a creature or character that belongs in ${settingPhrase}`
    : "";
  const notBackground = settingPhrase
    ? ` (do NOT draw ${settingPhrase} as a background — only the ${species} itself)`
    : "";
  return [
    `A single ${species}${belongs}, drawn as a friendly, simple, flat cartoon game SPRITE / token for young children.`,
    `EXACTLY ONE subject: one ${species} and nothing else. Do NOT draw a collage, montage, grid, pattern, scene, or multiple objects; no extra creatures, characters, or props alongside it; no frame or border around it.`,
    `Pose it in a three-quarter side view seen from a slightly-raised ISOMETRIC camera that matches a 2:1 isometric game board, FACING LEFT, standing squarely on the ground with its feet / base resting at the bottom-center of the frame so it can sit at the center of an isometric tile.`,
    `Centered, occupying about 80% of the square frame with an even margin on all sides — do not crop it or let it touch the edges.`,
    `Sprite level of detail: a bold clean silhouette with a single clear outline and flat, cheerful fill colors (just a few colors); chunky simple shapes with minimal interior detail so it reads clearly when rendered very small (about 32–64 pixels wide). Sticker / emoji / game-token feel, NOT a detailed illustration.`,
    `No background scenery, no ground, no shadow, no reflection${notBackground}.`,
    `IMPORTANT: the image must contain NO text, NO letters, NO words, and NO numbers — it is a purely pictorial sprite.`,
    `Render it on ${CHROMA_BG}.`,
  ].join(" ");
}
