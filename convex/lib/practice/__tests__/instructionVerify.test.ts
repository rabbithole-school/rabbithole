import { describe, expect, test } from "vitest";
import {
  MAX_TITLE,
  verifyInstructionContent,
  type VerifyAtom,
  type VerifyInput,
} from "../instructionVerify";
import type {
  MultiStepSequenceSpec,
  NumberLineSpec,
} from "../../../../lib/manipulative/types";

// Why this file: the verifier is the ONLY gate between generated/authored
// Launchpad content and a child's screen (generate → verify → store; only
// `passed` is ever served). It must accept genuinely good content and reject
// every failure mode the review flagged: empty/oversized content, answer-dumping
// framing, parasocial/mascot voice, and a worked example that isn't self-contained.

const goodExample: VerifyAtom = {
  kind: "worked_example",
  strategyLabel: "Fill up to ten, then add the rest",
  steps: ["Start with 8 + 5.", "Take 2 from the 5 to make 8 into 10.", "That leaves 3.", "Now 10 + 3 = 13."],
  examplePrompt: "Use make-a-ten to add 8 + 5.",
  exampleAnswer: "13",
};

const goodInput: VerifyInput = {
  title: "Make a ten to add",
  subtitle: "Turn a hard fact into an easy one",
  atoms: [
    { kind: "story_hook", hook: "Your hands hold ten fingers for a reason — ten is the number our counting leans on." },
    { kind: "micro_explain", text: "To add near ten, borrow enough to complete a ten, then add what is left. Ten-plus-something is always easy." },
    goodExample,
  ],
};

const goodTryIt: VerifyAtom = {
  kind: "try_it",
  strategyLabel: "Make the same jump",
  steps: ["Start at 4.", "Jump forward 3.", "Land on 7."],
  examplePrompt: "What is 4 + 3?",
  exampleAnswer: "7",
};

const goodVideo: VerifyAtom = {
  kind: "video",
  provider: "youtube",
  videoId: "dQw4w9WgXcQ",
  startSec: 30,
  endSec: 150,
  captionText: "Watch the jump, then make the same move yourself.",
  sourceLabel: "Khan Academy: Adding on a number line",
  sourceUrl: "https://www.khanacademy.org/math/example",
};

const numberLineStep: NumberLineSpec = {
  kind: "numberline",
  id: "instruction-numberline",
  concept: "Number sense",
  prompt: "Put the point on 5.",
  min: 0,
  max: 10,
  tickStep: 1,
  start: 1,
  goal: { type: "placeAt", value: 5 },
};

const goodSequence: MultiStepSequenceSpec = {
  id: "instruction-sequence",
  concept: "Number sense",
  title: "Build toward five",
  steps: [
    numberLineStep,
    {
      ...numberLineStep,
      id: "instruction-numberline-2",
      prompt: "Now put the point on 7.",
      goal: { type: "placeAt", value: 7 },
    },
  ],
};

describe("verifyInstructionContent — accepts good content", () => {
  test("a well-formed hook + explain + worked example passes", () => {
    const r = verifyInstructionContent(goodInput);
    expect(r.status).toBe("passed");
    expect(r.issues).toEqual([]);
  });

  test("a worked example's own numeric answer is NOT treated as answer-dumping", () => {
    // "13" appears as the exampleAnswer AND is derived in the steps — legitimate,
    // because the example is decoupled from any live item.
    const r = verifyInstructionContent({ title: "T", atoms: [goodExample] });
    expect(r.status).toBe("passed");
  });

  test("a manipulative sequence passes when every step clears the single-spec gate", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ kind: "manipulative", spec: JSON.stringify(goodSequence) }],
    });
    expect(r.status).toBe("passed");
    expect(r.issues).toEqual([]);
  });

  test("a clipped video followed by try_it passes", () => {
    const r = verifyInstructionContent({ title: "T", atoms: [goodVideo, goodTryIt] });
    expect(r.status).toBe("passed");
    expect(r.issues).toEqual([]);
  });

  test("a 360-second clip passes", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ ...goodVideo, startSec: 10, endSec: 370 }, goodTryIt],
    });
    expect(r.status).toBe("passed");
    expect(r.issues).toEqual([]);
  });
});

