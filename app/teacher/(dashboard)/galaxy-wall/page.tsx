import { redirect } from "next/navigation";

// The entryway "wall" kiosk was retired: it re-rendered the Class Galaxy lens
// inside the same staff chrome, so it never worked as a chrome-free display.
// Keep old bookmarks working by redirecting to the galaxy lens, whose full
// screen button gives the takeover the wall was meant to provide.
export default function GalaxyWallRedirect() {
  redirect("/teacher/galaxy?lens=galaxy");
}
