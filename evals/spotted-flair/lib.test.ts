// @vitest-environment node
import { describe, expect, test } from "vitest";
import { parseObserverResponse } from "../../convex/lib/observerShared";
import {
  blindSheet, datasetId, evaluateGates, hash, labelsSchema, parseSessions,
  resultsSchema, scoreLabels, scoreWeeks, type Result, type Results, type Session,
} from "./lib";

const idea = "Move the shadow with the sun because the carrots need light.";
function session(id = "session-a", date = "2026-11-01T10:00:00Z"): Session {
  return parseSessions([{
    id, scholarId: "fictional-robot", date, title: "Garden",
    chatHistory: [
      { id: "tutor", role: "assistant", content: "What would you like to change?" },
      { id: "scholar", role: "user", content: idea },
      { id: "after", role: "assistant", content: "The sun moves now." },
    ],
  }])[0];
}
const proposal = { decision: "award", reason: "secret observer reason", sourceMessageId: "scholar", label: "secret flair", note: "secret note" };
const connection = { studentInitiated: true, transcriptExcerpt: "Move the shadow ... carrots need light." };
const observation = {
  studentInitiated: true, evidenceType: "direct_demonstration", transcriptExcerpt: idea,
  conceptLabel: "Plant growth", domain: "Science", masteryLevel: 3, confidenceScore: 0.8,
  evidenceSummary: "Relates growth to light", attemptContext: "creative_work",
};
function parsed(flair: unknown = proposal, connections: unknown[] = [connection], observations: unknown[] = []) {
  return parseObserverResponse([{
    type: "tool_use", input: { spottedFlair: flair, crossDomainConnections: connections, observations },
  }])!;
}
function result(id: string, award: boolean, date?: string): Result {
  const s = session(id, date);
  const raw = award ? proposal : { decision: "none", reason: "Meets a listed goal" };
  return {
    session: s, inputHash: hash(s), requestHash: "request",
    ...evaluateGates(s, parsed(raw), raw),
    completedAt: "2026-11-11T00:00:00Z",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
  };
}
const results = (sessions: Result[]): Results => ({ version: 1, codeHash: "code", model: "test", sessions });

