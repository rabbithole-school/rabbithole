// The mission tools (TRA-519 B1), offered by missionToolOffer below — any
// session with a MISSION (lib/mission.ts), in the tutor or the builder stance;
// the doctrine is in prompts.ts buildTutorMissionSteering and
// buildVibecodeSection:
//
// - park_idea / unpark_idea: an idea not done now (no domain twin, or one
//   this activity cannot hold) is saved for later in the session's PARKING
//   LOT, where the scholar sees it as a chip — visibly, never refused.
// - save_question (TRA-682): a question about the world the scholar asks
//   mid-work, too big to answer in a sentence or two without leaving the
//   work, is saved as a starter in "Things to wonder about". The model tells
//   a question from a build idea by which tool it calls.
//
// The builder has no stay_silent: an app mission never holds a build, so no
// turn waits on an answer. The app-update stay_silent is staySilentTool.ts.
//
// Kept apart from tutorSessionTools.ts and appended AFTER the factory's tools,
// so the factory's tool order (and its prompt-cache prefix) is unchanged.
// Like the factory, this dynamically imports `betaTool` and does no static
// `@anthropic-ai/sdk` import.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js";
export const PARK_IDEA_TOOL_NAME = "park_idea";
export const UNPARK_IDEA_TOOL_NAME = "unpark_idea";
export const SAVE_QUESTION_TOOL_NAME = "save_question";

export const PARKING_LOT_LIMITS = {
  maxEntries: 30,
  maxChars: 200,
} as const;

export type ParkingLotEntry = {
  text: string;
  parkedAt: number;
  reason?: string;
};

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PARKING_LOT_LIMITS.maxChars
    ? flat
    : `${flat.slice(0, PARKING_LOT_LIMITS.maxChars - 1)}…`;
}

export type ParkingLotAppend =
  | { kind: "added"; lot: ParkingLotEntry[] }
  | { kind: "duplicate" }
  | { kind: "full" }
  | { kind: "empty" };

/**
 * Append one idea to a parking lot. Text and reason are whitespace-collapsed
 * and clipped to 200 characters; an idea already parked (same text, ignoring
 * case) is not parked twice; a lot at 30 entries takes no more — the oldest
 * ideas are the scholar's, so nothing is evicted.
 */
export function appendParkingLotEntry(
  existing: readonly ParkingLotEntry[] | undefined,
  idea: { text: string; reason?: string | null },
  parkedAt: number,
): ParkingLotAppend {
  const text = clip(idea.text ?? "");
  if (!text) return { kind: "empty" };
  const lot = existing ?? [];
  const key = text.toLowerCase();
  if (lot.some((entry) => entry.text.toLowerCase() === key)) {
    return { kind: "duplicate" };
  }
  if (lot.length >= PARKING_LOT_LIMITS.maxEntries) return { kind: "full" };
  const reason = idea.reason ? clip(idea.reason) : "";
  return {
    kind: "added",
    lot: [...lot, { text, parkedAt, ...(reason ? { reason } : {}) }],
  };
}

export type ParkingLotRemove =
  | { kind: "removed"; lot: ParkingLotEntry[] }
  | { kind: "missing" };

/**
 * Take one idea out of the lot once the designer builds it. Matches the text
 * exactly (ignoring case), else the first entry that contains it or that it
 * contains, so "the crossbow" finds "a crossbow for the anomalies".
 */
export function removeParkingLotEntry(
  existing: readonly ParkingLotEntry[] | undefined,
  text: string,
): ParkingLotRemove {
  const key = text.replace(/\s+/g, " ").trim().toLowerCase();
  const lot = existing ?? [];
  if (!key || lot.length === 0) return { kind: "missing" };
  let index = lot.findIndex((e) => e.text.toLowerCase() === key);
  if (index < 0) {
    // Every content word of the query appears in the entry ("the crossbow"
    // finds "A crossbow for the anomalies").
    const words = contentWords(key);
    if (words.length > 0) {
      index = lot.findIndex((e) => {
        const entryWords = new Set(contentWords(e.text.toLowerCase()));
        return words.every((w) => entryWords.has(w));
      });
    }
  }
  if (index < 0) return { kind: "missing" };
  return { kind: "removed", lot: lot.filter((_, i) => i !== index) };
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "with",
  "my", "it", "its", "that", "this", "some", "make", "add", "be", "able",
]);

