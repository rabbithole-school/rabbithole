import { redirect } from "next/navigation";

/**
 * Retired: scholar-built apps live on the Apps page itself, mixed into All and
 * on their own By scholars tab (review/teacher-apps-scholar-rows-options.html,
 * Option 2). An old link lands on that tab with its scholar scope intact.
 */
export default async function ScholarBuiltAppsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (key !== "scope" && key !== "scholar") continue;
    if (typeof value === "string" && value) params.set(key, value);
  }
  params.set("tab", "scholar");
  redirect(`/teacher/apps?${params.toString()}`);
}