describe("replay inputs and production gates", () => {
  test("checkpoint parsing and object key ordering preserve resume fingerprints", () => {
    const before = results([result("fictional-resume", true)]);
    const after = resultsSchema.parse(JSON.parse(JSON.stringify(before)));
    expect(hash(after.sessions[0].session)).toBe(before.sessions[0].inputHash);
    expect(hash({ b: 2, a: { d: 4, c: 3 } })).toBe(hash({ a: { c: 3, d: 4 }, b: 2 }));
  });

  test("normalizes fixture messages but rejects ambiguous ids and missing image evidence", () => {
    expect(session().chatHistory[1].sourceRole).toBe("user");
    const raw = { ...session(), chatHistory: [{ role: "user", content: idea }] };
    expect(parseSessions([raw])[0].chatHistory[0].id).toBe("eval-message-1");
    expect(() => parseSessions([raw, raw])).toThrow("Duplicate session");
    expect(() => parseSessions([{ ...raw, date: "yesterday" }])).toThrow();
    expect(() => parseSessions([{ ...raw, chatHistory: [
      { role: "user", content: idea, id: "x" }, { role: "user", content: idea, id: "x" },
    ] }])).toThrow("Duplicate message");
    expect(() => parseSessions([{ ...raw, chatHistory: [
      { role: "user", content: idea, imageId: "missing-upload" },
    ] }])).toThrow("cannot resolve");
  });

  test("passes the exact grounding, cleanup and elided-quote corroboration gates", () => {
    const raw = { ...proposal, sourceMessageId: "[scholar]", label: " Shadow moves! ", note: " " + "a".repeat(220) };
    const outcome = evaluateGates(session(), parsed(raw), raw);
    expect(outcome.gate).toMatchObject({
      outcome: "awarded", label: "Shadow moves", sourceMessageId: "scholar", excerpt: idea,
    });
    if (outcome.gate.outcome === "awarded") expect(outcome.gate.note.length).toBe(200);
    expect(outcome.notAwardedCandidates).toEqual([]);
  });

  test("reports drops without treating malformed awards as observer none", () => {
    for (const [raw, reason] of [
      [{ ...proposal, sourceMessageId: "tutor" }, "not_scholar_line"],
      [{ ...proposal, label: " " }, "unusable_text"],
      [{ ...proposal, note: undefined }, "proposal_not_parsed"],
      [{ decision: "none" }, "observer_none"],
      [{ decision: "maybe" }, "invalid_decision"],
      [undefined, "missing_decision"],
    ] as const) {
      expect(evaluateGates(session(), parsed(raw ?? null), raw).gate).toEqual({ outcome: "dropped", reason });
    }
    expect(evaluateGates(session(), parsed(proposal, []), proposal).gate.reason).toBe("not_corroborated");
    const app = session();
    app.chatHistory[1].inputModality = "app";
    expect(evaluateGates(app, parsed(), proposal).gate.reason).toBe("not_scholar_line");
  });

  test("harvests one unawarded turn with both evidence types, not tutor/inference/unquoted rows", () => {
    const raw = { decision: "none", reason: "Already listed" };
    const output = evaluateGates(session(), parsed(raw,
      [connection, { studentInitiated: false, transcriptExcerpt: idea }],
      [observation, { ...observation, evidenceType: "indirect_inference" },
        { ...observation, transcriptExcerpt: "Invented evidence nowhere in the transcript" }],
    ), raw);
    expect(output.notAwardedCandidates).toEqual([{
      sourceMessageId: "scholar", excerpt: idea,
      evidence: [
        { kind: "connection", excerpt: connection.transcriptExcerpt },
        { kind: "direct_demonstration", excerpt: idea },
      ],
    }]);
    const history = session();
    history.chatHistory.push(...Array.from({ length: 31 }, (_, i) => ({
      id: `tail-${i}`, sourceRole: "assistant", role: "assistant", content: "Continue.",
    })));
    expect(evaluateGates(history, parsed(raw), raw).notAwardedCandidates).toEqual([]);
  });
});

