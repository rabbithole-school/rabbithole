// Extracts stance-fit "decision points" — judged scholar turns whose state
// calls for a deliberate stance choice — from a classified output directory,
// so a later counterfactual run can replay exactly those moments.
//
// Reads <out>/data/*.json and <out>/verdicts/*.json (both gitignored, real
// prod data); writes <out>/decision-points.json next to them. Also prints the
// over_socratic + funnel rate split by whether the session was anchored to an
// activity (counts only, no transcript text).
//
//   node_modules/.bin/tsx evals/stance-fit/decision-points.ts --out <DIR>

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DECISION_STATES = new Set([
  "stuck_repeating",
  "cold",
  "impatient_push",
  "procedure_ask",
  "demonstrated",
  "has_footing",
  "fading",
]);
const OVERQUESTIONING_FITS = new Set(["over_socratic", "funnel"]);

interface SessionData {
  sessionId: string;
  activityTitle: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

interface VerdictFile {
  sessionId: string;
  verdicts: Record<
    string,
    { scholarState: string; tutorMove: string; stanceFit: string }
  >;
}

function parseArgs(argv: string[]) {
  if (argv.length !== 2 || argv[0] !== "--out") {
    throw new Error("Usage: tsx evals/stance-fit/decision-points.ts --out DIR");
  }
  return { out: argv[1] };
}

function readJsonDir<T>(directory: string): T[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as T);
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const sessions = new Map(
    readJsonDir<SessionData>(join(out, "data")).map((s) => [s.sessionId, s]),
  );
  const points: Array<{
    sessionId: string;
    scholarIndex: number;
    tutorIndex: number;
    state: string;
    originalMove: string;
    originalFit: string;
    anchored: boolean;
  }> = [];
  const split = {
    anchored: { sessions: 0, turns: 0, overQuestioning: 0 },
    unanchored: { sessions: 0, turns: 0, overQuestioning: 0 },
  };

  for (const file of readJsonDir<VerdictFile>(join(out, "verdicts"))) {
    const session = sessions.get(file.sessionId);
    if (!session) continue;
    const anchored = Boolean(session.activityTitle);
    const bucket = anchored ? split.anchored : split.unanchored;
    bucket.sessions++;
    const entries = Object.entries(file.verdicts)
      .map(([index, verdict]) => [Number(index), verdict] as const)
      .sort((a, b) => a[0] - b[0]);
    for (const [tutorTurnIndex, verdict] of entries) {
      bucket.turns++;
      if (OVERQUESTIONING_FITS.has(verdict.stanceFit)) bucket.overQuestioning++;
      if (!DECISION_STATES.has(verdict.scholarState)) continue;
      let scholarTurnIndex = tutorTurnIndex - 1;
      while (
        scholarTurnIndex >= 0 &&
        session.messages[scholarTurnIndex]?.role !== "user"
      ) {
        scholarTurnIndex--;
      }
      if (scholarTurnIndex < 0) continue;
      points.push({
        sessionId: file.sessionId,
        scholarIndex: scholarTurnIndex,
        tutorIndex: tutorTurnIndex,
        state: verdict.scholarState,
        originalMove: verdict.tutorMove,
        originalFit: verdict.stanceFit,
        anchored,
      });
    }
  }

  writeFileSync(
    join(out, "decision-points.json"),
    `${JSON.stringify(points, null, 2)}\n`,
    "utf8",
  );
  const byState: Record<string, number> = {};
  for (const point of points) byState[point.state] = (byState[point.state] ?? 0) + 1;
  console.log(`Wrote ${points.length} decision points`, byState);
  for (const [name, b] of Object.entries(split)) {
    const rate = b.turns ? ((100 * b.overQuestioning) / b.turns).toFixed(1) : "—";
    console.log(
      `${name}: sessions=${b.sessions} turns=${b.turns} over_socratic+funnel=${b.overQuestioning} (${rate}%)`,
    );
  }
}

main();
