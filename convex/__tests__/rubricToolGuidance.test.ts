import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../sessionHelpers";

// Moment F (review/experiment-detective-tutor-audit.html): a tutor pressed on
// a rubric criterion, dropped the thread when the scholar couldn't answer,
// then later awarded that criterion full credit purely because the final
// artifact looked textually complete. These tests guard the fix: the
// unanswered-probe clause must reach the tutor through BOTH rubric flavors —
// the document/deliverable rubric (`update_rubric_score` scoring a submitted
// artifact) and the conversation "ready to advance" rubric (scoring the
// discussion itself, no artifact) — since both share the same tool and the
// same failure mode. It must NOT appear once an activity is already marked
// complete (that branch returns its own narrower "don't re-announce
// completion" guidance instead).

const UNANSWERED_PROBE_MARKER = "Mandatory check before marking ANY criterion";
const NO_FORCED_WAIT_MARKER =
  'Do NOT say "next time," "when you come back," or otherwise imply they must wait';

function build(opts: {
  standaloneDeliverableContext?: Parameters<typeof buildSystemPrompt>[19];
  advanceRubricContext?: Parameters<typeof buildSystemPrompt>[30];
}) {
  return buildSystemPrompt(
    null, null, "Kai", // 1-3
    null, null, null, null, null, null, null, null, // 4-11
    null, null, null, // 12-14
    null, null, null, null, null, // 15-19
    opts.standaloneDeliverableContext ?? null, // 20
    null, // 21 currentVerdictsContext
    false, false, null, // 22-24
    null, null, null, null, null, null, // 25-30
    opts.advanceRubricContext ?? null, // 31
  );
}

describe("rubric-tool guidance — unanswered probes (Moment F)", () => {
  test("document rubric: carries the unanswered-probe clause", () => {
    const prompt = build({
      standaloneDeliverableContext: {
        activityTitle: "Experiment Detective",
        prompt: "Write up the flaw, the fix, and how you'd measure it.",
        rubric:
          "1. [flaw-id] Identifies the one-variable-at-a-time violation\n2. [measurement] Describes a concrete way to measure the outcome",
        kind: "text",
        isComplete: false,
      },
    });
    expect(prompt).toContain(UNANSWERED_PROBE_MARKER);
    expect(prompt).toContain(
      "an explicitly dodged probe",
    );
    expect(prompt).toContain(
      "The artifact alone cannot close it, even if it contains a polished matching answer",
    );
    expect(prompt).toContain(
      "your reply must bring back the SAME unresolved question",
    );
    expect(prompt).toContain(
      "only after a later scholar turn works through that question in their own words",
    );
    expect(prompt).toContain(
      "there's nothing to check — judge it normally from what they've written or said",
    );
  });

  test("document rubric: already-complete branch omits the clause (narrower guidance instead)", () => {
    const prompt = build({
      standaloneDeliverableContext: {
        activityTitle: "Experiment Detective",
        prompt: "Write up the flaw, the fix, and how you'd measure it.",
        rubric: "1. [flaw-id] Identifies the flaw",
        kind: "text",
        isComplete: true,
      },
    });
    expect(prompt).not.toContain(UNANSWERED_PROBE_MARKER);
    expect(prompt).toContain("This activity is already complete");
  });

  test("conversation ready-to-advance rubric: carries the same unanswered-probe clause", () => {
    const prompt = build({
      advanceRubricContext: {
        activityTitle: "Discuss the design flaw",
        rubric: "1. [flaw-id] Names the flaw\n2. [measurement] Explains how to measure it",
        currentVerdicts: null,
        isComplete: false,
      },
    });
    expect(prompt).toContain(UNANSWERED_PROBE_MARKER);
    expect(prompt).toContain(
      "On that submission turn, the verdict MUST remain `half`/`not`",
    );
    expect(prompt).toContain(NO_FORCED_WAIT_MARKER);
    expect(prompt).toContain(
      "The app writes the scholar-facing completion close",
    );
    expect(prompt).toContain(
      "must not add a preface, assessment, recap, praise, question, task, or second closing",
    );
  });

  test("conversation rubric: already-complete branch omits the clause", () => {
    const prompt = build({
      advanceRubricContext: {
        activityTitle: "Discuss the design flaw",
        rubric: "1. [flaw-id] Names the flaw",
        currentVerdicts: [{ criterionId: "flaw-id", level: "full" }],
        isComplete: true,
      },
    });
    expect(prompt).not.toContain(UNANSWERED_PROBE_MARKER);
    expect(prompt).toContain("This activity is already complete");
  });

  test("clause is explicitly conditional — does not require conversational evidence for every criterion", () => {
    // Guards against an earlier draft's "find the specific moment... not in
    // the final artifact" framing, which read as requiring live
    // conversational demonstration for EVERY criterion — an overreach beyond
    // Moment F's narrow "unanswered probe" scope that would have broken the
    // ordinary "score from what they've written" path RUBRIC_TOOL_GUIDANCE
    // already allows for criteria the tutor never happened to probe.
    const prompt = build({
      standaloneDeliverableContext: {
        activityTitle: "Experiment Detective",
        prompt: "Write up the flaw, the fix, and how you'd measure it.",
        rubric: "1. [flaw-id] Identifies the flaw",
        kind: "text",
        isComplete: false,
      },
    });
    expect(prompt).toContain(
      "there's nothing to check — judge it normally from what they've written or said",
    );
    expect(prompt).toContain("You're confident a criterion is now met");
    expect(prompt).toContain(NO_FORCED_WAIT_MARKER);
  });
});
