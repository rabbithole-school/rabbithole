import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_OUT = "evals/stance-fit/out";
const SCHOLAR_STATES = [
  "has_footing",
  "cold",
  "stuck_repeating",
  "impatient_push",
  "fading",
  "factual_ask",
  "topic_ask",
  "procedure_ask",
  "demonstrated",
  "other",
] as const;
const TUTOR_MOVES = [
  "probe_question",
  "narrowing_hint",
  "direct_explanation",
  "worked_example_parallel",
  "answer_given",
  "closure_summary",
  "redirect_nonacademic",
  "logistics_other",
] as const;
const STANCE_FITS = [
  "matched",
  "over_socratic",
  "over_didactic",
  "funnel",
  "missed_closure",
  "not_applicable",
] as const;
const TEACHING_MOVES = new Set([
  "direct_explanation",
  "worked_example_parallel",
  "answer_given",
]);
const STALL_STATES = new Set(["cold", "stuck_repeating"]);
const FUNNEL_MOVES = new Set(["probe_question", "narrowing_hint"]);

type ScholarState = (typeof SCHOLAR_STATES)[number];
type TutorMove = (typeof TUTOR_MOVES)[number];
type StanceFit = (typeof STANCE_FITS)[number];

interface Message {
  role: "user" | "assistant";
  content: string;
  createdAt: number | string | null;
}

interface SessionData {
  sessionId: string;
  title: string;
  unitTitle: string | null;
  activityTitle: string | null;
  readingLevel: string | null;
  createdAt: number | string;
  scholarId: string;
  messages: Message[];
}

interface Verdict {
  scholarState: ScholarState;
  tutorMove: TutorMove;
  stanceFit: StanceFit;
  teachingSentences: number;
  rationale: string;
}

interface VerdictFile {
  sessionId: string;
  model?: string;
  verdicts: Record<string, Verdict>;
}

interface JudgedTurn extends Verdict {
  sessionId: string;
  turnIndex: number;
  tutorText: string;
}

interface Report {
  totals: { turnsJudged: number; sessions: number };
  stateMoveMatrix: Record<ScholarState, Record<TutorMove, number>>;
  stanceFit: {
    overall: Record<StanceFit, number>;
    perScholarState: Record<ScholarState, Record<StanceFit, number>>;
  };
  funnel: {
    perSession: Array<{ sessionId: string; longestRun: number }>;
    sessionsWithRunAtLeast3: number;
    shareSessionsWithRunAtLeast3: number;
  };
  turnsToFirstTeachingMoveAfterStall: {
    perSession: Array<{
      sessionId: string;
      stallTurnIndex: number;
      tutorTurnsUntilTeaching: number | null;
    }>;
    medianResolvedTutorTurns: number | null;
    neverCount: number;
  };
  mechanical: {
    medianScholarWordsPerTurn: number;
    shareScholarTurnsUnder6Words: number;
    tutorQuestionMarksPerTurn: number;
    tutorSentencesPerTurn: number;
    shareTutorTurnsWithZeroDeclarativeTeachingSentences: number;
  };
  closure: {
    sessionsEndingWithClosureSummary: number;
    shareSessionsEndingWithClosureSummary: number;
    missedClosureCount: number;
  };
  evidence: Record<
    "over_socratic" | "funnel" | "missed_closure" | "over_didactic",
    Array<{
      sessionId: string;
      turnIndex: number;
      scholarState: ScholarState;
      tutorText: string;
      rationale: string;
    }>
  >;
  sessions: Array<{
    sessionId: string;
    title: string;
    unitTitle: string | null;
    turns: number;
    overSocraticCount: number;
    funnelRun: number;
    closure: boolean;
  }>;
}

function parseArgs(argv: string[]) {
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--out" || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("Usage: tsx evals/stance-fit/report.ts [--out DIR]");
    }
    out = argv[++i];
  }
  return { out };
}

function readJsonFiles<T>(directory: string): T[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")));
}