describe("blind sampling and scores", () => {
  const corpus = () => results([
    result("award-a", true), result("award-b", true),
    result("control-a", false), result("control-b", false), result("control-c", false),
  ]);
  test("has equal disjoint groups, stable shuffle, full context, and no model-output leakage", () => {
    const input = corpus();
    const sheet = blindSheet(input, "seed");
    expect(sheet).toEqual(blindSheet(input, "seed"));
    expect(sheet.cards).toHaveLength(4);
    expect(new Set(sheet.cards.map((c) => c.id)).size).toBe(4);
    expect(JSON.stringify(sheet)).not.toMatch(/secret|awarded|decision|sourceMessageId|award-a|control-a/);
    expect(sheet.cards[0].context.map((turn) => turn.selected)).toEqual([false, true, false]);
    expect(sheet.cards.map((c) => c.id)).not.toEqual(blindSheet(input, "different").cards.map((c) => c.id));
    expect(() => blindSheet(results([result("only-award", true)]), "seed")).toThrow("Need 1");
    expect(() => blindSheet(results([result("only-control", false)]), "seed")).toThrow("No awards");
    // Rare awards: "all" shows every passed-over moment, still shuffled and blind.
    const rare = results([
      result("award", true),
      result("control-1", false),
      result("control-2", false),
      result("control-3", false),
    ]);
    expect(blindSheet(rare, "seed").cards).toHaveLength(2);
    expect(blindSheet(rare, "seed", "all").cards).toHaveLength(4);
    expect(blindSheet(rare, "seed", 2).cards).toHaveLength(3);
    expect(blindSheet(results([result("only-control", false)]), "seed", "all").cards).toHaveLength(1);
    expect(() => blindSheet(rare, "seed", 9)).toThrow("Need 9");
  });

  function labeledCorpus() {
    const input = corpus();
    const sheet = blindSheet(input, "seed");
    const awarded = input.sessions.filter((r) => r.gate.outcome === "awarded")
      .map((r) => hash([r.session.id, r.inputHash, "scholar"]));
    const unawarded = sheet.cards.map((c) => c.id).filter((id) => !awarded.includes(id));
    const ids = [...awarded, ...unawarded];
    const label = (name: string, choices: string[]) => labelsSchema.parse({
      version: 1, datasetId: sheet.datasetId, sheetId: sheet.sheetId,
      itemIds: sheet.cards.map((c) => c.id), labeler: name,
      answers: Object.fromEntries(ids.map((id, i) => [id, { answer: choices[i] }])),
    });
    return {
      input, ids,
      a: label("Fictional labeler A", ["yes", "no", "unsure", "yes"]),
      b: label("Fictional labeler B", ["yes", "yes", "no", "yes"]),
    };
  }
  test("counts precision and miss proxy by group, and three-way agreement with chance correction", () => {
    const { input, a, b } = labeledCorpus();
    const scored = scoreLabels(input, [a, b]);
    expect(scored.pooled.awarded).toEqual({ yes: 3, no: 1, unsure: 0, missing: 0 });
    expect(scored.pooled.notAwarded).toEqual({ yes: 2, no: 1, unsure: 1, missing: 0 });
    expect(scored.agreement[0]).toMatchObject({ agree: 2, n: 4 });
    expect(scored.agreement[0].kappa).toBeCloseTo(1 / 9);
    delete b.answers[Object.keys(b.answers)[0]];
    expect(scoreLabels(input, [a, b]).pooled.awarded.missing).toBe(1);
    expect(scoreLabels(input, [a, b]).agreement[0].n).toBe(3);
  });

  test("rejects duplicated raters, mixed datasets and forged sheet membership", () => {
    const { input, a, b } = labeledCorpus();
    expect(() => scoreLabels(input, [a, a])).toThrow("Duplicate labeler");
    expect(() => scoreLabels(input, [{ ...a, datasetId: "other" }])).toThrow("different results");
    expect(() => scoreLabels(input, [{ ...a, itemIds: [...a.itemIds, "unknown"] }])).toThrow("membership");
    expect(() => scoreLabels(input, [a, { ...b, sheetId: "other" }])).toThrow("same blind sheet");
    expect(datasetId(input)).toBe(datasetId({ ...input, sessions: [...input.sessions].reverse() }));
  });
});

describe("rolling-week cap calibration", () => {
  test("counts zero-award weeks and rejects exactly 20% binding", () => {
    const input = results([
      result("a", true, "2026-10-05T10:00:00Z"),
      result("b", true, "2026-10-06T10:00:00Z"),
      ...[12, 19, 26].map((day) => result(`empty-${day}`, false, `2026-10-${day}T10:00:00Z`)),
      result("empty-nov", false, "2026-11-02T10:00:00Z"),
    ]);
    const score = scoreWeeks(input);
    expect(score.weeks).toHaveLength(5);
    expect(score.caps).toEqual([
      { cap: 1, boundWeeks: 1, fraction: 0.2 },
      { cap: 2, boundWeeks: 0, fraction: 0 },
    ]);
    expect(score.recommended).toBe(2);
  });

  test("uses rolling history across calendar boundaries, including exactly seven days", () => {
    const input = results([
      result("sunday", true, "2026-11-01T10:00:00Z"),
      result("monday", true, "2026-11-02T10:00:00Z"),
      result("next-sunday", true, "2026-11-08T10:00:00Z"),
    ]);
    const score = scoreWeeks(input);
    expect(score.recommended).toBe(3);
    expect(score.weeks.map((w) => w.awards)).toEqual([1, 2]);
    expect(score.weeks[1].blockedAtCurrentCap).toBe(1);
  });

  test("blocked proposals do not spend the cap, and scholars do not share caps", () => {
    const input = results([
      result("first", true, "2026-11-01T10:00:00Z"),
      result("blocked", true, "2026-11-03T10:00:00Z"),
      result("expired", true, "2026-11-09T09:00:00Z"),
    ]);
    expect(scoreWeeks(input).caps[0].boundWeeks).toBe(1);
    const separate = results([result("a", true), result("b", true)]);
    separate.sessions[1].session.scholarId = "other-fictional-robot";
    expect(scoreWeeks(separate).recommended).toBe(1);
  });
});
