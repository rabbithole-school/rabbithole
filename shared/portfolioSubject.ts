// The family portfolio's SUBJECT groups: work that isn't part of a course is
// grouped under the subject it was given in ("Art", "Math"), and only work
// with no known subject lands in "Other work". One slug rule for the server
// (which groups and counts) and the portal (which links and filters), so a
// tile and the page it opens always agree on what belongs to it.

/** Where a subject's page lives under `/parent/portfolio/`. A course is a
 *  Convex id and the unfiled page is `other`, so the prefix can't collide. */
export const PORTFOLIO_SUBJECT_SEGMENT_PREFIX = "subject-";

/** The ʻokina and the apostrophes typed in its place: dropped, not turned
 *  into a word break, so "Hawaiʻi" slugs as "hawaii". */
const OKINA_AND_APOSTROPHES = /[\u02BB\u02BC\u2018\u2019'`]/g;

/** FNV-1a, base 36: a short, stable key for a subject with no Latin letters
 *  or digits to slug ("数学"), so it still gets its own group. */
function stableSubjectKey(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `s${hash.toString(36)}`;
}

/** "Art & Design " → "art-design", "ʻŌlelo Hawaiʻi" → "olelo-hawaii". Case,
 *  accents and punctuation never split one subject into two groups. Empty
 *  only for an empty subject. */
export function portfolioSubjectSlug(subject: string): string {
  const text = subject
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(OKINA_AND_APOSTROPHES, "")
    .trim()
    .toLowerCase();
  if (!text) return "";
  const slug = text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || stableSubjectKey(text);
}

/** The URL segment for one subject's page. */
export function portfolioSubjectSegment(subject: string): string {
  return `${PORTFOLIO_SUBJECT_SEGMENT_PREFIX}${portfolioSubjectSlug(subject)}`;
}

/** The subject slug a `/parent/portfolio/<segment>` names, or null when the
 *  segment is a course or the unfiled page. */
export function subjectSlugFromSegment(segment: string | null): string | null {
  if (!segment?.startsWith(PORTFOLIO_SUBJECT_SEGMENT_PREFIX)) return null;
  const slug = segment.slice(PORTFOLIO_SUBJECT_SEGMENT_PREFIX.length);
  return slug.length > 0 ? slug : null;
}

/** Does this piece of work belong on the subject page `slug`? Work filed to a
 *  course lives behind its course, never a subject. */
export function itemInPortfolioSubject(
  item: { courseId?: string | null; subject?: string | null },
  slug: string,
): boolean {
  return (
    item.courseId == null &&
    item.subject != null &&
    portfolioSubjectSlug(item.subject) === slug
  );
}

/** Does this piece of work belong on the "Other work" page: no course and no
 *  subject anyone recorded for it. */
export function itemIsOtherWork(item: {
  courseId?: string | null;
  subject?: string | null;
}): boolean {
  return item.courseId == null && item.subject == null;
}
