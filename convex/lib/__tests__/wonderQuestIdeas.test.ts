// The Quest ideas under a day's wonder (TRA-697), pure parts: the evidence
// rule (two of four, data first), at most two ideas, nothing question-shaped,
// who gets a model call at all, and the message after a tap. The prompt's
// wording is not tested here; its quality is the prompt eval's job.

import { describe, expect, test } from "vitest";
import {
  acceptIdeas,
  candidatesForModel,
  computedEvidence,
  ideaBlocks,
  ideaButtonText,
  isQuestionShaped,
  ideaStamp,
  renderIdeasUserMessage,
  PROMPT_CHARS_MAX,
  MAKING_LINES_MAX,
  MAKING_LABEL_MAX,
  WONDERS_PER_CALL_MAX,
  type IdeaCandidate,
} from "../wonderQuestIdeas";

function wonder(over: Partial<IdeaCandidate> = {}): IdeaCandidate {
  return {
    seedId: "seed1",
    question: "How do crocodiles bite so hard?",
    reply: "Their jaw muscles are built to snap shut.",
    followUps: [],
    followUpCount: 0,
    cameBack: false,
    ...over,
  };
}

const IDEA = {
  wonderId: "seed1",
  kind: "app",
  mission: "Help a 2nd grader see how a croc's jaw angle changes its bite.",
  title: "Croc jaw angles",
};
const judged = (open: boolean, connects: boolean, id = "seed1") => ({
  wonderId: id,
  open_testable_or_buildable: open,
  connects_to_their_making: connects,
  reasons: "because",
});

describe("the evidence rule", () => {
  test("counts what the data shows: a return another day, three or more follow-ups", () => {
    expect(computedEvidence(wonder())).toBe(0);
    expect(computedEvidence(wonder({ followUpCount: 2 }))).toBe(0);
    expect(computedEvidence(wonder({ followUpCount: 3 }))).toBe(1);
    expect(computedEvidence(wonder({ cameBack: true }))).toBe(1);
    expect(computedEvidence(wonder({ cameBack: true, followUpCount: 5 }))).toBe(2);
  });

  test("two of four: one from data plus one judged holds, one alone does not", () => {
    const strong = wonder({ followUpCount: 4 });
    const asked = (open: boolean, connects: boolean) =>
      acceptIdeas({ judgments: [judged(open, connects)], ideas: [IDEA] }, [strong], true);
    expect(asked(true, false)).toHaveLength(1);
    expect(asked(false, true)).toHaveLength(1);
    expect(asked(false, false)).toHaveLength(0);
  });

  test("with nothing from data, both judged items must hold", () => {
    const bare = wonder();
    const asked = (open: boolean, connects: boolean) =>
      acceptIdeas({ judgments: [judged(open, connects)], ideas: [IDEA] }, [bare], true);
    expect(asked(true, false)).toHaveLength(0);
    expect(asked(false, true)).toHaveLength(0);
    expect(asked(true, true)).toHaveLength(1);
  });

  test("the model cannot raise the data's count: an idea with no judgment is dropped", () => {
    expect(
      acceptIdeas({ judgments: [], ideas: [IDEA] }, [wonder({ followUpCount: 9, cameBack: true })], true),
    ).toEqual([]);
  });

  test("an idea on a wonder that was never asked about is dropped", () => {
    expect(
      acceptIdeas(
        { judgments: [judged(true, true, "other")], ideas: [{ ...IDEA, wonderId: "other" }] },
        [wonder()],
        true,
      ),
    ).toEqual([]);
  });

  test("keeps the evidence it stood on", () => {
    const [idea] = acceptIdeas({ judgments: [judged(true, false)], ideas: [IDEA] }, [
      wonder({ followUpCount: 3 }),
    ], true);
    expect(idea?.evidence).toEqual({ cameBack: false, followUps: 3, open: true, connects: false });
  });
});

describe("who is asked", () => {
  test("no wonder with data evidence and no work to connect to: no call", () => {
    expect(candidatesForModel([wonder(), wonder({ seedId: "b" })], false)).toEqual([]);
  });

  test("a wonder with data evidence is asked about; with work to connect to, any is", () => {
    const strong = wonder({ seedId: "s", followUpCount: 3 });
    const bare = wonder({ seedId: "b" });
    expect(candidatesForModel([strong, bare], false)).toEqual([strong]);
    expect(candidatesForModel([strong, bare], true)).toEqual([strong, bare]);
  });
});

describe("what an idea may be", () => {
  const strong = wonder({ followUpCount: 3 });
  const run = (idea: Record<string, unknown>) =>
    acceptIdeas({ judgments: [judged(true, true)], ideas: [{ ...IDEA, ...idea }] }, [strong], true);

  test("question-shaped words are recognized", () => {
    for (const q of [
      "Why do owls turn their heads?",
      "How owls turn their heads",
      "Can owls see in the dark",
      "what is a prime",
    ]) {
      expect(isQuestionShaped(q), q).toBe(true);
    }
    for (const ok of ["Owl neck explorer", "Show a 2nd grader how owls turn their heads."]) {
      expect(isQuestionShaped(ok), ok).toBe(false);
    }
  });

  test("a question as the title or the mission is never an idea", () => {
    expect(run({ title: "Why do owls turn?" })).toEqual([]);
    expect(run({ mission: "How can a 2nd grader learn angles?" })).toEqual([]);
    expect(run({ title: "How owls turn" })).toEqual([]);
  });

  test("an unknown kind, an empty or overlong mission or title is dropped", () => {
    expect(run({ kind: "video" })).toEqual([]);
    expect(run({ mission: "  " })).toEqual([]);
    expect(run({ mission: "x".repeat(141) })).toEqual([]);
    expect(run({ title: "x".repeat(81) })).toEqual([]);
  });

  test("at most two per kid, in order, and a near-copy does not take the second place", () => {
    const ideas = [
      IDEA,
      { ...IDEA, title: "Copy", mission: "Show it again for a 2nd grader." },
      { ...IDEA, kind: "slides", title: "Jaw talk", mission: "Teach the class how jaws work." },
      { ...IDEA, kind: "python", title: "Jaw sim", mission: "Let a friend test bite forces." },
    ];
    const got = acceptIdeas({ judgments: [judged(true, true)], ideas }, [strong], true);
    expect(got.map((i) => i.kind)).toEqual(["app", "slides"]);
  });

  test("garbage from the model is no ideas", () => {
    expect(acceptIdeas(undefined, [strong], true)).toEqual([]);
    expect(acceptIdeas({ judgments: "x", ideas: 3 }, [strong], true)).toEqual([]);
  });
});

