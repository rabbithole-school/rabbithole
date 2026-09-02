"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { extractTextWithClaude } from "./lib/claudeFileExtraction";
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./lib/institutionPromptProfile";

/**
 * Extraction + redaction pipeline for scholarDocuments.
 *
 * 1. Pull the PDF bytes out of Convex storage.
 * 2. Send the PDF to Claude (native PDF support) for plain-text extraction.
 * 3. Send the extracted text BACK to Claude with a strict redaction prompt.
 * 4. Save both to the document row.
 * 5. Optionally purge the original PDF per DOCUMENT_RETENTION_POLICY.
 *
 * The redaction step is load-bearing — everything it outputs is allowed to
 * flow into downstream LLM calls that generate directives/seeds, and those
 * eventually surface to the scholar via the tutor. Keep the prompt strict.
 *
 * Uses Claude (the rest of the app's AI backbone) rather than Gemini: it reads
 * PDFs natively, ANTHROPIC_API_KEY is already set on every deployment, and the
 * model id is centralized in lib/models.ts. (We previously called Gemini, whose
 * gemini-3-pro-preview model Google retired with a 404.)
 */

// Document extraction + redaction is quality-sensitive (the redaction is
// load-bearing — see below) and runs in the background, so latency/cost are
// fine. Defaults to Sonnet, the reasoning baseline; override per-deployment via
// SCHOLAR_DOC_MODEL (e.g. to MODELS.OPUS's id) without a code change — same
// pattern as the observer's OBSERVER_MODEL.
function docModel(): string {
  return process.env.SCHOLAR_DOC_MODEL || MODELS.SONNET;
}

