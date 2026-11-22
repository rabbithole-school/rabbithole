/**
 * The tutor's open_python_bench tool: it attaches the canonical Python bench
 * (apps/python-bench/, copied into ./pythonBenchApp.generated.ts) to the
 * current session as its live app. The scholar gets the same card beside the
 * chat, and the same full-screen builder on Open, that a create_code app gets,
 * on the web and the iPad.
 *
 * Why it is NOT gated by SCHOLAR_LED_APP_BUILDING (shared/missionCopy.ts, off
 * since 2026-10-27): that switch stops the tutor building NEW apps outside a
 * teacher's activity, the vibecoding drift where the AI writes the thing and
 * the scholar watches. The bench is the opposite: a fixed, reviewed tool whose
 * code no AI writes, where the scholar types every line of their program.
 * Andy's ruling (2026-11-10), after a scholar's self-initiated quest asked
 * "Can I code in Python in quests?" and the tutor, correctly under the old
 * rules, said no and the scholar left: the tutor opens the bench itself;
 * "ask your teacher" is not good enough.
 *
 * Anti-offloading by construction:
 * - The tool takes NO input, so the tutor cannot preload or write code.
 * - The attached artifact carries `fixedApp: "python-bench"`, and every AI
 *   write path refuses it (artifacts.aiReplaceApp / aiStrReplace / aiInsert),
 *   so the tutor cannot smuggle code into the bench through create_code or the
 *   app editor either. aiCreate refuses a second app beside it, in the same
 *   transaction as the insert, and no tool reads its source.
 * - The bench has no registerAction and never calls askTutor
 *   (convex/__tests__/pythonBench.test.ts), so run_app_action cannot touch it.
 */
import type { Id } from "../_generated/dataModel";
import { inflateRaw } from "./inflateRaw";
import type { MissionActivity, MissionUnit } from "./mission";
import { isAppActivity } from "../../shared/appSurface";
import { isQuestUnit } from "./mission";
import {
  PYTHON_BENCH_ACTIVITY,
  PYTHON_BENCH_BRIEF,
  PYTHON_BENCH_HTML,
} from "./pythonBenchApp.generated";

export const OPEN_PYTHON_BENCH_TOOL_NAME = "open_python_bench" as const;
export const PYTHON_BENCH_FIXED_APP = "python-bench" as const;
export const PYTHON_BENCH_TITLE: string = PYTHON_BENCH_ACTIVITY.title;
export { PYTHON_BENCH_BRIEF, PYTHON_BENCH_HTML };

/**
 * Is open_python_bench offered in this session? In a chat session (the
 * conversation surface, where an app is a card beside the chat): a Quest step,
 * a Quest's planning chat, an open chat with no activity, and a teacher's
 * activity, where the bench is a side project. Never where the session's app
 * IS the work (an app activity or any builder-primary session), never in the
 * Workbench, and never in free play. Whether the session already has an app is
 * decided when the tool runs, so the refusal can say why.
 */
export function mayOpenPythonBench(args: {
  sessionMode: "conversation" | "workbench" | "vibecode" | null | undefined;
  /** The builder is the session's primary view (sessionAppContextFor). */
  builderPrimary: boolean;
  freePlay?: boolean | null;
  activity: MissionActivity | null | undefined;
  /** Kept for the descriptor's wording; not part of the gate. */
  unit?: MissionUnit | null | undefined;
}): boolean {
  if ((args.sessionMode ?? "conversation") !== "conversation") return false;
  if (args.builderPrimary || args.freePlay === true) return false;
  if (args.activity && isAppActivity(args.activity)) return false;
  return true;
}

export type PythonBenchSessionKind = "teacherActivity" | "quest" | "open";

/** The bench facts the tutor prompt and tool list need, per session. */
export type PythonBenchContext = {
  /** open_python_bench is offered (mayOpenPythonBench). */
  offered: boolean;
  /** The bench is already this session's app. */
  open: boolean;
  /** The session already holds another app, so the bench cannot open. */
  otherApp: boolean;
  kind: PythonBenchSessionKind;
  /** A tile session's bench (lib/tileSessions.ts): Play is the only mode
   *  there and no activity brief carries the bench's rules, so the PYTHON
   *  BENCH section stays in the Play prompt. Absent = false. */
  keepInPlay?: boolean;
};

