/**
 * Drives the REAL bake for a topic by invoking the dev-only internal action
 * `internal.bakeEval.bakeTopicForEval` via `npx convex run` against the
 * worktree's dev deployment, and parses the returned activity + latency.
 *
 * Why shell out: the bake is an INTERNAL Convex action (not public), and its
 * tools write to a live deployment — so we can't call it from a plain client.
 * `npx convex run` is the standard dev path for invoking internal functions
 * (it uses CONVEX_DEPLOYMENT from .env.local). This keeps the bake faithful (it
 * runs the exact production code path) without adding any public surface.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BakedActivity, Topic } from "./arms";

const execFileAsync = promisify(execFile);

export type BakeResult = {
  ms: number;
  activity: BakedActivity;
};

/** Deterministic offline stand-in so the harness wiring runs without a backend. */
export function stubBake(topic: Topic): BakeResult {
  return {
    ms: 90_000,
    activity: {
      title: topic.topic.slice(0, 60),
      systemPrompt: `Guide the scholar to discover ${topic.learningGoal}. Ask one question at a time; never hand them the answer.`,
      deliverablePrompt: `Explain, in your own words or a labeled sketch, ${topic.learningGoal}.`,
      durationMinutes: 12,
      design: {
        title: topic.topic.slice(0, 60),
        description: topic.rationale ?? null,
        systemPrompt: null,
        bigIdea: topic.learningGoal,
        essentialQuestions: [`What pattern could explain ${topic.topic.toLowerCase()}?`],
        enduringUnderstandings: [topic.learningGoal],
        lessons: [
          {
            title: "Investigate the pattern",
            systemPrompt: null,
            durationMinutes: 12,
            activities: [
              {
                title: topic.topic.slice(0, 60),
                description: `Investigate evidence for ${topic.topic.toLowerCase()}.`,
                kind: "online",
                systemPrompt: `Guide the scholar to discover ${topic.learningGoal}. Ask one question at a time; never hand them the answer.`,
                durationMinutes: 12,
                deliverable: {
                  kind: "text",
                  mode: "auto",
                  prompt: `Explain, in your own words or a labeled sketch, ${topic.learningGoal}.`,
                  notes: "Look for an explanation grounded in the scholar's evidence.",
                  criteria: [],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

/**
 * Run the real bake for one topic. Returns the produced first-online activity +
 * the wall-clock bake latency (the cost the in-place upgrade hides).
 */
export async function bakeTopic(topic: Topic, offline: boolean): Promise<BakeResult> {
  if (offline) return stubBake(topic);

  const payload = JSON.stringify({
    topic: topic.topic,
    domain: topic.domain,
    rationale: topic.rationale,
    connectionTo: topic.connectionTo,
    readingLevel: topic.readingLevel,
  });

  // `npx convex run <fn> <json>` prints the function's return value as JSON on
  // stdout. Give it a generous buffer + timeout (a bake is multi-call, ~1-2min).
  const { stdout } = await execFileAsync(
    "npx",
    ["convex", "run", "bakeEval:bakeTopicForEval", payload],
    { maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60_000 },
  );

  const parsed = parseConvexRunJson(stdout);
  if (!parsed || parsed.ok !== true) {
    throw new Error(
      `bakeTopic(${topic.id}): bake failed — ${
        parsed && "reason" in parsed ? parsed.reason : "unparseable output"
      }`,
    );
  }
  return { ms: parsed.ms as number, activity: parsed.activity as BakedActivity };
}

/** `convex run` prints the JSON result; pull the last JSON object from stdout. */
function parseConvexRunJson(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
