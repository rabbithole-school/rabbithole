import { createHash } from "node:crypto";
import { z } from "zod";
import {
  groundSessionSignalEvidence,
  observerTranscriptWindow,
  type ParsedObserverResponse,
} from "../../convex/lib/observerShared";
import {
  cleanSpottedFlairText,
  spottedFlairCorroborated,
  SPOTTED_FLAIR_PER_SCHOLAR_WEEK,
  SPOTTED_FLAIR_WEEK_MS,
} from "../../convex/lib/spottedFlair";

const text = z.string().min(1);
const messageSchema = z.object({
  id: text.optional(),
  role: text,
  sourceRole: text.optional(),
  content: z.string(),
  createdAt: z.number().finite().optional(),
  inputModality: z.enum(["typed", "spoken", "app"]).optional(),
  generatedImage: z.boolean().optional(),
  magicRedraw: z.boolean().optional(),
  byStaff: z.boolean().optional(),
  imageId: z.string().nullable().optional(),
  imagePrompt: z.string().nullable().optional(),
});
const sessionSchema = z.object({
  id: text,
  scholarId: text,
  date: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  title: text,
  chatHistory: z.array(messageSchema).min(1),
  deliverableCriteria: z.array(z.object({
    id: text,
    label: text,
    description: z.string().optional(),
  })).optional(),
  buildContract: z.object({
    gate: z.string().optional(),
    invariants: z.array(z.string()).optional(),
  }).optional(),
});

export function parseSessions(value: unknown) {
  const sessions = z.array(sessionSchema).min(1).parse(value).map((session) => ({
    ...session,
    chatHistory: session.chatHistory.map((message, index) => ({
      ...message,
      id: message.id ?? `eval-message-${index + 1}`,
      sourceRole: message.sourceRole ?? message.role,
    })),
  }));
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length) {
    throw new Error("Duplicate session ids");
  }
  for (const session of sessions) {
    if (new Set(session.chatHistory.map((m) => m.id)).size !== session.chatHistory.length) {
      throw new Error("Duplicate message ids in a session");
    }
    if (observerTranscriptWindow(session.chatHistory).some(
      (m) => m.role === "user" && m.imageId && !m.generatedImage,
    )) {
      throw new Error("Text-only replay cannot resolve scholar uploads; supply a text-only corpus");
    }
  }
  return sessions;
}

export type Session = ReturnType<typeof parseSessions>[number];

const gateSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("awarded"),
    reason: z.literal("passed"),
    sourceMessageId: text,
    excerpt: text,
    label: text,
    note: text,
  }),
  z.object({
    outcome: z.literal("dropped"),
    reason: z.enum([
      "observer_none", "missing_decision", "invalid_decision",
      "proposal_not_parsed", "not_scholar_line", "unusable_text", "not_corroborated",
    ]),
  }),
]);
const candidateSchema = z.object({
  sourceMessageId: text,
  excerpt: text,
  evidence: z.array(z.object({
    kind: z.enum(["connection", "direct_demonstration"]),
    excerpt: text,
  })).min(1),
});
const resultSchema = z.object({
  session: sessionSchema,
  inputHash: text,
  requestHash: text,
  decision: z.enum(["award", "none", "missing", "invalid"]),
  reason: z.string().nullable(),
  proposed: z.object({
    sourceMessageId: z.string().optional(),
    label: z.string().optional(),
    note: z.string().optional(),
  }).nullable(),
  gate: gateSchema,
  notAwardedCandidates: z.array(candidateSchema),
  completedAt: text,
  usage: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    calls: z.number(),
  }),
});
export const resultsSchema = z.object({
  version: z.literal(1),
  codeHash: text,
  model: text,
  sessions: z.array(resultSchema),
});
export type Result = z.infer<typeof resultSchema>;
export type Results = z.infer<typeof resultsSchema>;
type Gate = z.infer<typeof gateSchema>;

