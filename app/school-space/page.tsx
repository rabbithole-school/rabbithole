import { redirect } from "next/navigation";

// Compatibility redirect. What staff knew as "School space" is now
// "Instructional materials", living inside the /school shell at
// /school/instructional-materials; staff bookmarked its old top-level URL, so keep it alive.
export default function SchoolSpaceRedirect() {
  redirect("/school/instructional-materials");
}
