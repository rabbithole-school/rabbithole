/**
 * TEMPORARY local mirror of `studio/src/charms.ts`'s skin data.
 *
 * That file lives under `studio/**`, which is out of scope for this screen
 * (owned by another agent building the in-WebView sandbox) and isn't reachable
 * from native code anyway — it's bundled into the self-contained HTML
 * document, not part of the RN/Metro module graph. The data is duplicated
 * here ONLY so the native host can compute the same charm cache keys the
 * sandbox looks artwork up by (`charm(ent)` reads
 * `urls[charmKey(currentSkin, ent)]`, see `studio/src/charms.ts`).
 *
 * There is no per-level or per-scholar skin selection anywhere in the shipped
 * contract yet (no `setSkin` bridge action exists), so this hardcodes
 * "depot" — matching the sandbox's own `let current = "depot"` default. That
 * means the host never has to pick a skin: whatever it resolves and sends
 * lines up with what the sandbox is already showing on first paint.
 *
 * INTEGRATOR: once a real per-level/skin mapping exists (in
 * `shared/studioLevels.ts` or `shared/studioContract.ts`), delete this file
 * and read skin data from there instead of keeping two copies in sync.
 */

export interface StudioSkin {
  id: string;
  label: string;
  setting: string;
  ents: {
    robot: string;
    treasure: string;
    wall: string;
    goal: string;
  };
}

export type StudioEntity = keyof StudioSkin["ents"];

export const STUDIO_SKINS: Record<string, StudioSkin> = {
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

/** Matches the sandbox's own default (`studio/src/charms.ts`: `let current = "depot"`). */
export const STUDIO_DEFAULT_SKIN_ID = "depot";

/**
 * Must match `studio/src/charms.ts`'s `charmKey` byte-for-byte — this IS the
 * cache key the sandbox reads generated artwork by.
 */
export function studioCharmKey(skinId: string, ent: StudioEntity): string {
  const skin = STUDIO_SKINS[skinId] ?? STUDIO_SKINS[STUDIO_DEFAULT_SKIN_ID];
  return `world:${skin.setting}:${skin.ents[ent]}`;
}
