import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KID_SAFE_PRINCIPLES } from "../kidSafePrinciples";

// Test-only drift guard: the UI must never import or render live prompt text.
// This hash fails loudly when the public Socratic/tool-frame scaffolding in
// convex/prompts.ts changes — covering BOTH the tool-frame framing prose ("Your
// role is to be a Socratic tutor…", "You are a learning tool… you do not
// simulate friendship…") AND the Guidelines bullet list, since the kid-safe
// gloss is derived from that whole region. When this trips, a human re-reviews
// the static gloss against the (possibly loosened) scaffolding.
//
// Updated 2026-07-03 (Workshop P2a): the welfare-disclosure Guidelines bullet
// was extracted verbatim into the shared `WELFARE_DISCLOSURE_GUIDANCE` constant
// and spliced back via interpolation. The RENDERED tutor prompt is byte-
// identical (guarded in convex/__tests__/metaPrompts.test.ts) — only the source
// representation changed, so this source hash was re-baselined. No gloss change.
//
// Re-baselined again (fraction rendering Phase 2 — LaTeX): the math-FORMATTING
// Guidelines bullet was rewritten to tell the tutor to write math as LaTeX in
// `$...$` / `$$...$$` (`\frac{a}{b}`, `\square`, exponents, geometry, sums) —
// which the app renders full-power via KaTeX (web) + SwiftMath (native) —
// INVERTING the earlier plain-ASCII form. This is a rendering/format
// instruction, not a change to the Socratic/tool-frame or kid-safety framing, so
// the kid-safe gloss (KID_SAFE_PRINCIPLES) is unaffected — only the source hash
// moved. Re-reviewed: no gloss change needed.
//
// Re-baselined 2026-08-14 (footing-matched stance, PR #2245): two Guidelines
// bullets were added — warm-vs-cold footing (on a topic where the scholar lacks
// any usable premise, briefly show the key idea then hand back one apply/predict
// question, instead of a leading-question guessing funnel) and scholar-owned
// synthesis (the tutor never narrates a completed reasoning chain; the scholar
// assembles it in their own words) — plus one-clause carve-outs in the
// causal-question and scaffold-opportunity bullets. Re-reviewed against the
// gloss: "Ask before answering" still describes the default (the cold case is
// precisely when a scholar cannot have a first take, and the shown premise is
// immediately handed back), and the new bullets STRENGTHEN "No doing your work
// for you" and "Notice what you figured out". No gloss change needed.
//
// Re-baselined 2026-08-15 (correctness-affirmation pattern): standalone
// correctness stamps now name their common variants and explicitly preserve
// content-anchored micro-warmth. This strengthens "Notice what you figured out"
// without changing the kid-safe gloss.
//
// Re-baselined 2026-08-20 (PR #2555): Guidelines now use singular-they pronouns
// consistently. This pronoun-only change leaves the kid-safe gloss/principles
// unchanged after review.
//
// Re-baselined 2026-09-22 (PR #3930): two Guidelines bullets were added — a
// fragment answer gets "say the whole thing" instead of the tutor writing the
// full causal sentence for the scholar, and a one-time invitation to dictate
// when typing is the bottleneck. The first STRENGTHENS "No doing your work for
// you" and "Notice what you figured out"; the second is a modality nudge that no
// principle covers. No gloss change needed.
//
// Re-baselined 2026-09-27 (TRA-407, PR #4011): one sentence after the
// tool-frame paragraph says the app may end a scholar message with a bracketed
// turn-context note (clock, pacing) that the tutor uses silently. It moved the
// clock out of the cached system prompt; it changes no Socratic or tool-frame
// guidance, so no principle is affected. No gloss change needed.
//
// Re-baselined 2026-09-27 (TRA-363): the standalone dictation-invitation bullet
// never fired in prod, so the mic offer now rides the fragment ask (first typed
// fragment of a session), and the bullet shrank to dictated-turn handling. Same
// principles as #3930. No gloss change needed.
//
// Re-baselined 2026-10-11 (TRA-413, PR #4151): the fragment bullet now treats a
// one-word pick on an either/or reasoning question as a half-thought — affirm
// it and ask for the scholar's why instead of explaining the reasoning — with
// picks about the scholar's own creation exempt. Re-reviewed against the gloss:
// it strengthens "Ask before answering" and "No doing your work for you".
// No gloss change needed.
// Re-baselined 2026-10-11 (TRA-501): a new bullet makes dictation first-class
// input for every scholar (never ask a child to type what they said; point to
// the writing-box mic; the tutor still never writes in the box). Re-reviewed
// against the gloss: it supports "No doing your work for you" (the words stay
// the scholar's). No gloss change needed.
const EXPECTED_TUTOR_GUIDELINES_HASH =
  "8f699ed698256d52565e7e8effafc0ed4e5a9003e6a31df4b2a6f833032f44ae";

const FORBIDDEN_TOKENS = [
  /\bwhisper\b/i,
  /\bdossier\b/i,
  /\bsystem\s*prompt\b/i,
  /\bsystemPrompt\b/,
  /\bscholarDocuments\b/,
  /\bredact(?:ed|ion)?\b/i,
  /\bIEP\b/,
  /\bassessment\b/i,
  /\bmastery\b/i,
  /\bsignals?\b/i,
  /\bseeds?\b/i,
  /\bdirectives?\b/i,
  /\bprofile\b/i,
  /\bprivate\b/i,
];

function principleCopy(): string {
  return KID_SAFE_PRINCIPLES.map((principle) => `${principle.title}\n${principle.blurb}`).join(
    "\n",
  );
}

function tutorGuidelinesHash(): string {
  const source = readFileSync(new URL("../../convex/prompts.ts", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const start = source.indexOf("Your role is to be a Socratic tutor");
  const end = source.indexOf("${startBullet}", start);

  expect(start, "prompt Socratic-tutor framing marker should exist").toBeGreaterThanOrEqual(0);
  expect(end, "prompt startBullet marker should exist after the framing").toBeGreaterThan(start);

  const guidelines = source.slice(start, end).trim();
  return createHash("sha256").update(guidelines).digest("hex");
}

describe("KID_SAFE_PRINCIPLES", () => {
  it("is a short, non-empty kid-facing list", () => {
    expect(KID_SAFE_PRINCIPLES.length).toBeGreaterThanOrEqual(5);
    expect(KID_SAFE_PRINCIPLES.length).toBeLessThanOrEqual(8);

    for (const principle of KID_SAFE_PRINCIPLES) {
      expect(principle.title.trim().length).toBeGreaterThan(0);
      expect(principle.blurb.trim().length).toBeGreaterThan(0);
      expect(principle.title.length).toBeLessThanOrEqual(48);
      expect(principle.blurb.length).toBeLessThanOrEqual(170);
    }
  });

  it("does not expose redaction-gated implementation terms", () => {
    const copy = principleCopy();
    for (const token of FORBIDDEN_TOKENS) {
      expect(copy).not.toMatch(token);
    }
  });

  it("stays third-person and tool-framed", () => {
    const copy = principleCopy();
    expect(copy).toContain("Rabbithole");
    expect(copy).not.toMatch(/\bI(?:'m| am)\b/i);
    expect(copy).not.toMatch(/\bmy\b/i);
    expect(copy).not.toMatch(/\bme\b/i);
  });

  it("flags Socratic/tool-frame prompt drift for human re-review", () => {
    expect(tutorGuidelinesHash()).toBe(EXPECTED_TUTOR_GUIDELINES_HASH);
  });
});
