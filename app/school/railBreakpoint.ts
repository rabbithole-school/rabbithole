import { useSyncExternalStore } from "react";

// Chakra's `lg` breakpoint (theme default: 1024px).
const WIDE_QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Whether the School rail sits beside the page (the splitter) or collapses to
 * a strip that opens the rail as a drawer over the page (the overlay form,
 * below lg). The server snapshot is `false` (no `window` there); on the
 * client the real media query answers from the first client render. The
 * School shell shows its pending state until the signed-in user loads, so
 * the hydration pass never paints the overlay form on a wide screen.
 */
export function useWideEnoughForRail(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

// Tailwind/Chakra `2xl` (96em = 1536px).
const XL2_QUERY = "(min-width: 96em)";

/**
 * Whether the School rail starts collapsed, decided once on mount by the
 * route the user lands on. It starts expanded everywhere except the dense
 * Admissions tables, which start collapsed below 2xl so the table gets the
 * width. Pure: the caller passes the 2xl media-query answer.
 */
export function schoolRailStartsCollapsed(
  pathname: string,
  isAtLeast2xl: boolean,
): boolean {
  const dense =
    pathname === "/school/admissions" ||
    pathname.startsWith("/school/admissions/");
  return dense && !isAtLeast2xl;
}

export function isAtLeast2xl(): boolean {
  return typeof window !== "undefined" && window.matchMedia(XL2_QUERY).matches;
}
