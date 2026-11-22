import type { MetadataRoute } from "next";
import { worksheetSkills } from "@/lib/mathWorksheets/catalog";
import { siteOrigin } from "@/lib/mathWorksheets/seo";

/**
 * /sitemap.xml. Lists the public pages a search engine should find: the home
 * page and the free math-worksheet maker (its hub and one page per skill).
 * Everything else in the app sits behind sign-in.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return [
    { url: `${origin}/`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${origin}/math-worksheets`, changeFrequency: "weekly", priority: 0.8 },
    ...worksheetSkills().map((s) => ({
      url: `${origin}/math-worksheets/${s.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
