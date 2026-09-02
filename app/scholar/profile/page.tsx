import { redirect } from "next/navigation";

/**
 * /scholar/profile is absorbed into /me ("My Learning") — one scholar
 * self-view. Badges (this page's unique content) now render there.
 * Kept as a redirect so old links and muscle memory keep working.
 */
export default function ScholarProfileRedirect() {
  redirect("/me");
}
