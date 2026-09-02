// Generative quest-badge art — the shared style/colorway catalog + prompt
// builder. See review/quest-badge-art-plan.md and the design exploration.
//
// A badge is the artifact of finishing a STRUCTURED quest (a unit with
// activities + a deliverable). When a unit's `badgeOnCompletion` fires, we
// auto-generate topic-true artwork via the Gemini image model — the same SOP
// the tutor's `generate_image` tool uses. The kid can then remix it a tightly
// capped number of times (preset style + color only, never a free-text
// prompt) so customization can't become a distraction.

/** Default house style — the NASA-style embroidered mission patch. */
export const DEFAULT_BADGE_STYLE = "patch" as const;

// The image model can't emit a true alpha channel (gemini-3-pro-image-preview /
// "Nano Banana Pro" returns a solid or a *painted* checkerboard — see
// convex/lib/badgeChroma.ts). So we render every badge on a FLAT chroma-key
// green screen and strip it server-side. This is the target key color; the
// remover samples the actual corner pixels too, so slight model variance is OK.
export const CHROMA_KEY_RGB: readonly [number, number, number] = [0, 177, 64]; // #00B140
const CHROMA_BG = `a solid, perfectly flat, uniform chroma-key green screen background (pure green, RGB ${CHROMA_KEY_RGB.join(", ")} / hex #00B140), with absolutely no gradient, no glow, no vignette, and NO drop shadow beneath the badge — every pixel surrounding the badge must be that one identical green so the background can be removed cleanly`;

/** Default colorway — let the model pick a palette that suits the subject. */
export const DEFAULT_BADGE_COLORWAY = "auto" as const;

/**
 * Hard cap on remixes per badge (anti-distraction). The auto-mint is "free";
 * after this many scholar-initiated regenerations the badge freezes.
 */
export const MAX_BADGE_REROLLS = 1;

export type BadgeStyle = "patch" | "medallion";
export type BadgeColorway = "auto" | "gold" | "violet" | "mint" | "crimson";

export const BADGE_STYLES: Record<
  BadgeStyle,
  { label: string; blurb: string }
> = {
  patch: {
    label: "Mission Patch",
    blurb: "Embroidered crew patch — like a NASA expedition badge.",
  },
  medallion: {
    label: "Medallion",
    blurb: "Shiny metal award medal that catches the light.",
  },
};

export const BADGE_COLORWAYS: Record<
  BadgeColorway,
  { label: string; swatch: [string, string]; palette: string | null }
> = {
  auto: {
    label: "Surprise me",
    swatch: ["#7c8bd6", "#3a4a8c"],
    palette: null, // let the model choose a palette that fits the subject
  },
  gold: {
    label: "Gold",
    swatch: ["#f6c869", "#b07b1e"],
    palette: "a warm classic gold and bronze palette",
  },
  violet: {
    label: "Cosmic",
    swatch: ["#c07bff", "#7a2ad6"],
    palette: "a cosmic violet and magenta palette",
  },
  mint: {
    label: "Mint",
    swatch: ["#7af0d0", "#23a7a0"],
    palette: "a mint teal and aqua palette",
  },
  crimson: {
    label: "Crimson",
    swatch: ["#ff7a8a", "#c41f3a"],
    palette: "a crimson red and rose-gold palette",
  },
};

export function isBadgeStyle(v: string): v is BadgeStyle {
  return v in BADGE_STYLES;
}
export function isBadgeColorway(v: string): v is BadgeColorway {
  return v in BADGE_COLORWAYS;
}

/**
 * Build the text-to-image prompt for a badge. Pure + deterministic so it can be
 * unit-tested without the network. The subject scene is left to the model
 * (derived from title/description) so the art is genuinely topic-true.
 *
 * Badges are WORDLESS visual emblems by design — image models render text
 * unreliably (garbled banners, misspellings), so the title/label is rendered
 * as real HTML next to the badge (celebration, Trophy Case, profile) instead.
 */
export function buildBadgePrompt(args: {
  unitTitle: string;
  description?: string | null;
  subject?: string | null;
  style: BadgeStyle;
  colorway: BadgeColorway;
}): string {
  const { unitTitle, description, subject, style, colorway } = args;
  const palette = BADGE_COLORWAYS[colorway].palette ?? "colors that suit the subject";

  const subjectClause = subject ? ` (a ${subject} quest)` : "";
  const descClause = description
    ? ` Draw on this description for the imagery: ${description.replace(/\s+/g, " ").trim().slice(0, 200)}.`
    : "";
  const scene = `iconography that visually represents the theme of "${unitTitle}"${subjectClause}${descClause}`;

  // Wordless guard — image models can't spell, so forbid all lettering and
  // let the HTML caption carry the title.
  const noText = `IMPORTANT: the image must contain NO text, NO letters, NO words, NO numbers, and NO banner or ribbon with writing — it is a purely visual, wordless emblem. Use only pictorial symbols and shapes.`;

  // Framing guard — the model otherwise frames the badge like an angled
  // product photo that bleeds off the canvas (cropping the badge). Force the
  // COMPLETE badge, face-on, centered, well inside the frame.
  const framing = (background: string) =>
    `The complete badge must be shown in full — face-on (flat, top-down, not at an angle or in perspective), upright, and perfectly centered on ${background}. The whole badge fits well within the square frame, occupying about 75% of it with an even empty margin on all four sides; do NOT crop it or let any part of the badge touch or extend past the edges of the image. A single badge object only.`;

  if (style === "medallion") {
    return [
      `A glossy 3D metallic achievement medallion in the Apple Fitness award style, celebrating a student who completed a learning quest.`,
      `A polished reflective metal disc with concentric raised rings and a soft specular highlight.`,
      `Embossed in the center, filling the disc: ${scene}, rendered as sleek minimal metallic relief.`,
      `${palette[0].toUpperCase()}${palette.slice(1)} anodized metallic finish, shiny, premium, award-trophy feel.`,
      noText,
      framing(CHROMA_BG),
    ].join(" ");
  }

  // Default: NASA-style embroidered mission patch.
  return [
    `A circular NASA-style embroidered mission patch celebrating a student who completed a learning quest.`,
    `Embroidered cloth texture with a merrowed stitched border.`,
    `Central design, filling the patch: ${scene}, set against a deep navy starfield with a thin orbital arc and a few small stars.`,
    `Retro 1970s space-program aesthetic with ${palette}, clean flat embroidery and soft realistic stitch shading.`,
    noText,
    framing(CHROMA_BG),
  ].join(" ");
}
