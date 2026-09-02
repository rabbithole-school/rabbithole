/**
 * Charms — the world's artwork, from Rabbithole's existing generated-art
 * pipeline.
 *
 * The sandbox has no network by design, so it never resolves a charm itself.
 * The host looks each entity up with `useThemeIcon` (which warms a missing one)
 * and posts the URLs in over the bridge. Until then — and forever, if the art
 * never arrives — every entity draws as a vector. That is production's standing
 * rule: never block on art. A world that waits for a picture is a world a kid
 * is watching a spinner in.
 *
 * Swapping the skin is not decoration either. Same walls, same rules, same
 * program, different fiction — it is the demonstration that the puzzle and its
 * costume are separable, and it costs one tap.
 */

export interface Skin {
  id: string;
  label: string;
  /** The phrase the art pipeline conditions on. */
  setting: string;
  /** entity -> the thing to draw. Keys are the contract's four entities. */
  ents: { robot: string; treasure: string; wall: string; goal: string };
}

export const SKINS: Record<string, Skin> = {
  depot: {
    id: "depot",
    label: "delivery depot",
    setting: "a tidy little robot delivery depot",
    ents: {
      robot: "delivery robot",
      treasure: "treasure chest",
      wall: "stack of crates",
      goal: "landing pad",
    },
  },
  reef: {
    id: "reef",
    label: "coral reef",
    setting: "a sunny shallow coral reef",
    ents: {
      robot: "friendly yellow submarine",
      treasure: "treasure chest",
      wall: "chunk of brain coral",
      goal: "ship's anchor",
    },
  },
  bakery: {
    id: "bakery",
    label: "bakery",
    setting: "a cheerful bakery kitchen",
    ents: {
      robot: "wind-up cupcake robot",
      treasure: "birthday cake",
      wall: "sack of flour",
      goal: "oven",
    },
  },
};

export type Entity = keyof Skin["ents"];

/** The cache key the art pipeline already understands (`world:<setting>:<ent>`). */
export const charmKey = (skinId: string, ent: Entity): string =>
  `world:${SKINS[skinId].setting}:${SKINS[skinId].ents[ent]}`;

const images = new Map<string, HTMLImageElement | null>();
let urls: Record<string, string> = {};
let current = "depot";
let onArrive: (() => void) | null = null;

export const skinId = () => current;

export function setSkin(id: string) {
  if (SKINS[id]) current = id;
}

/** Called by the host when it has resolved this skin's art. */
export function setCharmUrls(next: Record<string, string>, redraw: () => void) {
  urls = { ...urls, ...next };
  onArrive = redraw;
  redraw();
}

/**
 * The loaded image for an entity, or `null` — and `null` is a completely normal
 * answer that the renderer is required to handle.
 */
export function charm(ent: Entity): HTMLImageElement | null {
  const key = charmKey(current, ent);
  const url = urls[key];
  if (!url) return null;

  if (!images.has(url)) {
    const img = new Image();
    img.onload = () => onArrive?.();
    img.onerror = () => images.set(url, null);
    img.src = url;
    images.set(url, img);
  }
  const img = images.get(url);
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}
