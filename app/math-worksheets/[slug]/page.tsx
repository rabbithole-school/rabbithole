import Link from "next/link";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { WorksheetMaker } from "@/components/mathWorksheets/WorksheetMaker";
import {
  frozenSlugWithoutPage,
  gradeName,
  graphSkill,
  mixCandidates,
  skillByKey,
  skillBySlug,
  type WorksheetSkill,
} from "@/lib/mathWorksheets/catalog";
import { schoolCredit } from "@/lib/mathWorksheets/credit";
import { skillCopy } from "@/lib/mathWorksheets/descriptions";
import { sheetQuery } from "@/lib/mathWorksheets/params";
import { jsonLdScript, siteOrigin, skillDescription, skillJsonLd, skillTitle } from "@/lib/mathWorksheets/seo";
import { buildSheet, parseSheetParams } from "@/lib/mathWorksheets/sheet";

/**
 * /math-worksheets/<skill words>: one skill's worksheet maker. Server-rendered
 * from pure code (the skill graph and the problem templates); reads no school
 * data and needs no sign-in. `?skills=&n=&seed=` pick the exact sheet, so a
 * shared link reprints the same problems; the canonical URL is the bare page.
 */

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function resolve(slug: string): WorksheetSkill | undefined {
  return skillBySlug(slug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const s = resolve(slug);
  if (!s) return {};
  const title = skillTitle(s);
  const description = skillDescription(s);
  const path = `/math-worksheets/${s.slug}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, type: "website" },
    twitter: { title, description },
  };
}

function SkillLinks({ keys }: { keys: string[] }) {
  return (
    <ul className="mw-list">
      {keys.map((k) => {
        const page = skillByKey(k);
        const info = graphSkill(k);
        if (!info) return null;
        const grade = info.grade === "K" ? "kindergarten" : `grade ${info.grade}`;
        return (
          <li key={k}>
            {page ? <Link href={`/math-worksheets/${page.slug}`}>{info.label}</Link> : info.label}{" "}
            <span style={{ color: "#7a7466" }}>({grade})</span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function SkillWorksheetPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const s = resolve(slug);
  const sp = await searchParams;
  if (!s) {
    // An old or hand-typed key form ("add-subtract-like") lands on the real page.
    const byKey = skillByKey(slug.replace(/-/g, "_"));
    if (byKey) permanentRedirect(`/math-worksheets/${byKey.slug}`);
    // A page that existed once keeps its link working: it lands on the hub.
    if (frozenSlugWithoutPage(slug)) permanentRedirect("/math-worksheets");
    notFound();
  }

  const params0 = parseSheetParams(s.skillKey, sp);
  const sheet = buildSheet(params0);
  const origin = siteOrigin();
  const credit = schoolCredit();
  const mixed = params0.skillKeys.slice(1).map((k) => {
    const label = skillByKey(k)?.shortLabel ?? k;
    return label.charAt(0).toLowerCase() + label.slice(1);
  });
  const skillLabels = Object.fromEntries(params0.skillKeys.map((k) => [k, skillByKey(k)?.shortLabel ?? k]));
  const hasSteps = sheet.items.some((i) => i.steps);
  const about = skillCopy(s.skillKey)?.about;

  return (
    <main>
      {jsonLdScript(skillJsonLd(s, origin, credit))}
      <nav className="mw-crumbs mw-noprint" aria-label="Breadcrumb">
        <Link href="/math-worksheets">Math worksheets</Link> › {gradeName(s.grade)} › {s.domainLabel}
      </nav>
      <div className="mw-surface mw-noprint">
        <h1 className="mw-h1">{s.shortLabel}</h1>
        <p className="mw-meta">
          {gradeName(s.grade)} · {s.domainLabel}
          {s.ccCodes.length > 0 && <> · Common Core {s.ccCodes.join(", ")}</>}
        </p>
        <p className="mw-lede">
          A printable worksheet with {sheet.items.length} problems and an answer key
          {hasSteps ? " that shows the worked steps" : ""}. Change the number of problems, mix in a related skill, or press
          &ldquo;New set&rdquo; for different numbers. Nothing to sign up for.
        </p>
      </div>

      <WorksheetMaker
        key={sheetQuery(params0)}
        slug={s.slug}
        title={s.shortLabel}
        subtitle={[gradeName(s.grade), s.domainLabel, mixed.length ? `mixed with ${mixed.join(", ")}` : ""]
          .filter(Boolean)
          .join(" · ")}
        sheet={sheet}
        skillLabels={skillLabels}
        mixOptions={mixCandidates(s).map((o) => ({ key: o.skillKey, label: o.shortLabel, grade: o.grade }))}
        linkHost={origin.replace(/^https?:\/\//, "")}
      />

      <section className="mw-surface mw-noprint" aria-labelledby="mw-about">
        <h2 className="mw-h2" id="mw-about">
          About this skill
        </h2>
        {about && <p className="mw-p">{about}</p>}
        <p className="mw-p">
          If this sheet is too hard, try one of the skills it builds on. If it&rsquo;s easy, try what comes next.
        </p>
        {s.buildsOn.length > 0 && (
          <>
            <h3 className="mw-h3">What it builds on</h3>
            <SkillLinks keys={s.buildsOn} />
          </>
        )}
        {s.leadsTo.length > 0 && (
          <>
            <h3 className="mw-h3">What comes next</h3>
            <SkillLinks keys={s.leadsTo} />
          </>
        )}
        {hasSteps && (
          <>
            <h3 className="mw-h3">About the worked steps</h3>
            <p className="mw-p">
              The steps page works each problem out except for its last step, the one that produces the answer. A stuck
              child can follow the start and finish it, so they still do the part that counts. The answer key has the
              answers for you.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