export function hash(value: unknown): string {
  // Schema parsing can reorder keys; a checkpoint round-trip must not change its identity.
  const json = JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry);
  if (json === undefined) throw new Error("Cannot hash an undefined value");
  return createHash("sha256").update(json).digest("hex");
}

export function evaluateGates(
  session: Session,
  parsed: ParsedObserverResponse,
  raw: unknown,
): Pick<Result, "decision" | "reason" | "proposed" | "gate" | "notAwardedCandidates"> {
  const fields = z.object({
    decision: z.unknown().optional(),
    reason: z.string().optional().catch(undefined),
    sourceMessageId: z.string().optional().catch(undefined),
    label: z.string().optional().catch(undefined),
    note: z.string().optional().catch(undefined),
  }).safeParse(raw);
  const value = fields.success ? fields.data : undefined;
  const decision = value?.decision === "award" || value?.decision === "none"
    ? value.decision : value?.decision === undefined ? "missing" : "invalid";
  const proposal = parsed.spottedFlair;
  let gate: Gate;
  if (!proposal) {
    gate = {
      outcome: "dropped",
      reason: decision === "award" ? "proposal_not_parsed"
        : decision === "none" ? "observer_none"
          : decision === "missing" ? "missing_decision" : "invalid_decision",
    };
  } else {
    const grounded = groundSessionSignalEvidence(
      { sourceMessageId: proposal.sourceMessageId }, session.chatHistory,
    );
    const source = grounded
      ? session.chatHistory.find((m) => m.id === grounded.sourceMessageId)
      : undefined;
    const cleaned = cleanSpottedFlairText(proposal);
    if (!grounded || !source) gate = { outcome: "dropped", reason: "not_scholar_line" };
    else if (!cleaned) gate = { outcome: "dropped", reason: "unusable_text" };
    else if (!spottedFlairCorroborated(parsed, source.content)) {
      gate = { outcome: "dropped", reason: "not_corroborated" };
    } else {
      gate = {
        outcome: "awarded", reason: "passed", ...cleaned,
        sourceMessageId: grounded.sourceMessageId, excerpt: grounded.transcriptExcerpt,
      };
    }
  }

  // Match each row with the production quote predicate, not a second quote matcher.
  const notAwardedCandidates: z.infer<typeof candidateSchema>[] = [];
  for (const message of observerTranscriptWindow(session.chatHistory)) {
    if (gate.outcome === "awarded" && message.id === gate.sourceMessageId) continue;
    const grounded = groundSessionSignalEvidence({ sourceMessageId: message.id }, session.chatHistory);
    if (!grounded) continue;
    const evidence: z.infer<typeof candidateSchema>["evidence"] = [];
    for (const connection of parsed.crossDomainConnections) {
      if (connection.transcriptExcerpt && spottedFlairCorroborated(
        { crossDomainConnections: [connection], observations: [] }, message.content,
      )) evidence.push({ kind: "connection", excerpt: connection.transcriptExcerpt });
    }
    for (const observation of parsed.observations) {
      if (observation.transcriptExcerpt && spottedFlairCorroborated(
        { crossDomainConnections: [], observations: [observation] }, message.content,
      )) evidence.push({ kind: "direct_demonstration", excerpt: observation.transcriptExcerpt });
    }
    if (evidence.length) {
      notAwardedCandidates.push({
        sourceMessageId: grounded.sourceMessageId, excerpt: grounded.transcriptExcerpt, evidence,
      });
    }
  }
  return {
    decision, reason: parsed.spottedFlairReason ?? null,
    proposed: value ? {
      sourceMessageId: value.sourceMessageId, label: value.label, note: value.note,
    } : null,
    gate, notAwardedCandidates,
  };
}

function moments(results: Results) {
  return results.sessions.flatMap((result) => [
    ...(result.gate.outcome === "awarded" ? [{ ...result.gate, awarded: true }] : []),
    ...result.notAwardedCandidates.map((candidate) => ({ ...candidate, awarded: false })),
  ].map((moment) => ({
    ...moment, session: result.session,
    id: hash([result.session.id, result.inputHash, moment.sourceMessageId]),
  })));
}

