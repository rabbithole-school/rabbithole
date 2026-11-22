/**
 * The skill catalog behind the public math-worksheet maker (/math-worksheets).
 *
 * Pure data, no Convex, no auth, no school: it reads the K-9 seed graphs
 * (convex/seed/*Graph.ts) and the problem templates (convex/lib/practice/
 * templates.ts) and nothing else, so the pages that use it have no tenant and
 * read no institution's data (.claude/rules/rabbithole-multi-tenancy.md).
 *
 * A skill gets a page only when its template produces a real sheet: at least
 * MIN_DISTINCT_ITEMS different problems from one seed. A skill with no
 * template (a handful of visual fraction skills the partition manipulative
 * serves) or a template too narrow for a sheet gets no page.
 */

import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
  type SeedEdge,
  type SeedSkill,
} from "@/convex/seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_DOMAIN,
  FRACTION_ARITHMETIC_SKILLS,
  FRACTION_ARITHMETIC_EDGES,
} from "@/convex/seed/fractionArithmeticGraph";
import { PROBABILITY_DOMAIN, PROBABILITY_SKILLS, PROBABILITY_EDGES } from "@/convex/seed/probabilityGraph";
import {
  GEOMETRY_MEASUREMENT_DOMAIN,
  GEOMETRY_MEASUREMENT_SKILLS,
  GEOMETRY_MEASUREMENT_EDGES,
} from "@/convex/seed/geometryMeasurementGraph";
import {
  RATIO_PROPORTION_PERCENT_DOMAIN,
  RATIO_PROPORTION_PERCENT_SKILLS,
  RATIO_PROPORTION_PERCENT_EDGES,
} from "@/convex/seed/ratioProportionPercentGraph";
import {
  INTEGERS_COORDINATES_DOMAIN,
  INTEGERS_COORDINATES_SKILLS,
  INTEGERS_COORDINATES_EDGES,
} from "@/convex/seed/integersCoordinatesGraph";
import { EARLY_ALGEBRA_DOMAIN, EARLY_ALGEBRA_SKILLS, EARLY_ALGEBRA_EDGES } from "@/convex/seed/earlyAlgebraGraph";
import { ALGEBRA_1_DOMAIN, ALGEBRA_1_SKILLS, ALGEBRA_1_EDGES } from "@/convex/seed/algebra1Graph";
import { DISCRETE_MATH_DOMAIN, DISCRETE_MATH_SKILLS, DISCRETE_MATH_EDGES } from "@/convex/seed/discreteMathGraph";
import { generateSet, hasTemplate } from "@/convex/lib/practice/templates";
import { PRACTICE_DOMAIN_LABELS } from "@/shared/practiceDomainLabels";
import FROZEN_SLUGS from "./slugs.json";

/**
 * Every published page's URL, frozen. A slug is computed from the skill's
 * label once, when the skill first gets a page, and then written into
 * slugs.json so a later label edit can never move a page people have linked
 * to. Add new skills to the file; never edit or remove an entry. A slug whose
 * skill loses its page redirects to the hub (frozenSlugWithoutPage).
 */
const FROZEN: Record<string, string> = FROZEN_SLUGS;

/** Fewest distinct problems a template must yield from one seed to get a page. */
export const MIN_DISTINCT_ITEMS = 6;

/** Display order of grades on the hub. */
export const GRADE_ORDER = ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export type WorksheetSkill = {
  skillKey: string;
  slug: string;
  label: string;
  /** The label without any "(e.g. …)" aside, for titles and links. */
  shortLabel: string;
  grade: string;
  domain: string;
  domainLabel: string;
  strand: string;
  ccCodes: string[];
  /** Skills this one builds on (incoming buildsOn edges), any domain. */
  buildsOn: string[];
  /** Skills that build on this one (outgoing buildsOn edges), any domain. */
  leadsTo: string[];
};

type Graph = { domain: string; skills: SeedSkill[]; edges: SeedEdge[] };