function countBy<T extends string>(values: readonly T[]) {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wordCount(text: string) {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function sentences(text: string) {
  return (
    text
      .replace(/\s+/g, " ")
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? []
  );
}

function mechanicalTeachingSentenceCount(text: string) {
  return sentences(text).filter(
    (sentence) => !sentence.endsWith("?") && wordCount(sentence) >= 3,
  ).length;
}

function longestFunnelRun(turns: JudgedTurn[]) {
  let longest = 0;
  let current = 0;
  for (const turn of turns) {
    if (
      STALL_STATES.has(turn.scholarState) &&
      FUNNEL_MOVES.has(turn.tutorMove)
    ) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function escapeTable(value: unknown) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function truncateTutorText(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 300 ? compact : `${compact.slice(0, 297)}...`;
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function fixed(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const sessions = readJsonFiles<SessionData>(join(out, "data"));
  const verdictFiles = readJsonFiles<VerdictFile>(join(out, "verdicts"));
  const verdictBySession = new Map(
    verdictFiles.map((file) => [file.sessionId, file]),
  );
  const includedSessions = sessions.filter((session) =>
    verdictBySession.has(session.sessionId),
  );

  const turnsBySession = new Map<string, JudgedTurn[]>();
  const allTurns: JudgedTurn[] = [];
  for (const session of includedSessions) {
    const verdictFile = verdictBySession.get(session.sessionId);
    if (!verdictFile) continue;
    const turns = Object.entries(verdictFile.verdicts)
      .map(([index, verdict]) => {
        const turnIndex = Number(index);
        const message = session.messages[turnIndex];
        if (!message || message.role !== "assistant") return null;
        return {
          ...verdict,
          sessionId: session.sessionId,
          turnIndex,
          tutorText: message.content,
        };
      })
      .filter((turn): turn is JudgedTurn => turn !== null)
      .sort((a, b) => a.turnIndex - b.turnIndex);
    turnsBySession.set(session.sessionId, turns);
    allTurns.push(...turns);
  }

  const stateMoveMatrix = Object.fromEntries(
    SCHOLAR_STATES.map((state) => [state, countBy(TUTOR_MOVES)]),
  ) as Record<ScholarState, Record<TutorMove, number>>;
  const stanceOverall = countBy(STANCE_FITS);
  const stanceByState = Object.fromEntries(
    SCHOLAR_STATES.map((state) => [state, countBy(STANCE_FITS)]),
  ) as Record<ScholarState, Record<StanceFit, number>>;
  for (const turn of allTurns) {
    stateMoveMatrix[turn.scholarState][turn.tutorMove]++;
    stanceOverall[turn.stanceFit]++;
    stanceByState[turn.scholarState][turn.stanceFit]++;
  }

  const funnelPerSession = includedSessions.map((session) => ({
    sessionId: session.sessionId,
    longestRun: longestFunnelRun(turnsBySession.get(session.sessionId) ?? []),
  }));
  const funnelSessions = funnelPerSession.filter(
    (entry) => entry.longestRun >= 3,
  ).length;

  const stallCases = includedSessions.map((session) => {
    const turns = turnsBySession.get(session.sessionId) ?? [];
    const stallIndex = turns.findIndex((turn) =>
      STALL_STATES.has(turn.scholarState),
    );
    if (stallIndex < 0) return null;
    const teachingIndex = turns.findIndex(
      (turn, index) =>
        index >= stallIndex && TEACHING_MOVES.has(turn.tutorMove),
    );
    return {
      sessionId: session.sessionId,
      stallTurnIndex: turns[stallIndex].turnIndex,
      tutorTurnsUntilTeaching:
        teachingIndex < 0 ? null : teachingIndex - stallIndex,
    };
  }).filter(
    (
      entry,
    ): entry is {
      sessionId: string;
      stallTurnIndex: number;
      tutorTurnsUntilTeaching: number | null;
    } => entry !== null,
  );
  const resolvedStalls = stallCases
    .map((entry) => entry.tutorTurnsUntilTeaching)
    .filter((value): value is number => value !== null);

  const scholarMessages = includedSessions.flatMap((session) =>
    session.messages.filter((message) => message.role === "user"),
  );
  const tutorMessages = includedSessions.flatMap((session) =>
    session.messages.filter(
      (message, index) =>
        message.role === "assistant" &&
        !(
          session.messages[index - 1]?.role === "user" &&
          session.messages[index - 1].content.trim().toLowerCase() === "<start>"
        ),
    ),
  );
  const scholarWordCounts = scholarMessages
    .filter((message) => message.content.trim().toLowerCase() !== "<start>")
    .map((message) => wordCount(message.content));
  const mechanical = {
    medianScholarWordsPerTurn: median(scholarWordCounts),
    shareScholarTurnsUnder6Words: ratio(
      scholarWordCounts.filter((count) => count < 6).length,
      scholarWordCounts.length,
    ),
    tutorQuestionMarksPerTurn: ratio(
      tutorMessages.reduce(
        (sum, message) => sum + (message.content.match(/\?/g)?.length ?? 0),
        0,
      ),
      tutorMessages.length,
    ),
    tutorSentencesPerTurn: ratio(
      tutorMessages.reduce(
        (sum, message) => sum + sentences(message.content).length,
        0,
      ),
      tutorMessages.length,
    ),
    shareTutorTurnsWithZeroDeclarativeTeachingSentences: ratio(
      tutorMessages.filter(
        (message) => mechanicalTeachingSentenceCount(message.content) === 0,
      ).length,
      tutorMessages.length,
    ),
  };

  let finalTutorClosureCount = 0;
  for (const session of includedSessions) {
    let finalAssistantIndex = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "assistant") {
        finalAssistantIndex = i;
        break;
      }
    }
    const verdict =
      verdictBySession.get(session.sessionId)?.verdicts[
        String(finalAssistantIndex)
      ];
    if (verdict?.tutorMove === "closure_summary") finalTutorClosureCount++;
  }

  const evidenceFits = [
    "over_socratic",
    "funnel",
    "missed_closure",
    "over_didactic",
  ] as const;
  const evidence = Object.fromEntries(
    evidenceFits.map((fit) => [
      fit,
      allTurns
        .filter((turn) => turn.stanceFit === fit)
        .slice(0, 8)
        .map((turn) => ({
          sessionId: turn.sessionId,
          turnIndex: turn.turnIndex,
          scholarState: turn.scholarState,
          tutorText: truncateTutorText(turn.tutorText),
          rationale: turn.rationale,
        })),
    ]),
  ) as Record<
    (typeof evidenceFits)[number],
    Array<{
      sessionId: string;
      turnIndex: number;
      scholarState: ScholarState;
      tutorText: string;
      rationale: string;
    }>
  >;

  const perSession = includedSessions.map((session) => {
    const turns = turnsBySession.get(session.sessionId) ?? [];
    const funnel = funnelPerSession.find(
      (entry) => entry.sessionId === session.sessionId,
    );
    let finalAssistantIndex = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "assistant") {
        finalAssistantIndex = i;
        break;
      }
    }
    const closure =
      verdictBySession.get(session.sessionId)?.verdicts[
        String(finalAssistantIndex)
      ]?.tutorMove === "closure_summary";
    return {
      sessionId: session.sessionId,
      title: session.title,
      unitTitle: session.unitTitle,
      turns: turns.length,
      overSocraticCount: turns.filter(
        (turn) => turn.stanceFit === "over_socratic",
      ).length,
      funnelRun: funnel?.longestRun ?? 0,
      closure,
    };
  });

  const report: Report = {
    totals: {
      turnsJudged: allTurns.length,
      sessions: includedSessions.length,
    },
    stateMoveMatrix,
    stanceFit: {
      overall: stanceOverall,
      perScholarState: stanceByState,
    },
    funnel: {
      perSession: funnelPerSession,
      sessionsWithRunAtLeast3: funnelSessions,
      shareSessionsWithRunAtLeast3: ratio(
        funnelSessions,
        includedSessions.length,
      ),
    },
    turnsToFirstTeachingMoveAfterStall: {
      perSession: stallCases,
      medianResolvedTutorTurns:
        resolvedStalls.length > 0 ? median(resolvedStalls) : null,
      neverCount: stallCases.filter(
        (entry) => entry.tutorTurnsUntilTeaching === null,
      ).length,
    },
    mechanical,
    closure: {
      sessionsEndingWithClosureSummary: finalTutorClosureCount,
      shareSessionsEndingWithClosureSummary: ratio(
        finalTutorClosureCount,
        includedSessions.length,
      ),
      missedClosureCount: stanceOverall.missed_closure,
    },
    evidence,
    sessions: perSession,
  };

  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(out, "report.md"), renderMarkdown(report), "utf8");
  console.log(
    `Wrote ${join(out, "report.md")} and ${join(out, "report.json")} (${allTurns.length} judged turns)`,
  );
}