export function datasetId(results: Results): string {
  return hash({
    codeHash: results.codeHash,
    sessions: [...results.sessions].sort((a, b) => a.session.id.localeCompare(b.session.id))
      .map((r) => [r.session, r.inputHash, r.gate, r.notAwardedCandidates]),
  });
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const output = [...items];
  for (let i = output.length - 1; i > 0; i--) {
    const fraction = Number.parseInt(hash([seed, i]).slice(0, 13), 16) / 0x10000000000000;
    const j = Math.floor(fraction * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

/**
 * How many not-awarded controls join the awards on a blind sheet. "equal" (the
 * default) pairs each award with one control, which suits measuring
 * precision. When awards are rare the useful question flips to "is the
 * observer too strict?", so "all" (or a number) shows more of the moments it
 * passed over.
 */
export type ControlCount = "equal" | "all" | number;

export function blindSheet(results: Results, seed: string, controls: ControlCount = "equal") {
  const pool = moments(results);
  const awards = pool.filter((m) => m.awarded);
  const negatives = pool.filter((m) => !m.awarded);
  const wanted =
    controls === "equal" ? awards.length
      : controls === "all" ? negatives.length
        : controls;
  if (!awards.length && wanted === 0) {
    throw new Error("No awards and no controls to label; the blind sheet would be empty");
  }
  if (negatives.length < wanted) {
    throw new Error(`Need ${wanted} not-awarded candidates, found ${negatives.length}; add sessions, never duplicate controls`);
  }
  const selected = shuffled([
    ...awards, ...shuffled(negatives, `${seed}:controls`).slice(0, wanted),
  ], `${seed}:cards`);
  const cards = selected.map((m) => {
    const index = m.session.chatHistory.findIndex((turn) => turn.id === m.sourceMessageId);
    if (index < 0) throw new Error("A labeling moment has no source turn");
    // Whitelist the blind payload: no decision, reason, flair text, title or source ids.
    return {
      id: m.id,
      excerpt: m.excerpt,
      goals: {
        criteria: (m.session.deliverableCriteria ?? []).map((c) => ({
          label: c.label, description: c.description,
        })),
        mission: m.session.buildContract ?? null,
      },
      context: m.session.chatHistory.slice(Math.max(0, index - 2), index + 3).map((turn) => ({
        speaker: turn.byStaff ? "Staff"
          : turn.sourceRole !== "user" ? "Tutor"
            : turn.inputModality === "app" ? "App"
              : turn.inputModality === "spoken" ? "Scholar (speech-to-text)" : "Scholar",
        content: turn.content,
        selected: turn.id === m.sourceMessageId,
      })),
    };
  });
  const corpus = datasetId(results);
  return { datasetId: corpus, sheetId: hash([corpus, cards.map((c) => c.id)]), cards };
}

export const labelsSchema = z.object({
  version: z.literal(1),
  datasetId: text,
  sheetId: text,
  labeler: z.string().trim().min(1),
  itemIds: z.array(text).min(1),
  answers: z.record(z.string(), z.object({
    answer: z.enum(["yes", "no", "unsure"]),
    note: z.string().optional(),
  })),
});
export type Labels = z.infer<typeof labelsSchema>;

export function scoreLabels(results: Results, labels: Labels[]) {
  const pool = new Map(moments(results).map((m) => [m.id, m]));
  const awardIds = [...pool.values()].filter((m) => m.awarded).map((m) => m.id);
  const seen = new Set<string>();
  const corpus = datasetId(results);
  for (const label of labels) {
    if (seen.has(label.labeler.toLowerCase())) throw new Error("Duplicate labeler; supply only their latest export");
    seen.add(label.labeler.toLowerCase());
    if (label.datasetId !== corpus) throw new Error("Labels belong to a different results dataset");
    if (new Set(label.itemIds).size !== label.itemIds.length ||
        label.itemIds.length !== awardIds.length * 2 ||
        awardIds.some((id) => !label.itemIds.includes(id)) ||
        label.itemIds.some((id) => !pool.has(id)) ||
        Object.keys(label.answers).some((id) => !label.itemIds.includes(id))) {
      throw new Error("Invalid blind-sheet membership or answer ids");
    }
    if (label.sheetId !== hash([corpus, label.itemIds]) || label.sheetId !== labels[0].sheetId) {
      throw new Error("Labelers must use the same blind sheet");
    }
  }
  const tally = (subset: Labels[], awarded: boolean) => {
    const count = { yes: 0, no: 0, unsure: 0, missing: 0 };
    for (const label of subset) {
      for (const id of label.itemIds) {
        if (pool.get(id)?.awarded !== awarded) continue;
        const answer = label.answers[id]?.answer;
        count[answer ?? "missing"]++;
      }
    }
    return count;
  };
  const agreement = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      const common = a.itemIds.filter((id) => a.answers[id] && b.answers[id]);
      const agree = common.filter((id) => a.answers[id].answer === b.answers[id].answer).length;
      const n = common.length;
      const observed = n ? agree / n : null;
      const expected = n ? (["yes", "no", "unsure"] as const).reduce((sum, choice) =>
        sum + common.filter((id) => a.answers[id].answer === choice).length *
          common.filter((id) => b.answers[id].answer === choice).length / (n * n), 0) : null;
      agreement.push({
        labelers: [a.labeler, b.labeler], n, agree,
        kappa: observed !== null && expected !== null && expected < 1
          ? (observed - expected) / (1 - expected) : null,
      });
    }
  }
  return {
    pooled: { awarded: tally(labels, true), notAwarded: tally(labels, false) },
    perLabeler: labels.map((l) => ({
      labeler: l.labeler, awarded: tally([l], true), notAwarded: tally([l], false),
    })),
    agreement,
  };
}

function weekStart(date: string): string {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}

export function scoreWeeks(results: Results) {
  const sessions = [...results.sessions].sort((a, b) =>
    Date.parse(a.session.date) - Date.parse(b.session.date) || a.session.id.localeCompare(b.session.id));
  const key = (s: Result["session"]) => JSON.stringify([s.scholarId, weekStart(s.date)]);
  const weeks = new Map(sessions.map((r) => [key(r.session), {
    scholarId: r.session.scholarId, week: weekStart(r.session.date), awards: 0,
  }]));
  for (const r of sessions) if (r.gate.outcome === "awarded") weeks.get(key(r.session))!.awards++;
  const simulate = (cap: number) => {
    const accepted = new Map<string, number[]>();
    const blocked = new Map<string, number>();
    for (const r of sessions) {
      if (r.gate.outcome !== "awarded") continue;
      const at = Date.parse(r.session.date);
      const recent = (accepted.get(r.session.scholarId) ?? [])
        .filter((time) => time >= at - SPOTTED_FLAIR_WEEK_MS);
      if (recent.length >= cap) blocked.set(key(r.session), (blocked.get(key(r.session)) ?? 0) + 1);
      else recent.push(at);
      accepted.set(r.session.scholarId, recent);
    }
    return blocked;
  };
  const currentBlocked = simulate(SPOTTED_FLAIR_PER_SCHOLAR_WEEK);
  const caps = [];
  let recommended: number | null = null;
  if (weeks.size) {
    for (let cap = 1; cap <= sessions.length; cap++) {
      const blocked = simulate(cap);
      caps.push({ cap, boundWeeks: blocked.size, fraction: blocked.size / weeks.size });
      if (blocked.size * 5 < weeks.size) {
        recommended = cap;
        break;
      }
    }
  }
  return {
    weeks: [...weeks.entries()].map(([id, week]) => ({
      ...week, blockedAtCurrentCap: currentBlocked.get(id) ?? 0,
    })),
    caps, recommended,
  };
}
