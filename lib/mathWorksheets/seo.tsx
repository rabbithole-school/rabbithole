/**
 * Search plumbing for the worksheet pages: the canonical origin and JSON-LD.
 */

import type { WorksheetSkill } from "./catalog";
import { gradeName } from "./catalog";
import type { SchoolCredit } from "./credit";
import { skillCopy } from "./descriptions";

/** Same origin rule as the root layout's metadataBase. */
export function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "https://rabbithole.school").replace(/\/+$/, "");
}

/** A JSON-LD <script>, with "<" escaped as Next's JSON-LD guide advises. */
export function jsonLdScript(data: unknown) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}

export function skillTitle(s: WorksheetSkill): string {
  const grade = s.grade === "K" ? "kindergarten" : `grade ${s.grade}`;
  return `${s.shortLabel} worksheet, ${grade}, with answer key`;
}

/**
 * The search snippet: the skill's plain-words gist, then what the page gives.
 * Stays under ~150 characters so search results show it whole.
 */
export function skillDescription(s: WorksheetSkill): string {
  const grade = s.grade === "K" ? "kindergarten" : `grade ${s.grade}`;
  const gist = skillCopy(s.skillKey)?.gist ?? `${s.shortLabel}.`;
  return `${gist} Free printable ${grade} worksheet with an answer key.`;
}

export function skillJsonLd(s: WorksheetSkill, origin: string, credit: SchoolCredit | null) {
  const url = `${origin}/math-worksheets/${s.slug}`;
  const resource: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LearningResource",
    name: skillTitle(s),
    description: skillDescription(s),
    url,
    learningResourceType: "Worksheet",
    educationalLevel: gradeName(s.grade),
    teaches: s.shortLabel,
    about: s.domainLabel,
    inLanguage: "en",
    isAccessibleForFree: true,
    audience: { "@type": "EducationalAudience", educationalRole: ["parent", "teacher"] },
    educationalAlignment: s.ccCodes.map((code) => ({
      "@type": "AlignmentObject",
      alignmentType: "teaches",
      educationalFramework: "Common Core State Standards for Mathematics",
      targetName: code,
    })),
    publisher: { "@type": "Organization", name: "Rabbithole", url: origin },
  };
  if (credit) {
    resource.creator = { "@type": "EducationalOrganization", name: credit.name, ...(credit.url ? { url: credit.url } : {}) };
  }
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Math worksheets", item: `${origin}/math-worksheets` },
      { "@type": "ListItem", position: 2, name: s.shortLabel, item: url },
    ],
  };
  return [resource, breadcrumbs];
}
