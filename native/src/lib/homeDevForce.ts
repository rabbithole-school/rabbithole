/**
 * FORCE_ALL_HOME_CARDS — a dev-only spacing harness for the scholar Home.
 *
 * Almost every Home card self-gates to `null` on its own data (no reveal
 * pending, no recap today, no peer trails, …), so in any real account only a
 * handful of the slots are ever occupied at once — and a spacing bug between
 * two cards that never co-occur is invisible until a kid hits that exact state.
 * With this on, every self-gating Home card renders (with demo content where it
 * has no data), so the whole vertical rhythm can be read in one screenshot.
 *
 * Turn it on for a dev build only:  EXPO_PUBLIC_FORCE_ALL_HOME_CARDS=1
 * It is compiled out of production builds (`__DEV__`), and the demo content
 * behind it is unreachable when the flag is off.
 */
export const FORCE_ALL_HOME_CARDS =
  __DEV__ && process.env.EXPO_PUBLIC_FORCE_ALL_HOME_CARDS === "1";

/**
 * FORCE_MAP_HOME_STATE — pin the map card to one rung of its ladder.
 *
 * The map card's states are mutually EXCLUSIVE by construction (quiet doorway /
 * today's movement / the once-ever unlock — see shared/mapHomeCard.ts), so
 * unlike every other Home card it cannot be "all shown at once": doing that
 * would render a contradiction, which is the artifact the harness exists to
 * catch, not create. FORCE_ALL_HOME_CARDS therefore lands it on its richest
 * state (unlock, with the day's rows nested), and this knob walks the others:
 *
 *   EXPO_PUBLIC_FORCE_MAP_HOME_STATE=quiet | daily | unlock
 *
 * Dev builds only; compiled out of production.
 */
const FORCED_MAP_STATE_RAW =
  __DEV__ && process.env.EXPO_PUBLIC_FORCE_MAP_HOME_STATE;

export const FORCE_MAP_HOME_STATE: "quiet" | "daily" | "unlock" | null =
  FORCED_MAP_STATE_RAW === "quiet" ||
  FORCED_MAP_STATE_RAW === "daily" ||
  FORCED_MAP_STATE_RAW === "unlock"
    ? FORCED_MAP_STATE_RAW
    : null;

/**
 * Substitute demo rows for a list-shaped `useQuery` result that is still
 * loading or came back empty, so the section it feeds renders instead of
 * gating itself away. Returns the real data untouched whenever there is any,
 * and is a pure pass-through when the harness is off.
 *
 * The `demo` rows are deliberately typed `unknown[]`: they only need the
 * handful of fields the card actually reads, and spelling out a server return
 * type (branded Convex ids and all) just to draw a box would be noise in code
 * that never runs in production.
 */
export function forceList<T>(
  real: readonly T[] | undefined,
  demo: readonly unknown[],
): readonly T[] | undefined {
  if (!FORCE_ALL_HOME_CARDS) return real;
  if (real && real.length > 0) return real;
  return demo as readonly T[];
}
