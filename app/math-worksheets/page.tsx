import type { Metadata } from "next";
import { SkillPicker } from "@/components/mathWorksheets/SkillPicker";
import { GRADE_ORDER, gradeName, worksheetDomains, worksheetSkills } from "@/lib/mathWorksheets/catalog";
import { jsonLdScript, siteOrigin } from "@/lib/mathWorksheets/seo";

/**
 * /math-worksheets: the hub. Server-rendered, so the full skill list is in
 * the HTML. URL words are the plain phrase people search ("math
 * worksheets"); each skill hangs under it at /math-worksheets/<skill words>.
 */

const TITLE = "Free math worksheets with answer keys, kindergarten to algebra 1";
const DESCRIPTION =
  "Printable math worksheets for 400 specific skills, kindergarten to algebra 1. Pick a skill and how many problems, print, and get an answer key with worked steps. Free, no sign-up.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/math-worksheets" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/math-worksheets", type: "website" },
  twitter: { title: TITLE, description: DESCRIPTION },
};

export default function MathWorksheetsHub() {
  const skills = worksheetSkills();
  const grades = GRADE_ORDER.filter((g) => skills.some((s) => s.grade === g)).map((g) => ({ grade: g, name: gradeName(g) }));
  const origin = siteOrigin();
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: TITLE,
      description: DESCRIPTION,
      url: `${origin}/math-worksheets`,
      isAccessibleForFree: true,
      inLanguage: "en",
      numberOfItems: skills.length,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [{ "@type": "ListItem", position: 1, name: "Math worksheets", item: `${origin}/math-worksheets` }],
    },
  ];

  return (
    <main>
      {jsonLdScript(jsonLd)}
      <div className="mw-surface">
        <h1 className="mw-h1">Free math worksheets with answer keys that show the steps</h1>
        <p className="mw-lede">
          Pick a skill, choose how many problems, and print. There are {skills.length} skills from kindergarten to algebra 1,
          each as specific as &ldquo;long division with a 2-digit divisor&rdquo;, so you can practice the exact thing your
          child is working on.
        </p>
        <p className="mw-p" style={{ marginTop: 10 }}>
          A computer works out every problem, so the answer key is right. Its worked steps stop one step short, which
          leaves the step that gives the answer to your child. &ldquo;New set&rdquo; gives you different numbers whenever
          you want them, and the link always reprints the same sheet.
        </p>
      </div>
      <div className="mw-surface">
        <SkillPicker
          skills={skills.map((s) => ({
            slug: s.slug,
            label: s.shortLabel,
            grade: s.grade,
            domain: s.domain,
            domainLabel: s.domainLabel,
          }))}
          grades={grades}
          domains={worksheetDomains()}
        />
      </div>
    </main>
  );
}
