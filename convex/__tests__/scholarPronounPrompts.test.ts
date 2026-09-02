import { describe, expect, test } from "vitest";
import {
  CLOSURE_PROMPT_VERSION,
  CLOSURE_SYSTEM,
} from "../lib/closureLinePrompt";
import { buildTeachBackGradingPrompt } from "../lib/teachBack";
import { ARTIFACT_GRANULE_SYSTEM_PROMPT } from "../granuleAssessment";
import { READING_LEVEL_SYSTEM_PROMPT } from "../readingLevelAnalysis";
import { WEB_SUMMARY_SYSTEM } from "../lib/webSessionSummary";
import { buildGoogleCommentAidePrompt } from "../lib/googleDocsCommentReply";
import { SCHOLAR_PRONOUN_GUIDANCE } from "../lib/scholarPronouns";
import { DIALOGUE_JUDGE_SYSTEM } from "../lib/practice/dialogueStretch";

describe("scholar-pronoun guidance across generated summaries", () => {
  test("invalidates cached closure lines and governs new third-person lines", () => {
    expect(CLOSURE_PROMPT_VERSION).toBe("closure-line-v3-2026-08-20");
    expect(CLOSURE_SYSTEM).toContain(SCHOLAR_PRONOUN_GUIDANCE);
  });

  test("governs teach-back, artifact, reading-level, and web summaries", () => {
    expect(
      buildTeachBackGradingPrompt({
        conceptLabel: "Test concept",
        transcript: "Scholar: Test explanation",
      }).system,
    ).toContain(SCHOLAR_PRONOUN_GUIDANCE);
    expect(ARTIFACT_GRANULE_SYSTEM_PROMPT).toContain(
      SCHOLAR_PRONOUN_GUIDANCE,
    );
    expect(READING_LEVEL_SYSTEM_PROMPT).toContain(SCHOLAR_PRONOUN_GUIDANCE);
    expect(WEB_SUMMARY_SYSTEM).toContain(SCHOLAR_PRONOUN_GUIDANCE);
    expect(DIALOGUE_JUDGE_SYSTEM).toContain(SCHOLAR_PRONOUN_GUIDANCE);
  });

  test("governs Google Docs staff-aide replies", () => {
    const prompt = buildGoogleCommentAidePrompt({
      documentTitle: "Test document",
      quotedText: "",
      thread: "",
      documentBody: "",
      triggerText: "Summarize this scholar's work",
      triggerAuthor: "Test teacher",
    });
    expect(prompt.system).toContain(SCHOLAR_PRONOUN_GUIDANCE);
  });
});