describe("verifyInstructionContent — rejects bad content", () => {
  test("empty atoms fail (a Launchpad must teach something)", () => {
    const r = verifyInstructionContent({ title: "T", atoms: [] });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/atoms is empty/);
  });

  test("only a story hook (no teaching atom) fails", () => {
    const r = verifyInstructionContent({ title: "T", atoms: [{ kind: "story_hook", hook: "A nice story." }] });
    expect(r.status).toBe("failed");
    // Show-me now accepts a worked_example, try_it, or manipulative — a story
    // alone still fails both the teaching-atom and show-the-move guards.
    expect(r.issues.join(" ")).toMatch(/no show-the-move atom/);
    expect(r.issues.join(" ")).toMatch(/no teaching atom/);
  });

  test("answer-dumping framing in a micro_explain fails", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ kind: "micro_explain", text: "The answer is always the bigger number." }, goodExample],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/answer-dumping/);
  });

  test("parasocial voice fails", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ kind: "micro_explain", text: "I'm your friend and we'll do this together." }, goodExample],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/parasocial/);
  });

  test("emoji in a hook fails (anti-parasocial)", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ kind: "story_hook", hook: "Counting is fun 🎉" }, goodExample],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/parasocial/);
  });

  test("a worked example with no steps and an ungrounded answer is not self-contained", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [
        {
          kind: "worked_example",
          strategyLabel: "Guess",
          steps: [],
          examplePrompt: "What is a hard thing?",
          exampleAnswer: "42",
        },
      ],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/no steps|not self-contained/);
  });

  test("an over-long title fails", () => {
    const r = verifyInstructionContent({ title: "x".repeat(MAX_TITLE + 1), atoms: [goodExample] });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/title exceeds/);
  });

  // A goal-less step is an EXPLORE rung ("play with it — notice what changes"),
  // which is the concrete opening of a guided teaching sequence. It is
  // ungradable by construction (every `*Solved` predicate returns false without
  // a goal) and the renderer advances past it without a check, so the verifier
  // must ACCEPT it rather than making the CRA warm-up unauthorable.
  test("a goal-less explore step inside a sequence passes", () => {
    const withExploreOpening: MultiStepSequenceSpec = {
      ...goodSequence,
      steps: [
        { ...numberLineStep, id: "explore-step", prompt: "Slide it around.", goal: undefined },
        numberLineStep,
      ],
    };
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ kind: "manipulative", spec: JSON.stringify(withExploreOpening) }],
    });
    expect(r.status).toBe("passed");
  });

  // The relaxation is scoped to steps with NO goal. A step that IS a challenge
  // (it carries a goal) must still be gradable, so a directed rung can never be
  // silently unsolvable — and the failure still names its index.
  test("a sequence step with an unusable goal still fails and names its index", () => {
    const badSequence = {
      ...goodSequence,
      steps: [
        numberLineStep,
        // Carries a goal (so `isChallenge` is true, and the relaxation does NOT
        // apply) but the goal shape is not one `isSolved` can ever satisfy.
        { ...numberLineStep, id: "bad-goal-step", goal: { type: "notARealGoal" } },
      ],
    } as unknown as MultiStepSequenceSpec;
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ kind: "manipulative", spec: JSON.stringify(badSequence) }],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/steps\[1\]/);
  });

  // A goal-less SINGLE manipulative atom is unchanged — it has no sequence to
  // advance through, so an ungradable instance there is still a toy with no
  // completion signal, and still fails.
  test("a goal-less single manipulative atom still fails", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [
        { kind: "manipulative", spec: JSON.stringify({ ...numberLineStep, goal: undefined }) },
      ],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/Ungradable manipulative/);
  });

  test("a malformed sequence step fails and names its index", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [
        {
          kind: "manipulative",
          spec: JSON.stringify({
            ...goodSequence,
            steps: [numberLineStep, { id: "missing-kind" }],
          }),
        },
      ],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/steps\[1\].*not valid ManipulativeSpec/);
  });

  test("an empty manipulative sequence fails", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [
        {
          kind: "manipulative",
          spec: JSON.stringify({ ...goodSequence, steps: [] }),
        },
      ],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(/sequence has no steps/);
  });

  test("a video with no following do atom fails and names its index", () => {
    const r = verifyInstructionContent({ title: "T", atoms: [goodVideo] });
    expect(r.status).toBe("failed");
    expect(r.issues).toEqual([
      "atom[0] (video): video must be followed by a try_it or manipulative atom",
    ]);
  });

  test("a do atom before the video does not satisfy do-after", () => {
    const r = verifyInstructionContent({ title: "T", atoms: [goodTryIt, goodVideo] });
    expect(r.status).toBe("failed");
    expect(r.issues).toContain(
      "atom[1] (video): video must be followed by a try_it or manipulative atom",
    );
  });

  test("a 361-second clip fails and names its index", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ ...goodVideo, startSec: 10, endSec: 371 }, goodTryIt],
    });
    expect(r.status).toBe("failed");
    expect(r.issues).toContain("atom[0] (video): clip exceeds 360 seconds");
  });

  test.each([
    ["missing startSec", { ...goodVideo, startSec: undefined }],
    ["missing endSec", { ...goodVideo, endSec: undefined }],
    ["negative startSec", { ...goodVideo, startSec: -1 }],
    ["equal bounds", { ...goodVideo, startSec: 30, endSec: 30 }],
    ["inverted bounds", { ...goodVideo, startSec: 31, endSec: 30 }],
  ])("%s fails and names the video atom index", (_name, video) => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [video as unknown as VerifyAtom, goodTryIt],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.some((issue) => issue.startsWith("atom[0] (video):"))).toBe(true);
  });

  test("an implausible YouTube videoId fails", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ ...goodVideo, videoId: "too-short" }, goodTryIt],
    });
    expect(r.status).toBe("failed");
    expect(r.issues).toContain(
      "atom[0] (video): videoId must be an 11-character YouTube id",
    );
  });

  test("a non-https sourceUrl fails", () => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [{ ...goodVideo, sourceUrl: "http://www.khanacademy.org/math/example" }, goodTryIt],
    });
    expect(r.status).toBe("failed");
    expect(r.issues).toContain("atom[0] (video): sourceUrl must be an https URL");
  });

  test.each([
    ["empty captionText", { ...goodVideo, captionText: "" }, /captionText is empty/],
    [
      "overlong captionText",
      { ...goodVideo, captionText: "x".repeat(321) },
      /captionText exceeds 320 chars/,
    ],
    ["empty sourceLabel", { ...goodVideo, sourceLabel: "" }, /sourceLabel is empty/],
    [
      "overlong sourceLabel",
      { ...goodVideo, sourceLabel: "x".repeat(MAX_TITLE + 1) },
      new RegExp(`sourceLabel exceeds ${MAX_TITLE} chars`),
    ],
  ])("%s fails within existing text limits", (_name, video, issue) => {
    const r = verifyInstructionContent({
      title: "T",
      atoms: [video as VerifyAtom, goodTryIt],
    });
    expect(r.status).toBe("failed");
    expect(r.issues.join(" ")).toMatch(issue);
  });
});