describe("the making evidence", () => {
  const strong = wonder({ followUpCount: 3 });
  test("with no work to connect to, the model's 'connects' counts for nothing", () => {
    const raw = { judgments: [judged(false, true)], ideas: [IDEA] };
    expect(acceptIdeas(raw, [strong], false)).toEqual([]);
    expect(acceptIdeas(raw, [strong], true)).toHaveLength(1);
    const [idea] = acceptIdeas({ judgments: [judged(true, true)], ideas: [IDEA] }, [strong], false);
    expect(idea?.evidence.connects).toBe(false);
  });
});

describe("what one call reads is bounded", () => {
  test("a huge title or reply cannot inflate the prompt", () => {
    const huge = "x".repeat(300_000);
    const message = renderIdeasUserMessage({
      firstName: huge,
      making: Array.from({ length: 50 }, () => `Chat: ${huge}`),
      wonders: Array.from({ length: 40 }, (_, i) =>
        wonder({
          seedId: `s${i}`,
          question: huge,
          reply: huge,
          followUps: Array.from({ length: 30 }, () => huge),
          followUpCount: 30,
        }),
      ),
    });
    expect(message.length).toBeLessThanOrEqual(PROMPT_CHARS_MAX);
    const lines = message.split("\n").filter((l) => l.startsWith("- Chat:"));
    expect(lines.length).toBeLessThanOrEqual(MAKING_LINES_MAX);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(MAKING_LABEL_MAX + 10);
    expect(message.match(/^Wonder /gm)?.length ?? 0).toBeLessThanOrEqual(WONDERS_PER_CALL_MAX);
  });
});

describe("the buttons and the post", () => {
  const ideas = [
    { ideaId: "i0", position: 0, kind: "app" as const, title: "Croc jaw angles", mission: "Help a 2nd grader see <jaw> angles & bites." },
    { ideaId: "i1", position: 1, kind: "slides" as const, title: "Jaw talk", mission: "Teach the class how jaws work." },
  ];

  test("a button per idea, its value only the idea's id", () => {
    const { blocks } = ideaBlocks(ideas, "Kai");
    const actions = blocks.find((b) => (b as { type: string }).type === "actions") as {
      elements: { action_id: string; value: string; text: { text: string } }[];
    };
    expect(actions.elements.map((e) => [e.action_id, e.value, e.text.text])).toEqual([
      ["qidea:offer:0", "i0", "Offer an app: Croc jaw angles"],
      ["qidea:offer:1", "i1", "Offer a presentation: Jaw talk"],
    ]);
  });

  test("the teacher reads each mission, escaped, before tapping", () => {
    const { blocks, lines } = ideaBlocks(ideas, "Kai");
    const section = blocks[0] as { type: string; text: { text: string } };
    expect(section.type).toBe("section");
    expect(section.text.text).toBe(
      "Offer an app: Croc jaw angles — Help a 2nd grader see &lt;jaw&gt; angles &amp; bites.\n" +
        "Offer a presentation: Jaw talk — Teach the class how jaws work.",
    );
    expect(lines).toHaveLength(2);
  });

  test("button text names the kind and stays within Slack's limit", () => {
    expect(ideaButtonText("python", "Jaw sim")).toBe("Offer a python program: Jaw sim");
    expect(ideaButtonText("app", "x".repeat(200)).length).toBeLessThanOrEqual(75);
  });

  test("an offered idea becomes a line and its button goes; the other stays", () => {
    const { blocks, lines } = ideaBlocks([{ ...ideas[0]!, offeredBy: "Ms. Rivera" }, ideas[1]!], "Kai");
    expect((blocks as { type: string }[]).map((b) => b.type)).toEqual(["context", "section", "actions"]);
    expect(lines[0]).toBe("✅ Offered to Kai by Ms. Rivera: Croc jaw angles");
    const actions = blocks[2] as { elements: { action_id: string }[] };
    expect(actions.elements.map((e) => e.action_id)).toEqual(["qidea:offer:1"]);
  });

  test("with every idea offered there are no buttons", () => {
    const { blocks } = ideaBlocks(ideas.map((i) => ({ ...i, offeredBy: "Ms. Rivera" })), "Kai");
    expect((blocks as { type: string }[]).some((b) => b.type === "actions")).toBe(false);
  });

  test("the stamp changes when an idea is offered", () => {
    expect(ideaStamp(ideas)).not.toBe(ideaStamp([{ ...ideas[0]!, offeredBy: "x" }, ideas[1]!]));
  });
});