// ─────────────────────────────────────────────────────────────────────────
// SUMMARY / REDACTION PROMPT — EDIT WITH CARE.
//
// The output is a TEACHER-FACING summary. Per product decision (Andy, Jun 2026)
// we KEEP the educationally meaningful test data — IQ / index / subtest scores —
// because teachers use them to understand the profile and pace instruction. We
// still STRIP personally-identifying info and non-educational medical history.
//
// Note the downstream path: this summary feeds the proposal generator
// (scholarDocumentProposals.generateProposal) that drafts teacher directives +
// seeds, which land in the tutor system prompt and can indirectly reach the
// scholar. Raw scores now retained here can therefore surface downstream; that
// is an accepted trade-off for the teacher-facing value. If you ever need to
// keep numbers for teachers but hide them from the tutor, split the policy at
// the proposal step, not here.
// ─────────────────────────────────────────────────────────────────────────
// Rabbithole is multi-tenant: a scholar's OWN institution name is legitimate
// PROVENANCE, not redactable PII, and no single school is privileged. The
// scholar's school name is threaded in from `institutionPromptProfileForScholar`
// (resolved in extractAndRedact), so a scholar at another institution is never
// framed under a foreign school. With the configured primary default, the only
// school literal that renders is the scholar's own, and the historical inverted
// school-name stripping rule is gone. See
// `convex/lib/institutionPromptProfile.ts`.
export function buildRedactionPrompt(
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string {
  return `You are processing a confidential document about a child at ${profile.schoolName}
so the output can help teachers tailor instruction. The document may be a
cognitive assessment, an IEP / 504 plan, a note from a parent, or a teacher's
own written report or observation. This summary is FOR TEACHERS. Preserve the
educationally meaningful content — including any test data such as IQ and
subscale scores when present — and remove information that is purely personal or
medical and has no classroom value.

KEEP (preserve faithfully; include the actual numbers where the document gives
them):
- Cognitive and achievement SCORES: full-scale / FSIQ and other composite
  scores, index scores (e.g. VCI, VSI, FRI, WMI, PSI and equivalents), subtest
  scaled scores, standard scores, percentiles, and grade-equivalents. Report
  them with the instrument and label where given, e.g. "WISC-V FSIQ 131 (98th
  percentile)", "VCI 140", "Processing Speed 92". Do NOT round away or omit
  these — they are the point of the summary.
- Qualitative cognitive profile and what the scores mean pedagogically:
  "superior verbal reasoning," "processing speed trails reasoning,"
  "stealth-dyslexia pattern," "mild inattentive ADHD," "asynchronous
  development."
- **Relative gaps and asymmetries across cognitive and academic domains.** These
  are the highest-signal pedagogical findings. When reasoning / language /
  cognitive ability is markedly higher than academic skill (reading, writing,
  spelling, math fluency), or processing speed trails the rest of the profile,
  or one academic domain trails the others, NAME THAT GAP explicitly AND cite
  the relevant scores. Examples of correct phrasing:
  * "Verbal reasoning (VCI 140) sits far above reading and spelling, a pattern
    consistent with stealth dyslexia — academic skills may look merely average
    while the underlying ability is much higher."
  * "Strong reasoning (FRI 128) paired with a relative weakness in processing
    speed (PSI 92) is characteristic of a twice-exceptional profile where
    timed output masks genuine mastery."
  A summary that describes both halves (strong X + average Y) without naming
  the gap misses the point.
- Recommended accommodations and teaching strategies.
- Stated interests, strengths, protective factors.
- Learning-style observations ("works best with open-ended challenges," "reads
  above grade level," "strong pattern recognition").
- Examples of tasks the child found engaging or frustrating.
- The assessment DATE, when present. Keep it explicit so teachers can judge how
  current the evidence is.

STRIP (do not include any of the following in your output):
- Identifying information about INDIVIDUAL PEOPLE and how to reach or locate
  them: full or partial birth date, birth year, and every chronological-age
  statement (current age, age at assessment, "N-year-old", etc.); home address,
  phone, email, parent / guardian names, names of clinicians or evaluators,
  doctor IDs, and license numbers. Chronology comes exclusively from the
  scholar's authoritative profile DOB, not from this generated summary.
  (Organization and school NAMES are NOT in this list — they are provenance,
  handled by the rule below.)
- Non-educational medical history: allergies, medications, surgeries, family
  medical history, and comorbid medical conditions unrelated to learning.
- Medical-sounding diagnostic detail with no classroom relevance (specific DSM
  codes, clinically-stated autism-spectrum severity levels). Translate anything
  learning-relevant into plain classroom language instead of dropping it.

INSTITUTIONAL PROVENANCE — apply this rule uniformly, with NO school treated
specially (this governs BOTH the teacher and the redacted versions):
- KEEP the name of the school this child attends — ${profile.schoolName} — as
  legitimate provenance. It is NOT redactable PII. Never strip it, and never
  reframe the summary under any other school.
- KEEP the names of any OTHER organizations the document cites (a prior school,
  an evaluating clinic, a testing center, a district). An organization's name is
  institutional provenance, not a personal identifier, and the SAME rule applies
  to every organization, including ${profile.schoolName} — no single school is
  privileged or singled out.
- This does not relax anything above: the names of individual PEOPLE and the
  contact / location details listed under STRIP are still removed.

You must produce TWO audiences' versions of the summary:

A) The TEACHER version ("summary" / "keyFindings") — includes the scores as
   described above, but no birth year, DOB, or age claim.
B) A REDACTED version ("redactedSummary" / "redactedKeyFindings") — the SAME
   pedagogical content, but with EVERY assessment number removed. This version is
   fed to the AI that talks directly to the child, so it must contain NO scores,
   NO percentiles, NO index/standard/scaled numbers, and no numeric ages tied to
   the testing. Describe the same profile and the same gaps purely qualitatively
   (e.g. "verbal reasoning is very superior and sits well above reading and
   spelling, a stealth-dyslexia pattern" — with no numbers). Keep the gap-naming;
   just drop the digits. Do not mention that scores were removed.

OUTPUT FORMAT — respond with valid JSON matching exactly this shape:
{
  "summary": "<TEACHER version: 2-6 paragraphs of prose, no bullets, no headings,
suitable for a teacher skim-read. Refer to the child by first name only or 'the
student'. Include the key scores. If the document shows any gap between cognitive
ability and academic achievement, or any asymmetry across cognitive domains, name
that gap explicitly and cite the relevant scores.>",
  "keyFindings": [
    "<TEACHER version: 3-7 short bullets, each <= 200 chars, each pedagogically
actionable. Include specific scores where they sharpen the point. IMPORTANT: at
least one bullet must name every significant asymmetry or cognitive-vs-academic
gap the document surfaces.>"
  ],
  "redactedSummary": "<REDACTED version of summary: same content and same gap
descriptions, but with EVERY assessment number removed. Purely qualitative.>",
  "redactedKeyFindings": [
    "<REDACTED version of keyFindings: same bullets, number-free.>"
  ]
}

If the document is a brief teacher report, observation, or parent note rather
than a formal assessment, do NOT force an assessment framing — just produce a
faithful summary of it (you may keep close to the original wording) and the
matching number-free redacted version. If it contains no scores or PII, the
redacted version may be nearly identical to the teacher version.

Return ONLY the JSON. No prose before or after. No code fences.
`;
}

// ─── Claude helpers ─────────────────────────────────────────────────────

// Anthropic content-block params we send. Imported lazily inside callClaude so
// this "use node" action doesn't pull the SDK into the analyze bundle until
// invoked (same dynamic-import idiom as observer.ts / sessionTitles.ts).
type ClaudeBlock =
  | { type: "text"; text: string }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    };

