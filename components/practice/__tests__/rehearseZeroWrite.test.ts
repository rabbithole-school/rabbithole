import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { ServableItem } from "@/convex/lib/practice/servable";
import {
  isDurableCommand,
  newPracticeState,
  practiceReduce,
  type PracticeCommand,
} from "@/shared/practiceMachine";
import type { OutboxAnswer } from "@/shared/practiceOutboxContract";
import {
  closureGenerationEnabled,
  exampleSheetWriteCaps,
  isStaffSelfRehearsal,
} from "../rehearseZeroWrite";
import { createRehearseGrader } from "../rehearseGrader";

const STORED_ITEM: ServableItem = {
  kind: "stored",
  itemId: "gen#1",
  skillKey: "skill",
  skillLabel: "Skill",
  domain: "whole-number-arithmetic",
  prompt: { stem: "6/8 in lowest terms?", answerType: "fraction" },
  tutorContext: { type: "text", stem: "6/8 in lowest terms?" },
  ref: "x" as never,
  verifier: {
    kind: "storedAnswer",
    answerType: "fraction",
    answerCanonical: "3/4",
  },
};

function entry(overrides: Partial<OutboxAnswer> = {}): OutboxAnswer {
  return {
    clientEventId: "practice-answer:rehearse",
    itemId: "gen#1",
    answer: "3/4",
    record: true,
    skillLabel: "Skill",
    queuedAt: 1,
    ...overrides,
  };
}

describe("rehearsal route and sibling write caps", () => {
  it("routes every staff self-run to rehearsal", () => {
    for (const role of [
      "teacher",
      "curriculum_designer",
      "platform_admin",
      "school_admin",
      "staff",
    ] as const) {
      expect(isStaffSelfRehearsal(role, false)).toBe(true);
    }
    expect(isStaffSelfRehearsal("scholar", false)).toBe(false);
    expect(isStaffSelfRehearsal("teacher", true)).toBe(false);
  });

  it("disables Example writes and generated closure writes", () => {
    expect(exampleSheetWriteCaps(true)).toEqual({
      logRetrieval: false,
      allowGeneration: false,
    });
    expect(closureGenerationEnabled(false, true)).toBe(false);
    expect(closureGenerationEnabled(true, false)).toBe(false);
    expect(exampleSheetWriteCaps(false)).toEqual({
      logRetrieval: true,
      allowGeneration: true,
    });
    expect(closureGenerationEnabled(false, false)).toBe(true);
  });
});

describe("the rehearsal machine emits zero durable commands", () => {
  const start = () =>
    newPracticeState({
      scholarId: "staff-id",
      itemCount: 2,
      itemId: "gen#1",
      mode: "rehearse",
    });

  it("keeps mount, reconnect, submit, retry, mapping and completion local", () => {
    let state = start();
    const commands: PracticeCommand[] = [];
    for (const event of [
      { type: "env:mounted", queuedCount: 3, online: true } as const,
      { type: "env:online" } as const,
      {
        type: "ui:submit",
        answer: "3/4",
        clientEventId: "practice-answer:rehearse",
        entry: entry(),
      } as const,
    ]) {
      const step = practiceReduce(state, event);
      state = step.state;
      commands.push(...step.commands);
    }
    const grade = commands.find((command) => command.kind === "gradeLocally");
    expect(grade).toBeDefined();
    const graded = practiceReduce(state, {
      type: "local:graded",
      id: grade!.id,
      correct: true,
    });
    commands.push(...graded.commands);

    const mapping = practiceReduce(
      practiceReduce(start(), {
        type: "lane:entered",
        lane: "mapping",
      }).state,
      { type: "lane:mappingAnswered", recorded: true, correct: true },
    );
    commands.push(...mapping.commands);

    expect(commands.filter(isDurableCommand)).toEqual([]);
  });

  it("keeps the component's mapping mutation behind the live-only guard", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const source = readFileSync(
      resolve(root, "components/practice/PracticeSession.tsx"),
      "utf8",
    );
    expect(
      source.match(/current\.lane === "mapping" && !rehearse/g),
    ).toHaveLength(2);
  });
});

describe("the injected grader remains read-only for every answer shape", () => {
  const makeGrader = (item: ServableItem = STORED_ITEM) => {
    const mutation = vi.fn(async () => {
      throw new Error("rehearsal must never call a mutation");
    });
    const query = vi.fn(async () => item);
    return {
      grade: createRehearseGrader(query),
      mutation,
      query,
    };
  };

  it("grades typed, retry and don't-know submissions without a mutation", async () => {
    const { grade, mutation, query } = makeGrader();
    expect(
      await grade({
        itemId: "gen#1",
        submission: { kind: "typed", raw: "6/8" },
      }),
    ).toMatchObject({ correct: true });
    await grade({
      itemId: "gen#1",
      submission: { kind: "typed", raw: "3/4" },
    });
    expect(
      await grade({
        itemId: "gen#1",
        submission: { kind: "dontKnow" },
      }),
    ).toMatchObject({ correct: false, isDontKnow: true });
    expect(query).toHaveBeenCalledTimes(3);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("grades a manipulative state without a mutation", async () => {
    const manipulative: ServableItem = {
      kind: "manipulative",
      itemId: "gen#m",
      skillKey: "skill",
      skillLabel: "Skill",
      domain: "whole-number-arithmetic",
      prompt: { stem: "Build it.", answerType: "manipulative" },
      tutorContext: { type: "text", stem: "Build it." },
      ref: "x" as never,
      verifier: {
        kind: "manipulative",
        spec: JSON.stringify({
          kind: "numberline",
          id: "nl",
          concept: "c",
          prompt: "Place 3.",
          min: 0,
          max: 5,
          tickStep: 1,
          snap: 1,
          start: 0,
          goal: { type: "placeAt", value: 3, tolerance: 0.01 },
        }),
      },
    };
    const { grade, mutation } = makeGrader(manipulative);
    expect(
      await grade({
        itemId: "gen#m",
        submission: {
          kind: "typed",
          raw: JSON.stringify({ value: 3 }),
        },
      }),
    ).toMatchObject({ correct: true });
    expect(mutation).not.toHaveBeenCalled();
  });
});
