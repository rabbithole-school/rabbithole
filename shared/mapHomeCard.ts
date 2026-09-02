/**
 * The scholar Home's ONE map card, as a state ladder.
 *
 * Andy, 2026-07-26: "I don't think we actually need the 'Something new — Math
 * Skills Tree' card, it's kinda redundant with the 'Math Skills Tree' card at
 * the bottom… feels like these are all 3 different flavors of the same thing."
 * He was right. Three surfaces used to render the same object (the scholar's
 * map), to the same destination, with near-identical CTAs:
 *
 *   - the once-ever reveal card ("SOMETHING NEW — Your Math Skills Tree is ready")
 *   - the persistent Frontier doorway at the bottom of the Math tab
 *   - the daily movement receipt ("Your map changed today")
 *
 * They are not one boolean — they run on three different CLOCKS (access,
 * institution-day movement, once-ever milestone) — but they ARE one signal, so
 * under `.claude/rules/rabbithole-product-taste.md` T1/T3 they get exactly ONE
 * canonical rendering whose state chooses its order, heading, tone, and CTA.
 * This module is that decision, framework-free so web and native can never
 * drift (scholar-facing parity is a standing rule). Design:
 * review/tree-signal-reconciliation-plan.html.
 *
 * Deliberately NOT here: pixels, and the per-frontend access instruction for a
 * gesture-accessed map (native says "pull down on this screen"; web says "tap
 * Your Map in the top corner") — the same sentence would be false on one of
 * them. What IS here is the *decision* each frontend must obey: which maps get
 * a CTA at all (`mapHomeAccess`).
 */

// ⚠️ The SKY's card is RETIRED (P5/d4, review/story-quest-rationalization-
// plan.html, 2026-08-12): no surface mounts `map="sky"` any more — the Quests
// tab's invitation family carries the "something new" moment, and /scholar/map
// + /sky still consume `revealPending` on first arrival. The sky arm below is
// kept only so the ladder stays total over MapKind until the dead-code
// follow-up strips it; do not re-mount a sky card.
export type MapKind = "sky" | "tree";

/**
 * The ladder, in priority order. Exactly one is true at a time, which is what
 * makes the elevated and quiet Home positions mutually exclusive by
 * construction rather than by two hand-kept conditions that can both fire.
 */
export type MapHomeState =
  | "hidden" // locked, or no data — render nothing. Never a locked teaser (f6).
  | "quiet" // the persistent doorway
  | "daily" // the map moved on the institution-local day
  | "unlock"; // the once-ever milestone reveal

/** Where a state renders in the Home column. */
export type MapHomeSlot = "elevated" | "quiet";

export interface MapHomeInput {
  map: MapKind;
  /** mapGates.mine → this map has real data and can be opened. */
  unlocked: boolean;
  /** mapGates.mine → the once-ever reveal has not been consumed on arrival. */
  revealPending: boolean;
  /**
   * dailyRecap.forScholar → durable movement on the institution-local day.
   *
   * `undefined` means NOT YET KNOWN (the query is still in flight), which is
   * NOT the same as "nothing moved" — see the second f6 note in
   * `resolveMapHomeState`. A map with no daily read model at all (the Sky)
   * reports a definite `false`: it will never move, so it never hides.
   */
  hasMovement: boolean | undefined;
  /**
   * The scholar is still INSIDE the welcome sequence (their Home onboarding pin
   * is non-null — it clears the moment the welcome unit is complete, and is
   * always null for an existing scholar who has no welcome unit). Defaults
   * false, so existing callers/tests are unchanged.
   *
   * A brand-new scholar accrues sky-unlock evidence DURING onboarding — the
   * observer plants seeds as they chat (convex/mapGates.ts), which unlocks the
   * Sky. Without this input the "Your Sky is ready" reveal fires mid-welcome,
   * before the scholar has even finished being welcomed. See
   * `resolveMapHomeState`: the reveal DEFERS until welcome is done.
   */
  welcomeActive?: boolean;
}

/**
 * Which states a map can reach. The Sky has no daily read model (there is no
 * "which stars changed today" query, and inventing one would be fiction) and —
 * Andy, 2026-07-26, on whether the Sky needs a quiet doorway too: "no let's
 * keep sky as is for this PR" — no quiet doorway either: its standing access
 * is the Quests-tab pull-down horizon, which is already an access primitive.
 * So the Sky reaches exactly one state, and shares the card grammar for it.
 */
const REACHABLE: Record<MapKind, ReadonlySet<MapHomeState>> = {
  sky: new Set<MapHomeState>(["unlock"]),
  tree: new Set<MapHomeState>(["quiet", "daily", "unlock"]),
};