async function callClaude(
  ctx: ActionCtx,
  content: ClaudeBlock[],
  maxTokens: number,
  source: string,
  institutionId: Id<"institutions"> | null,
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the env

  const response = await anthropic.messages.create({
    model: docModel(),
    max_tokens: maxTokens,
    // No `temperature`: the current models (Sonnet 5+) reject it ("temperature is
    // deprecated for this model"). The tutor/observer calls omit it for the same
    // reason; extraction/redaction are guided by strict prompts, not temperature.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: "user", content: content as any }],
  });
  await recordAnthropicUsage(ctx, {
    source,
    role: ROLES.TEACHER,
    model: docModel(),
    usage: response.usage,
    institutionId,
  });

  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (!text.trim()) {
    throw new Error(
      `Claude returned empty text (stop_reason: ${response.stop_reason ?? "unknown"})`
    );
  }
  return text;
}

interface RedactionResult {
  summary: string;
  keyFindings: string[];
  redactedSummary: string;
  redactedKeyFindings: string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((x: unknown) => typeof x === "string")
        .map((x: string) => x.trim())
        .filter(Boolean)
    : [];
}

/**
 * Find a chronology claim that must come from the authoritative profile DOB,
 * not generated document prose. Age-equivalent assessment scores are protected:
 * they are test results, not the scholar's chronological age.
 */
