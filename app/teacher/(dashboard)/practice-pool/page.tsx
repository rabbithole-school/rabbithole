import { redirect } from "next/navigation";

// The Math Skills studio lives at /teacher/math-skills — the route now matches
// the nav label. Keep /teacher/practice-pool working for bookmarks and older
// deep links, preserving the query string (?node, ?lens, ?scholar, ?domain,
// ?statuses) so a saved link lands on the same view.
export default async function PracticePoolRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) q.append(key, v);
    } else if (value !== undefined) {
      q.append(key, value);
    }
  }
  const query = q.toString();
  redirect(`/teacher/math-skills${query ? `?${query}` : ""}`);
}
