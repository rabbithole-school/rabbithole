/**
 * standardStrand — pure helpers that turn a raw standard (subject + notation +
 * gradeLevels) into the Acceleration view's grade-banded "strand" rows.
 *
 * Why derive a strand instead of using `subject` directly: CCSS "ELA/Literacy"
 * is really several grade-banded progressions (Reading, Writing, Language,
 * Speaking & Listening) distinguished only by the notation prefix (RL.2.1,
 * W.3.2, L.4.1, SL.2.1). Splitting them gives the teacher real, legible rows
 * from real data. Math stays one strand. Skill-based, all-grades frameworks
 * (e.g. UCLA Historical Thinking, whose every standard is tagged K–8) are NOT
 * grade-banded, so they're excluded from the acceleration projection.
 *
 * Pure + unit-tested in convex/lib/__tests__/standardStrand.test.ts.
 */

export type Strand = {
  /** stable key, e.g. "math" | "ela.reading" */
  key: string;
  /** display label, e.g. "Math" | "Reading" */
  label: string;
  /** sort order among strands (lower = first) */
  order: number;
};

// ELA notation prefix → strand. Order matters: longest/most-specific first.
const ELA_PREFIX_STRANDS: Array<{ test: RegExp; strand: Strand }> = [
  { test: /^(RL|RI|RF|RH|RST|CCRA\.R)\b/i, strand: { key: "ela.reading", label: "Reading", order: 2 } },
  { test: /^(WHST|W|CCRA\.W)\b/i, strand: { key: "ela.writing", label: "Writing", order: 3 } },
  { test: /^(SL|CCRA\.SL)\b/i, strand: { key: "ela.speaking", label: "Speaking & Listening", order: 4 } },
  { test: /^(L|CCRA\.L)\b/i, strand: { key: "ela.language", label: "Language", order: 5 } },
];

const MATH_STRAND: Strand = { key: "math", label: "Math", order: 1 };
const SCIENCE_STRAND: Strand = { key: "science", label: "Science", order: 6 };

/**
 * Map a standard to its acceleration strand, or null if it isn't grade-banded
 * (and so shouldn't appear in the grade-progression view).
 */
export function strandForStandard(
  subject: string,
  notation: string | undefined,
): Strand | null {
  const subj = subject.toLowerCase();
  if (subj.includes("math")) return MATH_STRAND;
  if (subj.includes("science")) return SCIENCE_STRAND;
  if (subj.includes("ela") || subj.includes("literacy") || subj.includes("english")) {
    const n = (notation ?? "").trim();
    for (const { test, strand } of ELA_PREFIX_STRANDS) {
      if (test.test(n)) return strand;
    }
    // ELA leaf with an unrecognized prefix → bucket under Reading as a safe default
    return n ? { key: "ela.reading", label: "Reading", order: 2 } : null;
  }
  // Future frameworks (NGSS, arts, …) map their own subject → strand here.
  // Anything else (skill-based, all-grades) is not grade-banded → excluded.
  return null;
}

/** The grade columns the acceleration view renders, low → high (left → right). */
export const ACCELERATION_GRADES = ["K", "1", "2", "3", "4", "5", "6", "7", "8"];

/**
 * Is `g` a valid CHRONOLOGICAL grade-level notch value (users.gradeLevel)?
 * It must be exactly one of the grade columns the acceleration view draws, so
 * the notch can line up with a column. Anything else (a tenth, "college", a
 * stray label) can't be a notch and is rejected by the setters.
 */
export function isValidGradeLevel(g: string): boolean {
  return ACCELERATION_GRADES.includes(g);
}

// CCSS domain code → human label, for the drill-down's sub-topic clusters.
const DOMAIN_LABELS: Record<string, string> = {
  // Math
  CC: "Counting & Cardinality",
  OA: "Operations & Algebraic Thinking",
  NBT: "Number & Operations in Base Ten",
  NF: "Number & Operations — Fractions",
  MD: "Measurement & Data",
  G: "Geometry",
  RP: "Ratios & Proportional Relationships",
  NS: "The Number System",
  EE: "Expressions & Equations",
  SP: "Statistics & Probability",
  F: "Functions",
  // ELA
  RL: "Reading: Literature",
  RI: "Reading: Informational",
  RF: "Reading: Foundational Skills",
  W: "Writing",
  WHST: "Writing (History/Science)",
  SL: "Speaking & Listening",
  L: "Language",
  RH: "Reading: History",
  RST: "Reading: Science & Technical",
  // NGSS science disciplines
  PS: "Physical Science",
  LS: "Life Science",
  ESS: "Earth & Space Science",
  ETS: "Engineering Design",
};

/**
 * The CCSS "domain" code inside a notation — the sub-topic cluster a standard
 * belongs to. Math notations are `<grade>.<DOMAIN>.<n>` (3.NF.1 → NF, K.CC.1 →
 * CC). NGSS performance expectations are `<grade>-<DISC><dci>-<n>` (3-LS1-1 →
 * LS, 5-PS1-2 → PS). ELA notations lead with the strand/domain (RL.3.1 → RL,
 * W.4.2 → W).
 */
export function domainOf(notation: string | undefined): { key: string; label: string } {
  const n = (notation ?? "").trim();
  // Math: token after the leading grade + a dot.
  const math = n.match(/^(?:K|\d+)\.([A-Z]+)/);
  if (math) {
    const key = math[1];
    return { key, label: DOMAIN_LABELS[key] ?? key };
  }
  // NGSS: discipline letters after the leading grade/band + a dash
  // (3-LS1-1 → LS, MS-LS2-3 → LS, HS-ESS1-2 → ESS).
  const ngss = n.match(/^(?:K|\d+|MS|HS)-([A-Z]+)\d/);
  if (ngss) {
    const key = ngss[1];
    return { key, label: DOMAIN_LABELS[key] ?? key };
  }
  // ELA: leading alpha token.
  const ela = n.match(/^([A-Z]+)/);
  if (ela) {
    const key = ela[1];
    return { key, label: DOMAIN_LABELS[key] ?? key };
  }
  return { key: "other", label: "Other" };
}

/** 0-based index of a grade in the ladder; -1 if not a tracked grade. */
export function gradeIndex(grade: string): number {
  return ACCELERATION_GRADES.indexOf(grade);
}

/**
 * From a standard's `gradeLevels` array, return the tracked grades it belongs
 * to. A grade-banded standard normally has exactly one; we intersect with the
 * ladder so an all-grades (skill) standard that slipped through still can't
 * smear across every column (it returns all — callers exclude via strand=null).
 */
export function trackedGrades(gradeLevels: string[]): string[] {
  return gradeLevels.filter((g) => ACCELERATION_GRADES.includes(g));
}

/**
 * Is this standard GRADE-SPECIFIC (vs. an all-grades anchor/skill standard)?
 * CCSS "anchor" standards (CCRA.*) and skill frameworks are tagged to many
 * grades at once; counting them would smear one value across every column. A
 * genuine grade-banded standard targets ≤ 3 grades: one grade for K–5, or the
 * NGSS/CCSS middle-school band (6–8). This is the guard that keeps the
 * acceleration view honest — only grade-specific standards count.
 */
export const GRADE_SPECIFIC_MAX = 3;
export function isGradeSpecific(gradeLevels: string[]): boolean {
  const n = trackedGrades(gradeLevels).length;
  return n >= 1 && n <= GRADE_SPECIFIC_MAX;
}