export function findChronologicalAgeClaim(text: string): string | null {
  const ageWord =
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
  const ordinalAgeWord =
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth";
  const withoutAgeEquivalentScores = text.replace(
    new RegExp(
      `\\b(?:reading|language|developmental|academic|test)?\\s*age[- ]equivalent(?:\\s+score)?\\s*:?\\s*(?:\\d{1,2}(?:\\s+years?(?:\\s*,?\\s*(?:and\\s+)?\\d{1,2}\\s+months?)?)?|${ageWord})(?:\\s+years?\\s+old|\\s+old)?\\b`,
      "gi",
    ),
    "",
  );
  const patterns = [
    /\b(?:(?:at\s+)?age|aged)\s+\d{1,2}(?:\s+years?(?:\s*,?\s*(?:and\s+)?\d{1,2}\s+months?)?)?\b/i,
    /\b(?:nearly[-\s])?\d{1,2}[-\s]years?[-\s]old\b/i,
    /\b\d{1,2}\s+years?(?:\s*,?\s*(?:and\s+)?\d{1,2}\s+months?)?\s+old\b/i,
    /\b(?:he|she|they|the\s+(?:student|child|scholar|learner))\s+(?:is|was|turned|just\s+turned)\s+\d{1,2}\b/i,
    /\bcurrently\s+\d{1,2}\b/i,
    /\b(?:tested|assessed)\s+at\s+\d{1,2}\s+years?(?:\s*,?\s*(?:and\s+)?\d{1,2}\s+months?)?\b/i,
    /\(?\b(?:b\.|born)\s+(?:in\s+)?(?:19|20)\d{2}\)?/i,
    /\b(?:dob|date\s+of\s+birth)\s*:?\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/i,
    /\bborn\s+on\s+(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/i,
    /\bchronological\s+age\s*:?\s*\d{1,2}\s*[-:]\s*\d{1,2}\b/i,
    /\bCA\s*:?\s*\d{1,2}\s*[-:]\s*\d{1,2}\b/i,
    new RegExp(
      `\\b(?:(?:at\\s+)?age|aged)\\s+(?:${ageWord})\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ageWord})[-\\s]years?[-\\s]old\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:he|she|they|the\\s+(?:student|child|scholar|learner))\\s+(?:is|was|turned|just\\s+turned)\\s+(?:${ageWord})\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:his|her|their)\\s+(?:${ordinalAgeWord})\\s+birthday\\b`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = withoutAgeEquivalentScores.match(pattern);
    if (match) return match[0];
  }
  return null;
}

// Escape raw (unescaped) control characters that appear INSIDE JSON string
// literals. The model occasionally emits a literal newline/tab/carriage-return
// inside a quoted value (e.g. a multi-line finding), which is illegal JSON —
// `JSON.parse` throws "Bad control character in string literal". We only touch
// bytes inside strings, tracking escape state so an already-escaped `\n` (the
// two chars backslash+n) is left alone. Used as a parse fallback, so valid
// payloads are never rewritten.
export function escapeControlCharsInStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const code = input.charCodeAt(i);
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (code < 0x20) {
        // Raw control char inside a string → escape it.
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
    } else {
      out += ch;
      if (ch === '"') inString = true;
    }
  }
  return out;
}

export function parseRedactionJson(raw: string): RedactionResult {
  // Strip accidental code fences.
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  let parsed: { summary?: unknown; keyFindings?: unknown; redactedSummary?: unknown; redactedKeyFindings?: unknown };
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Common LLM slip: a raw control character (unescaped newline/tab) inside a
    // string literal. Repair only string-interior control chars and retry —
    // still throws if the JSON is broken for any other reason.
    if (err instanceof SyntaxError) {
      parsed = JSON.parse(escapeControlCharsInStrings(cleaned));
    } else {
      throw err;
    }
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary : "";
  const keyFindings = asStringArray(parsed.keyFindings);
  if (!summary) {
    throw new Error("Redaction response missing `summary`");
  }
  // The redacted (number-free) variant must exist — it's what feeds the
  // scholar-facing tutor. Fail loudly rather than silently fall back to the
  // score-bearing text.
  const redactedSummary =
    typeof parsed.redactedSummary === "string" ? parsed.redactedSummary : "";
  if (!redactedSummary) {
    throw new Error("Redaction response missing `redactedSummary`");
  }
  const redactedKeyFindings = asStringArray(parsed.redactedKeyFindings);
  for (const [field, values] of [
    ["summary", [summary]],
    ["keyFindings", keyFindings],
    ["redactedSummary", [redactedSummary]],
    ["redactedKeyFindings", redactedKeyFindings],
  ] as const) {
    for (const value of values) {
      const claim = findChronologicalAgeClaim(value);
      if (claim) {
        throw new Error(
          `Redaction response included non-authoritative chronology in ${field}: ${JSON.stringify(claim)}`,
        );
      }
    }
  }
  return { summary, keyFindings, redactedSummary, redactedKeyFindings };
}

// ─── Main action ────────────────────────────────────────────────────────

