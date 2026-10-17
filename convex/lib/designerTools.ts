// The mission tools (TRA-519 B1), offered by missionToolOffer below — any
// session with a MISSION (lib/mission.ts), in the tutor or the builder stance;
// the doctrine is in prompts.ts buildTutorMissionSteering and
// buildVibecodeSection:
//
// - park_idea / unpark_idea: an idea not done now (no domain twin, or asked
//   before the mission's gate is met) is saved for later in the session's
//   PARKING LOT, where the scholar sees it as a chip — visibly, never refused.
// - stay_silent: builder only, with activities.allowSilence, a non-answer to
//   the designer's standing learning question ends the turn with nothing shown.
//
// Kept apart from tutorSessionTools.ts and appended AFTER the factory's tools,
// so the factory's tool order (and its prompt-cache prefix) is unchanged.
// Like the factory, this dynamically imports `betaTool` and does no static
// `@anthropic-ai/sdk` import.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js";
// One name for both stay_silent tools (this one and the app-update one in
// staySilentTool.ts); a turn is offered at most one of them. It lives in
// appUpdateTools.ts because that module must stay import-free for the schema.
import { STAY_SILENT_TOOL_NAME } from "./appUpdateTools";

export { STAY_SILENT_TOOL_NAME };
export const PARK_IDEA_TOOL_NAME = "park_idea";
export const UNPARK_IDEA_TOOL_NAME = "unpark_idea";

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
 * Which mission tools a turn is offered (TRA-519 B1). Pure, so the gate is
 * testable.
 *
 * park_idea / unpark_idea follow the prompt's MISSION steering exactly: any
 * turn of a session with a mission — the tutor stance (a writing, slides, map,
 * photo or recording activity, a side app, a Quest's planning chat) or the
 * builder stance on an Edit turn — whoever is typing (a teacher in remote view
 * included), since that steering tells the model to park. Never a teacher
 * build, free play (no mission), or Play.
 *
 * stay_silent stays builder-only, app-activity-only and teacher-opt-in
 * (allowSilence): it is tied to the builder's rule that the next build waits
 * on a standing learning question, and a silent tutor in a writing activity
 * reads as a dead tutor. It is the owner's only — silence toward anyone else
 * would read as a dead tutor too — and buildSystemPromptParts renders the
 * silence branch under the same owner condition.
 */
export function missionToolOffer(opts: {
  /** The session resolves a mission (lib/mission.ts resolveSessionMission). */
  hasMission: boolean;
  /** TRA-519: the session takes the builder stance (its app is the work). */
  builderStance: boolean;
  workshopMode: "edit" | "play";
  teacherBuild: boolean;
  /** The activity is an app activity (shared/appSurface.ts isAppActivity). */
  appActivity: boolean;
  allowSilence: boolean;
  callerIsSessionOwner: boolean;
  /** A free-play session (TRA-489): no mission, nothing to park, no silence. */
  freePlay?: boolean;
}): { parkIdea: boolean; staySilent: boolean } {
  const parkIdea =
    opts.hasMission &&
    !opts.teacherBuild &&
    opts.freePlay !== true &&
    opts.workshopMode === "edit";
  return {
    parkIdea,
    staySilent:
      parkIdea &&
      opts.builderStance &&
      opts.appActivity &&
      opts.allowSilence &&
      opts.callerIsSessionOwner,
  };
}

export async function makeDesignerTools(opts: {
  offer: { parkIdea: boolean; staySilent: boolean };
  parkIdea: (idea: { text: string; reason?: string }) => Promise<ParkingLotAppend["kind"]>;
  unparkIdea: (text: string) => Promise<ParkingLotRemove["kind"]>;
  onSilence: () => void;
}): Promise<BetaRunnableTool[]> {
  if (!opts.offer.parkIdea && !opts.offer.staySilent) return [];
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  const tools: BetaRunnableTool[] = [];
  if (opts.offer.parkIdea) {
    tools.push(
      betaTool({
        name: PARK_IDEA_TOOL_NAME,
        description:
          "Save one of the scholar's ideas for later, where it waits as a chip they can see. When the activity is done they can build it or make it a Quest. Use it for an idea you are not doing now: one asked before the gate is met, or one with no domain twin. Text is the idea in the scholar's own words (short); reason is a few plain words a nine-year-old reads easily, e.g. \"after your first draft\". Then tell them in one sentence that it is saved for later.",
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
              return "The parking lot is full (30 ideas). Nothing was parked; just tell the scholar it will have to wait for Free play.";
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
          "Take an idea out of the scholar's saved-for-later list because you are starting it now (the gate has been met, or its domain twin is what you are doing). Call it in the same turn, before you start it (before create_code / str_replace_based_edit_tool when it is a build), with the idea's text as it was saved.",
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
  if (opts.offer.staySilent) {
    tools.push(
      betaTool({
        name: STAY_SILENT_TOOL_NAME,
        description:
          "End this turn without saying anything to the scholar. Use it only while one of your learning questions is standing and their message is a non-answer (\"idk\", \"just build it\", the same demand again, exclamation marks, a different request). Call it before writing any text; nothing you write in this turn is shown, and your question still stands.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          additionalProperties: false,
        },
        run: async () => {
          opts.onSilence();
          return "Silent. The scholar sees nothing from this turn. Do not write anything.";
        },
      }) as BetaRunnableTool,
    );
  }
  return tools;
}
