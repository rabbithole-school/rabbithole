/**
 * Canonical taxonomy for `knowledgeNodes.domain` / `.strand`.
 *
 * The shared `knowledgeNodes` table is assembled from many sources (the practice
 * graph, standards import, scholar seeds, observer mastery, curated fixtures),
 * each of which spelled `domain` its own way — producing dup subjects
 * ("Math" / "Mathematics" / "mathematics"), case dups ("Historical thinking"),
 * and FLATTENED strands: ELA's "Reading" / "Writing" / "Language" /
 * "Speaking & Listening" landed as top-level *domains* because
 * `concepts._standardSources` wrote `strand.label ?? subject` — discarding the
 * subject→strand parentage it had just computed.
 *
 * `classifyDomain()` folds all of that to ONE canonical (domain, strand) pair:
 *   • dup-merge:  Math/Mathematics/mathematics → "Mathematics"; ELA/… → "ELA/Literacy"
 *   • un-flatten: Reading/Writing/Language/Speaking & Listening → domain
 *                 "ELA/Literacy", strand = the ELA strand (the 2-level
 *                 domain→strand model the practice engine already uses).
 *   • two umbrellas: CONTENT subjects (Mathematics · Science · ELA/Literacy ·
 *                    Humanities) vs the disciplinary-thinking-skills umbrella
 *                    "Ways of Thinking" (strand = the framework name).
 *   • passthrough: anything unknown — crucially the PRACTICE-engine domain slugs
 *                  ("whole-number-arithmetic", future "fractions") — is left
 *                  untouched (domain AND strand). The engine keys on those; this
 *                  taxonomy is a Sky/atlas display + rollup concern only.
 *
 * "Ways of Thinking" is our umbrella for the disciplinary practice/skill
 * standards — UCLA/NCHS **Historical Thinking**, CCSS **Standards for
 * Mathematical Practice**, NGSS **Science & Engineering Practices** — the "how
 * you do the discipline" dimension, orthogonal to content. Strands keep their
 * native framework names.
 *
 * Pure module — no Convex imports; unit-tested directly.
 */

/** The umbrella for disciplinary thinking-skill standards (see file doc). */
export const WAYS_OF_THINKING = "Ways of Thinking";

/** The content umbrella for social studies / history / geography / economics. */
export const HUMANITIES = "Humanities";

export type DomainClass = { domain: string; strand?: string };

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Keyed by norm(rawDomain). An entry WITH a `strand` un-flattens (the raw value
 * was really a sub-area); an entry with only `domain` is a subject-synonym merge.
 */
const TAXONOMY: Record<string, DomainClass> = {
  // ── Ways of Thinking (disciplinary practices / skills) ──
  "historical thinking": { domain: WAYS_OF_THINKING, strand: "Historical Thinking" },

  // ── Mathematics (content) ──
  math: { domain: "Mathematics" },
  mathematics: { domain: "Mathematics" },
  fractions: { domain: "Mathematics", strand: "Fractions" },
  "ratio-proportion-percent": { domain: "ratio-proportion-percent" },
  "integers-coordinates": { domain: "integers-coordinates" },
  "early-algebra": { domain: "early-algebra" },
  "algebra-1": { domain: "algebra-1" },
  "discrete-math": { domain: "discrete-math" },

  // ── ELA/Literacy (content) — strands un-flattened ──
  ela: { domain: "ELA/Literacy" },
  "ela/literacy": { domain: "ELA/Literacy" },
  reading: { domain: "ELA/Literacy", strand: "Reading" },
  writing: { domain: "ELA/Literacy", strand: "Writing" },
  language: { domain: "ELA/Literacy", strand: "Language" },
  "speaking & listening": { domain: "ELA/Literacy", strand: "Speaking & Listening" },

  // ── Science (content) ──
  science: { domain: "Science" },
};

/**
 * Map a raw (domain, strand?) to the canonical (domain, strand?). Idempotent and
 * total: unknown domains (practice slugs, anything new) pass through unchanged. A
 * raw strand that is itself a subject-synonym (e.g. the coarse "Math" label
 * `strandForStandard` emits) is dropped rather than kept as a bogus sub-strand.
 */
export function classifyDomain(rawDomain: string, rawStrand?: string): DomainClass {
  const base = TAXONOMY[norm(rawDomain)] ?? { domain: rawDomain.trim() };

  let strand = base.strand;
  if (strand === undefined && rawStrand && rawStrand.trim()) {
    const s = rawStrand.trim();
    const mapped = TAXONOMY[norm(s)];
    // Keep the raw strand only if it's a real sub-area, not a subject synonym.
    strand = mapped && !mapped.strand ? undefined : s;
  }

  return strand === undefined ? { domain: base.domain } : { domain: base.domain, strand };
}