function renderMarkdown(report: Report) {
  const lines: string[] = [
    "# Stance-fit report",
    "",
    `**${report.totals.turnsJudged} tutor turns judged across ${report.totals.sessions} sessions.**`,
    "",
    "## State × move",
    "",
    `| Scholar state | ${TUTOR_MOVES.join(" | ")} |`,
    `|---|${TUTOR_MOVES.map(() => "---:").join("|")}|`,
    ...SCHOLAR_STATES.map(
      (state) =>
        `| ${state} | ${TUTOR_MOVES.map((move) => report.stateMoveMatrix[state][move]).join(" | ")} |`,
    ),
    "",
    "## Stance fit",
    "",
    `| Scope | ${STANCE_FITS.join(" | ")} |`,
    `|---|${STANCE_FITS.map(() => "---:").join("|")}|`,
    `| Overall | ${STANCE_FITS.map((fit) => report.stanceFit.overall[fit]).join(" | ")} |`,
    ...SCHOLAR_STATES.map(
      (state) =>
        `| ${state} | ${STANCE_FITS.map((fit) => report.stanceFit.perScholarState[state][fit]).join(" | ")} |`,
    ),
    "",
    "## Funnel and stall response",
    "",
    `- Sessions with a cold/stuck probe-or-hint run ≥ 3: **${report.funnel.sessionsWithRunAtLeast3}/${report.totals.sessions} (${pct(report.funnel.shareSessionsWithRunAtLeast3)})**`,
    `- Median tutor turns to a teaching move after the first stall: **${report.turnsToFirstTeachingMoveAfterStall.medianResolvedTutorTurns === null ? "—" : fixed(report.turnsToFirstTeachingMoveAfterStall.medianResolvedTutorTurns)}** (0 means the response to the stall taught immediately)`,
    `- First stalls never followed by a teaching move: **${report.turnsToFirstTeachingMoveAfterStall.neverCount}/${report.turnsToFirstTeachingMoveAfterStall.perSession.length}**`,
    "",
    "| Session | Longest funnel run | First stall turn | Turns until teaching |",
    "|---|---:|---:|---:|",
    ...report.funnel.perSession.map((funnel) => {
      const stall = report.turnsToFirstTeachingMoveAfterStall.perSession.find(
        (entry) => entry.sessionId === funnel.sessionId,
      );
      return `| ${escapeTable(funnel.sessionId)} | ${funnel.longestRun} | ${stall?.stallTurnIndex ?? "—"} | ${stall ? (stall.tutorTurnsUntilTeaching ?? "never") : "—"} |`;
    }),
    "",
    "## Mechanical metrics",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Median scholar words per turn | ${fixed(report.mechanical.medianScholarWordsPerTurn)} |`,
    `| Scholar turns under 6 words | ${pct(report.mechanical.shareScholarTurnsUnder6Words)} |`,
    `| Tutor question marks per turn | ${fixed(report.mechanical.tutorQuestionMarksPerTurn)} |`,
    `| Tutor sentences per turn | ${fixed(report.mechanical.tutorSentencesPerTurn)} |`,
    `| Tutor turns with zero declarative teaching sentences (mechanical heuristic) | ${pct(report.mechanical.shareTutorTurnsWithZeroDeclarativeTeachingSentences)} |`,
    "",
    "## Closure",
    "",
    `- Sessions whose final tutor turn is a closure summary: **${report.closure.sessionsEndingWithClosureSummary}/${report.totals.sessions} (${pct(report.closure.shareSessionsEndingWithClosureSummary)})**`,
    `- Missed-closure turns: **${report.closure.missedClosureCount}**`,
    "",
    "## Evidence",
    "",
  ];

  for (const fit of [
    "over_socratic",
    "funnel",
    "missed_closure",
    "over_didactic",
  ] as const) {
    lines.push(`### ${fit}`, "");
    const examples = report.evidence[fit];
    if (examples.length === 0) {
      lines.push("_No examples._", "");
      continue;
    }
    for (const example of examples) {
      lines.push(
        `- **${escapeTable(example.sessionId)} · turn ${example.turnIndex} · ${example.scholarState}** — ${escapeTable(example.rationale)}`,
        `  > ${escapeTable(example.tutorText)}`,
        "",
      );
    }
  }

  lines.push(
    "## Per-session",
    "",
    "| Session | Title | Unit | Turns | Over-socratic | Funnel run | Closure |",
    "|---|---|---|---:|---:|---:|---|",
    ...report.sessions.map(
      (session) =>
        `| ${escapeTable(session.sessionId)} | ${escapeTable(session.title)} | ${escapeTable(session.unitTitle ?? "—")} | ${session.turns} | ${session.overSocraticCount} | ${session.funnelRun} | ${session.closure ? "yes" : "no"} |`,
    ),
    "",
  );
  return `${lines.join("\n")}\n`;
}

main();