function contentWords(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Which mission tools a turn is offered (TRA-519 B1). Pure, so the offer is
 * testable.
 *
 * park_idea / unpark_idea follow the prompt's MISSION steering exactly: any
 * turn of a session with a mission — the tutor stance (a writing, slides, map,
 * photo or recording activity, a side app, a Quest's planning chat) or the
 * builder stance on an Edit turn — whoever is typing (a teacher in remote view
 * included), since that steering tells the model to park. Never a teacher
 * build, free play (no mission), or Play.
 */
export function missionToolOffer(opts: {
  /** The session resolves a mission (lib/mission.ts resolveSessionMission). */
  hasMission: boolean;
  workshopMode: "edit" | "play";
  teacherBuild: boolean;
  /** A free-play session (TRA-489): no mission, nothing to park. */
  freePlay?: boolean;
}): { parkIdea: boolean } {
  return {
    parkIdea:
      opts.hasMission &&
      !opts.teacherBuild &&
      opts.freePlay !== true &&
      opts.workshopMode === "edit",
  };
}

/** What saving a starter did (sessions.saveStarterFromSession). */
export type SaveStarterResult =
  | "saved"
  | "duplicate"
  | "empty"
  | "notHere"
  | "alreadySaved";

/** The tool result the model reads after save_question. */
export function saveQuestionResultText(kind: SaveStarterResult): string {
  switch (kind) {
    case "saved":
      return "Saved. It waits in Things to wonder about on their Quests tab.";
    case "duplicate":
      return "Already saved; nothing changed.";
    case "notHere":
      return "Nothing was saved here; just answer them briefly or go on with the work.";
    default:
      return "Nothing was saved: the question was empty.";
  }
}

export async function makeDesignerTools(opts: {
  offer: { parkIdea: boolean };
  parkIdea: (idea: { text: string; reason?: string }) => Promise<ParkingLotAppend["kind"]>;
  unparkIdea: (text: string) => Promise<ParkingLotRemove["kind"]>;
  /** Save a question about the world as a starter (TRA-682). */
  saveQuestion?: (text: string) => Promise<SaveStarterResult>;
  /** Replace the scholar's "Something to figure out" question. */
  setProvocation?: (text: string) => Promise<"set" | "cleared">;
}): Promise<BetaRunnableTool[]> {
  if (!opts.offer.parkIdea) return [];
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  const tools: BetaRunnableTool[] = [];
  if (opts.offer.parkIdea) {
    tools.push(
      betaTool({
        name: PARK_IDEA_TOOL_NAME,
        description:
          "Save one of the scholar's ideas for later, where it waits as a chip they can see. When the activity is done they can build it or make it a Quest. Use it for an idea you are not doing now: one with no domain twin, one this activity cannot hold, or, outside an app, one asked before the mission's gate is met. Text is the idea in the scholar's own words (short): copy what they asked for and never add your own reading of it, such as a weapon they did not name; reason is a few plain words a nine-year-old reads easily, e.g. \"after your first draft\". Then tell them in one sentence that it is saved for later.",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: {
              type: "string" as const,
              description: "The idea, in the scholar's words. Under 200 characters.",
            },
            reason: {
              type: "string" as const,
              description: "Optional: why it waits, in a few plain words.",
            },
          },
          required: ["text"] as const,
          additionalProperties: false,
        },
        run: async (input: { text: string; reason?: string }) => {
          const kind = await opts.parkIdea(input);
          switch (kind) {
            case "added":
              return "Parked. It now shows in the scholar's parking lot.";
            case "duplicate":
              return "Already parked; nothing changed.";
            case "full":
              return "The parking lot is full (30 ideas). Nothing was parked; just tell the scholar it will have to wait.";
            default:
              return "Nothing was parked: the idea text was empty.";
          }
        },
      }) as BetaRunnableTool,
    );
  }
  if (opts.offer.parkIdea) {
    tools.push(
      betaTool({
        name: UNPARK_IDEA_TOOL_NAME,
        description:
          "Take an idea out of the scholar's saved-for-later list: because you are starting it now (its domain twin is what you are doing, or what it waited on is done), or because the scholar says the saved version is not what they meant or that they no longer want it. When starting it, call it in the same turn, before you start it (before create_code / str_replace_based_edit_tool when it is a build). When they correct it, call it in that same turn, then park_idea their corrected words only if they still want the idea and it still has to wait. Pass the idea's text as it was saved.",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: {
              type: "string" as const,
              description: "The parked idea's text (or enough of it to match).",
            },
          },
          required: ["text"] as const,
          additionalProperties: false,
        },
        run: async (input: { text: string }) => {
          const kind = await opts.unparkIdea(input.text);
          return kind === "removed"
            ? "Unparked. It no longer shows in the parking lot."
            : "Nothing matched that text in the parking lot; nothing changed.";
        },
      }) as BetaRunnableTool,
    );
  }
  if (opts.offer.parkIdea && opts.saveQuestion) {
    const saveQuestion = opts.saveQuestion;
    tools.push(
      betaTool({
        name: SAVE_QUESTION_TOOL_NAME,
        description:
          "Save a question about the world the scholar asked, one you can't answer in a sentence or two without leaving the work, so they can ask it later. It waits in \"Things to wonder about\" on their Quests tab, saying what they were building. A question is something they want to know (why, how, what is true); an idea for something to make or build goes to park_idea instead. Text is their question in their own words, as one question they'd want to read back later; never add your own angle. Then tell them in one sentence that it is saved on their Quests tab, and go back to the work.",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: {
              type: "string" as const,
              description: "The question, in the scholar's words. Under 200 characters.",
            },
          },
          required: ["text"] as const,
          additionalProperties: false,
        },
        run: async (input: { text: string }) =>
          saveQuestionResultText(await saveQuestion(input.text)),
      }) as BetaRunnableTool,
    );
  }
  if (opts.offer.parkIdea && opts.setProvocation) {
    const setProvocation = opts.setProvocation;
    tools.push(
      betaTool({
        name: "set_provocation",
        description:
          "Set the ONE open question shown in the scholar's Flair tab under \"Something to figure out\". It replaces the previous one. Not after every build: only when the app has a mechanism worth wondering about. The scholar must be able to answer it by changing one thing and watching one thing in their own app. It names things and rules, never their numbers, and you never answer it for them. Pass empty text to clear it once they have figured it out. Do not mention the question in your chat reply; it lives in the Flair tab.",
        inputSchema: {
          type: "object" as const,
          properties: {
            text: {
              type: "string" as const,
              description:
                "The question, in plain words a nine-year-old reads easily, under 140 characters. Empty clears it.",
            },
          },
          required: ["text"] as const,
          additionalProperties: false,
        },
        run: async (input: { text: string }) => {
          const kind = await setProvocation(input.text);
          return kind === "set"
            ? "Set. It shows in the scholar's Flair tab."
            : "Cleared.";
        },
      }) as BetaRunnableTool,
    );
  }
  return tools;
}
