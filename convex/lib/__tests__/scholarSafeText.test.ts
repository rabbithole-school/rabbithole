import { describe, expect, test } from "vitest";
import {
  createScholarVisibleTextFilter,
  isMachineFacingTextSegment,
  sanitizeScholarVisibleText,
} from "../scholarSafeText";
import { stripMarkdownFormatting } from "../practice/plainText";

describe("scholarSafeText", () => {
  const legitTutorSentences = [
    "I won't answer that for you — what do you think they represent?",
    "I'll wait while you think about what they mean.",
    "I'll ask you what they were thinking when they wrote this.",
    "I'll explain how they migrate south, but first, what do you notice?",
    "I'll answer your question after you tell me what they have in common.",
    "I need to ask you something: why do you think they chose that path?",
    "I'll check your work once you've labeled them all.",
    "Analysis: let's break down what the poem is doing.",
    "Reasoning: start by finding the pattern.",
    "I'll wait for your answer before we try the next clue.",
    "Let's use their strategy on our own problem.",
    // Structural-signature false positives caught in cross-family re-review:
    // math coordinates / parentheticals that start a sentence must not read as
    // a stack frame, and an English "Exception:" rule must not read as an error.
    "At point (2, 3), what do you notice about the line?",
    "At noon (roughly), the sun is highest — why?",
    "Exception: words ending in a silent -e drop it before -ing.",
  ];

  test("keeps the reviewer's legitimate Socratic/wait-time sentence suite", () => {
    for (const sentence of legitTutorSentences) {
      expect(isMachineFacingTextSegment(sentence), sentence).toBe(false);
      expect(sanitizeScholarVisibleText(sentence), sentence).toBe(sentence);
    }
  });

  test("removes third-person scratch-pad planning lines", () => {
    const raw =
      "Nice observation.\n" +
      "I'll wait for their answer before addressing the 'why' question they asked.\n" +
      "Now look at the next clue.";

    const safe = sanitizeScholarVisibleText(raw);
    expect(safe).toContain("Nice observation.");
    expect(safe).toContain("Now look at the next clue.");
    expect(safe).not.toMatch(/their answer|why.*question they asked/i);
  });

  test("removes machine-shaped internal markers but keeps normal analysis/reasoning copy", () => {
    expect(isMachineFacingTextSegment("Internal reasoning: choose the next tool.")).toBe(true);
    expect(isMachineFacingTextSegment("Scratchpad: call edit_document next.")).toBe(true);
    expect(sanitizeScholarVisibleText("Internal reasoning: hidden plan.\nTry this step.")).toBe("Try this step.");
    expect(sanitizeScholarVisibleText("Analysis: hidden plan.\nTry this step.")).toBe(
      "Analysis: hidden plan.\nTry this step.",
    );
  });

  test("removes internal markers after plain-text formatting is normalized", () => {
    const raw = "**Internal reasoning:** hidden plan.\nTry this step.";
    expect(sanitizeScholarVisibleText(stripMarkdownFormatting(raw))).toBe(
      "Try this step.",
    );
  });

  test("removes raw answer indices, error strings, stack traces, and protocol fragments", () => {
    const raw =
      "The answer was choice 0.\n" +
      "Error: old_str not found in document.\n" +
      "TypeError: Cannot read properties of undefined.\n" +
      "    at runTool (convex/http.ts:100:3)\n" +
      '{"type":"tool_use","name":"edit_document"}\n' +
      "content_block_delta: text_delta\n" +
      "Try this step.";

    const safe = sanitizeScholarVisibleText(raw);
    expect(safe).toBe("Try this step.");
  });

  test("streaming filter buffers until a full sentence so scratch text never flashes", () => {
    const filter = createScholarVisibleTextFilter();
    expect(filter.push("I'll wait for their answer")).toBe("");
    expect(filter.push(" before addressing the 'why' question they asked.")).toBe("");
    expect(filter.push(" Good next step.")).toBe(" Good next step.");
    expect(filter.finish()).toBe("");
  });
});
