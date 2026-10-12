// The App designer's two steering tools, offered only on a scholar's vibecode
// Edit turn when the activity carries a MODEL CONTRACT (activities.buildContract;
// the doctrine is in prompts.ts buildVibecodeSection):
//
// - park_idea: a request the assignment version will not build yet (no domain
//   twin, or asked before the contract's gate is met) goes into the session's
//   PARKING LOT for the scholar's Free play version — visibly, never refused.
// - stay_silent: with activities.allowSilence, a non-answer to the designer's
//   standing learning question ends the turn with nothing shown.
//
// Kept apart from tutorSessionTools.ts and appended AFTER the factory's tools,
// so every other turn's tool list (and its prompt-cache prefix) is unchanged.
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

/** Which designer tools a turn is offered. Pure, so the gate is testable. */
export function designerToolOffer(opts: {
  sessionMode: string | null | undefined;
  workshopMode: "edit" | "play";
  teacherBuild: boolean;
  hasBuildContract: boolean;
  allowSilence: boolean;
  callerIsSessionOwner: boolean;
  /** A free-play session (TRA-489): no contract, nothing to park, no silence. */
  freePlay?: boolean;
}): { parkIdea: boolean; staySilent: boolean } {
  // park_idea / unpark_idea follow the prompt's contract steering exactly: any
  // scholar-stance Edit turn under a MODEL CONTRACT, whoever is typing (a
  // teacher in remote view included), since that steering tells the model to
  // park. stay_silent is the owner's only — silence toward anyone else would
  // read as a dead tutor — and buildSystemPromptParts renders the silence
  // branch under the same owner condition.
  const designerTurn =
    opts.sessionMode === "vibecode" &&
    opts.workshopMode === "edit" &&
    !opts.teacherBuild &&
    opts.freePlay !== true &&
    opts.hasBuildContract;
  return {
    parkIdea: designerTurn,
    staySilent:
      designerTurn && opts.callerIsSessionOwner && opts.allowSilence,
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
          "Park one of the scholar's ideas for their Free play version, where it waits as a chip they can see. Use it for a request you are not building in this version: one asked before the model contract's gate is met, or one with no domain twin. Text is the idea in the scholar's own words (short); reason is a few plain words a nine-year-old reads easily, e.g. \"after the model runs\". Then tell them in one sentence that it is parked.",
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
          "Take an idea out of the scholar's parking lot because you are building it now (the gate has been met, or its domain twin is what you are building). Call it in the same turn as the build, before create_code / edit_document, with the idea's text as it was parked.",
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