/** Which kind of chat the bench opens in, for the steer-back wording. */
export function pythonBenchSessionKind(args: {
  activity: MissionActivity | null | undefined;
  unit: MissionUnit | null | undefined;
}): PythonBenchSessionKind {
  if (args.activity && !isQuestUnit(args.unit)) return "teacherActivity";
  if (isQuestUnit(args.unit)) return "quest";
  return "open";
}

/**
 * The artifact row that makes the canonical bench a session's app, byte-
 * identical to the generated source. The one place it is built: the tutor's
 * open_python_bench (artifacts.aiOpenPythonBench) and a Python Quest's session
 * setup (lib/sessionActivitySetup.ts) both insert exactly this.
 */
export function pythonBenchArtifactRow(sessionId: Id<"sessions">) {
  return {
    sessionId,
    title: PYTHON_BENCH_TITLE,
    content: PYTHON_BENCH_HTML,
    lastEditedBy: "ai" as const,
    revision: 0,
    type: "code" as const,
    language: "html",
    fixedApp: PYTHON_BENCH_FIXED_APP,
  };
}

/**
 * The scholar's program out of the bench's saved app state: the whole file
 * when it fits the tutor's view (`code`), else the saved copy in `workspace`
 * ("text," plain, or deflate-raw base64, inflated by lib/inflateRaw.ts).
 * Null when nothing readable is saved, which includes a program that grew too
 * long to save (`codeNotSaved`). The bench's own starter text comes back as it
 * is: callers decide whether it counts (tileSessions savedDocHoldsWork).
 */
/** Upper bound on an inflated program (the bench caps its saved doc far lower). */
const WORKSPACE_MAX_BYTES = 1024 * 1024;

export function programFromBenchDoc(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const { code, workspace } = doc as { code?: unknown; workspace?: unknown };
  if (typeof code === "string") return code;
  if (typeof workspace !== "string") return null;
  if (workspace.startsWith("text,")) return workspace.slice(5);
  const prefix = "deflate-raw;base64,";
  if (!workspace.startsWith(prefix)) return null;
  try {
    const bin = atob(workspace.slice(prefix.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    // The Convex runtime has no DecompressionStream; inflateRaw is pure JS.
    return new TextDecoder().decode(inflateRaw(bytes, WORKSPACE_MAX_BYTES));
  } catch {
    return null;
  }
}

/** The artifact is the bench (or another fixed app no AI may change). */
export function isFixedApp(artifact: { fixedApp?: string | null }): boolean {
  return typeof artifact.fixedApp === "string" && artifact.fixedApp.length > 0;
}

/** Returned to the tutor by every AI write the bench refuses. */
export const FIXED_APP_WRITE_REFUSAL =
  "FIXED_APP: this app is the Python bench. Its code is fixed, and no tool reads or changes it: the scholar writes every line of their own program inside it. Nothing was changed. Talk with them about their program instead (you see it in LIVE APP STATE).";

/** create_code new_app while the bench is the session's app. */
export const BENCH_IS_THE_APP_REFUSAL =
  "BENCH_OPEN: this session's app is the Python bench, and a session holds one app, so no new app was built. Nothing was changed.";

export function pythonBenchOpenedMessage(artifactId: string): string {
  return `The Python bench is open: it shows as a card beside the chat, and Open takes it full screen. Document ID: ${artifactId}. Its editor starts with the bench's own short example, never anything from you. Tell the scholar in one or two short lines that it is there and that they write and run the code; then let them start. Their program, output, errors and stepping arrive in LIVE APP STATE from now on.`;
}

export type PythonBenchRefusal = "has_bench" | "has_app" | "not_offered";

export function pythonBenchRefusalMessage(reason: PythonBenchRefusal): string {
  switch (reason) {
    case "has_bench":
      return "ALREADY_OPEN: the Python bench is already this session's app (listed under DOCUMENTS). Nothing new was opened. Point the scholar to the card beside the chat (Open takes it full screen).";
    case "has_app":
      return "SESSION_HAS_APP: this session already has an app (listed under DOCUMENTS), and a session holds one app, so the bench was not opened. Tell the scholar plainly: the bench opens in a session without an app, such as a new chat they start from Home.";
    case "not_offered":
      return "NOT_AVAILABLE: the Python bench does not open in this session. Nothing was opened.";
  }
}
