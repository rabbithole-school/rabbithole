import { redirect } from "next/navigation";

// The standalone Skills map page was retired; the scholar's single
// Sky ⟷ Tree star map now lives at /scholar/map (reached from the
// "Your Map" title-bar link). Redirect any old bookmarks there.
export default function SkillsPage() {
  redirect("/scholar/map");
}