const GRAPHS: Graph[] = [
  { domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN, skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES },
  { domain: FRACTION_ARITHMETIC_DOMAIN, skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES },
  { domain: GEOMETRY_MEASUREMENT_DOMAIN, skills: GEOMETRY_MEASUREMENT_SKILLS, edges: GEOMETRY_MEASUREMENT_EDGES },
  { domain: RATIO_PROPORTION_PERCENT_DOMAIN, skills: RATIO_PROPORTION_PERCENT_SKILLS, edges: RATIO_PROPORTION_PERCENT_EDGES },
  { domain: INTEGERS_COORDINATES_DOMAIN, skills: INTEGERS_COORDINATES_SKILLS, edges: INTEGERS_COORDINATES_EDGES },
  { domain: EARLY_ALGEBRA_DOMAIN, skills: EARLY_ALGEBRA_SKILLS, edges: EARLY_ALGEBRA_EDGES },
  { domain: PROBABILITY_DOMAIN, skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES },
  { domain: ALGEBRA_1_DOMAIN, skills: ALGEBRA_1_SKILLS, edges: ALGEBRA_1_EDGES },
  { domain: DISCRETE_MATH_DOMAIN, skills: DISCRETE_MATH_SKILLS, edges: DISCRETE_MATH_EDGES },
];

/** "Count to 10 by ones (e.g. 1, 2, 3)" → "Count to 10 by ones". */
export function stripAside(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** A plain URL word chain from a label: lowercase ASCII, hyphens, ≤ 70 chars. */
export function slugify(label: string): string {
  const base = stripAside(label)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = base.length <= 70 ? base : base.slice(0, base.lastIndexOf("-", 70));
  // A symbol-only tail ("…using <, =, >") or a cut leaves a dangling word.
  const words = cut.split("-");
  while (words.length > 2 && TRAILING_STOPWORDS.has(words[words.length - 1])) words.pop();
  return words.join("-");
}

const TRAILING_STOPWORDS = new Set(["a", "an", "and", "as", "by", "for", "in", "into", "of", "on", "or", "the", "to", "its", "using", "with"]);

function gradeRank(grade: string): number {
  const i = (GRADE_ORDER as readonly string[]).indexOf(grade);
  return i < 0 ? GRADE_ORDER.length : i;
}

function buildCatalog(): WorksheetSkill[] {
  const buildsOn = new Map<string, string[]>();
  const leadsTo = new Map<string, string[]>();
  for (const g of GRAPHS) {
    for (const e of g.edges) {
      (buildsOn.get(e.toKey) ?? buildsOn.set(e.toKey, []).get(e.toKey)!).push(e.fromKey);
      (leadsTo.get(e.fromKey) ?? leadsTo.set(e.fromKey, []).get(e.fromKey)!).push(e.toKey);
    }
  }
  const out: WorksheetSkill[] = [];
  const seenSlugs = new Set<string>();
  // Two skills can differ only in their aside ("Count objects (within 10)" and
  // "(within 20)"); those keep the aside so titles and URLs stay distinct.
  const shortCount = new Map<string, number>();
  for (const g of GRAPHS) for (const s of g.skills) shortCount.set(stripAside(s.label), (shortCount.get(stripAside(s.label)) ?? 0) + 1);
  for (const g of GRAPHS) {
    for (const s of g.skills) {
      if (!hasTemplate(s.skillKey)) continue;
      // The algorithms strand has no public pages yet: it runs to grade 10
      // (the hub lists K–9) and each page needs a frozen slug and a parent
      // description written for it.
      if (g.domain === DISCRETE_MATH_DOMAIN && s.strand === "algorithms") continue;
      if (generateSet(s.skillKey, MIN_DISTINCT_ITEMS, 1).length < MIN_DISTINCT_ITEMS) continue;
      const ambiguous = (shortCount.get(stripAside(s.label)) ?? 0) > 1;
      const shortLabel = ambiguous ? s.label : stripAside(s.label);
      let slug = FROZEN[s.skillKey] ?? slugify(ambiguous ? s.label.replace(/[()]/g, " ") : s.label);
      if (seenSlugs.has(slug)) slug = `${slug}-${s.skillKey.replace(/_/g, "-")}`;
      seenSlugs.add(slug);
      out.push({
        skillKey: s.skillKey,
        slug,
        label: s.label,
        shortLabel,
        grade: s.grade,
        domain: g.domain,
        domainLabel: PRACTICE_DOMAIN_LABELS[g.domain] ?? g.domain,
        strand: s.strand,
        ccCodes: s.ccCodes,
        buildsOn: [...new Set(buildsOn.get(s.skillKey) ?? [])],
        leadsTo: [...new Set(leadsTo.get(s.skillKey) ?? [])],
      });
    }
  }
  return out.sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade));
}