export function resolveMapHomeState({
  map,
  unlocked,
  revealPending,
  hasMovement,
  welcomeActive = false,
}: MapHomeInput): MapHomeState {
  // "No surface before data" (f6): a locked map renders nothing at all.
  if (!unlocked) return "hidden";
  // The once-ever reveal DEFERS while the scholar is still in the welcome
  // sequence. A brand-new scholar's Sky unlocks mid-welcome (the observer
  // plants seeds as they chat — convex/mapGates.ts), so without this the "Your
  // Sky is ready" moment would greet them BEFORE they've finished being
  // welcomed. The design intent is: finish welcome → keep going → the reveal
  // greets them the next time they land home. Only the reveal waits; a map that
  // is already revealed (revealPending false) is unaffected.
  if (revealPending && welcomeActive) return "hidden";
  // The once-ever milestone outranks the day. When both are true the unlock
  // leads and the day's rows nest INSIDE it (see MAP_HOME_MOVEMENT_HEADING)
  // rather than becoming a second card. It does not wait on the day: the rows
  // are an addition INSIDE an already-placed card, not a change of slot.
  if (revealPending) return reachable(map, "unlock");
  // f6 again, for the second clock. "We don't know yet whether the map moved"
  // is not "it didn't": resolving an in-flight recap to `quiet` renders the
  // footer doorway, then swaps it for an elevated receipt one round-trip later
  // — every card below it jumps under the scholar's thumb. So hold the slot
  // empty until the day's answer is in.
  if (hasMovement === undefined) return "hidden";
  return reachable(map, hasMovement ? "daily" : "quiet");
}

/** A state this map cannot reach degrades to `hidden`, never to a neighbour. */
function reachable(map: MapKind, state: MapHomeState): MapHomeState {
  return REACHABLE[map].has(state) ? state : "hidden";
}

/**
 * The elevated slot carries anything time-bound (a milestone, or today's
 * movement); the quiet slot carries the standing doorway. `hidden` is in
 * neither, so a card asking "is this my slot?" is a single equality.
 */
export function mapHomeSlot(state: MapHomeState): MapHomeSlot | null {
  if (state === "unlock" || state === "daily") return "elevated";
  if (state === "quiet") return "quiet";
  return null;
}

/**
 * J10(b), as narrowed by Andy on 2026-07-26 ("agree, narrow J10(b)").
 *
 * The original ruling (2026-07-20) was "the reveal cards stop being 'press the
 * button to open the map' — they TEACH the access gesture." It was written when
 * the reveal was a THROWAWAY card sitting beside the real doorway; a button on
 * a card that disappears forever teaches nothing. That reasoning does not
 * survive the merge: the Tree card IS the persistent doorway now, so removing
 * its CTA in the unlock state would strip the access path from the one surface
 * that owns it, and the copy would have to point at itself.
 *
 * So: a map whose standing Home access is this card keeps its ordinary CTA in
 * every state, including the unlock. A map reached by a GESTURE keeps the
 * literal no-CTA instruction, because there is still no button to offer.
 *
 * Unchanged either way: a render is never an acknowledgement, and pressing the
 * CTA is not one either — the reveal is consumed on ARRIVAL at the map
 * (native/src/app/sky.tsx, app/scholar/map/page.tsx).
 */
export function mapHomeAccess(map: MapKind): "cta" | "gesture" {
  return map === "tree" ? "cta" : "gesture";
}

export interface MapHomeStateCopy {
  /** The section eyebrow, or null when the card is an ordinary sibling. */
  eyebrow: string | null;
  title: string;
  /** Supporting line. The daily state's body is its receipt rows instead. */
  body: string | null;
  /** Null when this map is gesture-accessed (see mapHomeAccess). */
  cta: string | null;
}

/**
 * SOMETHING NEW is reserved for the once-ever unlock; daily movement is TODAY.
 * (Andy, 2026-07-26: "should the daily movement heading stay TODAY?" → "yes".)
 * Routine-but-important and once-in-a-lifetime must not wear the same word, or
 * the word stops meaning anything.
 */
export const MAP_HOME_COPY: Record<
  MapKind,
  Partial<Record<MapHomeState, MapHomeStateCopy>>
> = {
  sky: {
    unlock: {
      eyebrow: "Something new",
      title: "Your Sky is ready",
      body: "The things you're curious about just became stars you can explore.",
      cta: null,
    },
  },
  tree: {
    unlock: {
      eyebrow: "Something new",
      title: "Your Math Skills Tree is ready",
      body: "This is where you're growing across math — every branch you reach lights up.",
      cta: "View your frontier",
    },
    daily: {
      eyebrow: "Today",
      title: "Your map changed today",
      body: null,
      cta: "See your map",
    },
    quiet: {
      // No eyebrow: the standing doorway is an ordinary sibling card, not a
      // section. A heading here would announce a category that never changes.
      eyebrow: null,
      title: "Your Math Skills Tree",
      body: "See where you're growing across math — your frontier is the next branch to reach.",
      cta: "View your frontier",
    },
  },
};

/**
 * Heads the day's rows when they nest inside the unlock card — the one place
 * two clocks share a card, so the rows must say which clock they are on.
 */
export const MAP_HOME_MOVEMENT_HEADING = "What changed today";

/** The copy for a resolved state, or null when nothing renders. */
export function mapHomeCopy(
  map: MapKind,
  state: MapHomeState,
): MapHomeStateCopy | null {
  return MAP_HOME_COPY[map][state] ?? null;
}