export const extractAndRedact = internalAction({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    console.log(
      `[scholarDocs.extractAndRedact] documentId=${args.documentId}`
    );

    const doc = await ctx.runQuery(
      internal.scholarDocuments.aiGetDocument,
      { documentId: args.documentId }
    );
    if (!doc) {
      console.error(`[scholarDocs] doc not found: ${args.documentId}`);
      return null;
    }
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: doc.scholarId, principal: "scholar" },
    );
    // Resolve the scholar's OWN institution identity so the redaction prompt
    // preserves it as provenance instead of the old hardcoded primary frame.
    const institutionProfile = await ctx.runQuery(
      internal.scholarDocuments.aiInstitutionProfileForScholar,
      { scholarId: doc.scholarId },
    );

    if (!process.env.ANTHROPIC_API_KEY) {
      await ctx.runMutation(
        internal.scholarDocuments.aiPatchProcessingStatus,
        {
          documentId: args.documentId,
          status: "error",
          error: "ANTHROPIC_API_KEY not set on this deployment",
        }
      );
      return null;
    }

    try {
      // ── Step 1: extract text (skip if we were handed pre-populated text) ──
      let extractedText = doc.extractedText ?? "";

      if (!extractedText) {
        if (!doc.fileStorageId) {
          throw new Error(
            "Document has neither extractedText nor fileStorageId"
          );
        }

        await ctx.runMutation(
          internal.scholarDocuments.aiPatchProcessingStatus,
          { documentId: args.documentId, status: "extracting" }
        );

        const blob = await ctx.storage.get(doc.fileStorageId);
        if (!blob) throw new Error("Storage blob missing");

        const bytes = new Uint8Array(await blob.arrayBuffer());
        const mimeType = doc.fileMimeType ?? "application/pdf";
        console.log(
          `[scholarDocs] Claude extract — ${bytes.byteLength} bytes, mime=${mimeType}`
        );

        extractedText = await extractTextWithClaude(ctx, {
          bytes,
          mimeType,
          model: docModel(),
          usageSource: "scholar-document-extract",
        });

        await ctx.runMutation(
          internal.scholarDocuments.aiPatchExtractedText,
          { documentId: args.documentId, text: extractedText }
        );
      }

      // ── Step 2: redact ────────────────────────────────────────────────
      await ctx.runMutation(
        internal.scholarDocuments.aiPatchProcessingStatus,
        { documentId: args.documentId, status: "redacting" }
      );

      console.log(
        `[scholarDocs] Claude redact — ${extractedText.length} chars`
      );

      const redactionRaw = await callClaude(
        ctx,
        [
          { type: "text", text: buildRedactionPrompt(institutionProfile) },
          { type: "text", text: `\n\n--- DOCUMENT TEXT ---\n\n${extractedText}` },
        ],
        // Emits two summaries + two bullet lists, so allow more headroom.
        8192,
        "scholar-document-redact",
        institutionId,
      );

      const { summary, keyFindings, redactedSummary, redactedKeyFindings } =
        parseRedactionJson(redactionRaw);

      await ctx.runMutation(
        internal.scholarDocuments.aiPatchRedactedSummary,
        {
          documentId: args.documentId,
          summary,
          keyFindings,
          redactedSummary,
          redactedKeyFindings,
        }
      );

      // ── Step 3: retention policy ─────────────────────────────────────
      const retention = process.env.DOCUMENT_RETENTION_POLICY ?? "keep";
      if (retention === "purge_after_redaction") {
        console.log(
          `[scholarDocs] DOCUMENT_RETENTION_POLICY=purge_after_redaction → deleting storage file`
        );
        await ctx.runMutation(
          internal.scholarDocuments.aiPurgeFile,
          { documentId: args.documentId }
        );
      }

      // ── Step 4: done ─────────────────────────────────────────────────
      await ctx.runMutation(
        internal.scholarDocuments.aiPatchProcessingStatus,
        { documentId: args.documentId, status: "ready" }
      );

      console.log(
        `[scholarDocs] ✅ ready — summary=${summary.length} chars, ${keyFindings.length} key findings`
      );
      return { ok: true, keyFindings };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scholarDocs] FAILED: ${message}`);
      await ctx.runMutation(
        internal.scholarDocuments.aiPatchProcessingStatus,
        {
          documentId: args.documentId,
          status: "error",
          error: message.slice(0, 500),
        }
      );
      return { ok: false, error: message };
    }
  },
});