let cached: { list: WorksheetSkill[]; bySlug: Map<string, WorksheetSkill>; byKey: Map<string, WorksheetSkill> } | null = null;

function catalog() {
  if (!cached) {
    const list = buildCatalog();
    cached = {
      list,
      bySlug: new Map(list.map((s) => [s.slug, s])),
      byKey: new Map(list.map((s) => [s.skillKey, s])),
    };
  }
  return cached;
}

/** Every skill with a working sheet, grade order (stable within a grade). */
export function worksheetSkills(): WorksheetSkill[] {
  return catalog().list;
}

export function skillBySlug(slug: string): WorksheetSkill | undefined {
  return catalog().bySlug.get(slug);
}

/** A slug that once had a page whose skill no longer has one. */
export function frozenSlugWithoutPage(slug: string): boolean {
  return Object.values(FROZEN).includes(slug) && !skillBySlug(slug);
}

/** The frozen slug table, for the tests. */
export function frozenSlugs(): Readonly<Record<string, string>> {
  return FROZEN;
}

export function skillByKey(key: string): WorksheetSkill | undefined {
  return catalog().byKey.get(key);
}

let graphLabels: Map<string, { label: string; grade: string }> | null = null;

/** Any graph skill's label and grade, page or not (prerequisites can lack a page). */
export function graphSkill(key: string): { label: string; grade: string } | undefined {
  if (!graphLabels) {
    graphLabels = new Map();
    for (const g of GRAPHS) for (const s of g.skills) graphLabels.set(s.skillKey, { label: stripAside(s.label), grade: s.grade });
  }
  return graphLabels.get(key);
}

/**
 * Skills worth offering in "mix in another skill": what this one builds on,
 * what it leads to, then same-topic neighbours within a grade, nearest first.
 */
export function mixCandidates(s: WorksheetSkill, limit = 30): WorksheetSkill[] {
  const out: WorksheetSkill[] = [];
  const seen = new Set([s.skillKey]);
  const add = (k: string) => {
    const hit = skillByKey(k);
    if (hit && !seen.has(k)) {
      seen.add(k);
      out.push(hit);
    }
  };
  s.buildsOn.forEach(add);
  s.leadsTo.forEach(add);
  const r = gradeRank(s.grade);
  worksheetSkills()
    .filter((o) => o.domain === s.domain && Math.abs(gradeRank(o.grade) - r) <= 1)
    .sort((a, b) => Math.abs(gradeRank(a.grade) - r) - Math.abs(gradeRank(b.grade) - r))
    .forEach((o) => add(o.skillKey));
  return out.slice(0, limit);
}

/** Human grade name: "K" → "Kindergarten", "4" → "Grade 4". */
export function gradeName(grade: string): string {
  return grade === "K" ? "Kindergarten" : `Grade ${grade}`;
}

/** The domains that have at least one page, in graph order. */
export function worksheetDomains(): { domain: string; label: string }[] {
  const have = new Set(worksheetSkills().map((s) => s.domain));
  return GRAPHS.filter((g) => have.has(g.domain)).map((g) => ({
    domain: g.domain,
    label: PRACTICE_DOMAIN_LABELS[g.domain] ?? g.domain,
  }));
}
