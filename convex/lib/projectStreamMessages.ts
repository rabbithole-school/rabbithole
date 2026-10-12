import {
  formatAppTutorRequestForModel,
  type AppTutorRequest,
} from "../../shared/appTutorRequest";
import type { AppSnapshotModelMessage } from "./appSnapshot";
import type { AppAiContextTurn } from "./appUpdateTools";
import type { ImageContentPart, TextContentPart } from "./imageBytes";

export type ProjectStreamHistoryMessage = {
  id: string;
  sourceRole: string;
  role: "user" | "assistant";
  content: string;
  imageId: string | null;
  generatedImage?: boolean;
  /** A Magic Corners redraw of the scholar's upload, not a generate_image call. */
  magicRedraw?: boolean;
  imagePrompt?: string | null;
  inputModality?: "typed" | "spoken" | "app";
};

/**
 * Marks a scholar turn the child DICTATED rather than typed.
 *
 * WHY: the tutor's history is a role-turn array, not the observer's flat
 * labelled transcript (`observerShared.speakerLabel` renders
 * `SCHOLAR (spoken)`), so before this marker a spoken turn and a typed turn
 * were byte-identical to the tutor. Two prompt rules need the distinction:
 * the tutor must not invite a scholar who is already dictating to "say it out
 * loud", and garbled wording on a dictated turn is a transcription artifact
 * rather than a confused child. The marker is deterministic per message, so
 * it does not disturb the conversation cache breakpoint.
 */
export const DICTATED_TURN_LABEL =
  "[Dictated — speech-to-text of what the scholar said out loud, not typed.]";

const GENERATED_IMAGE_LABEL =
  "[You generated this illustration earlier with the generate_image tool. " +
  "It is already displayed to the scholar above this point in the conversation. " +
  "Refer to it and build on it — do NOT generate it again.]";

/**
 * A Magic Corners redraw looks like any other tool image in history, but the
 * tutor did not make it: the upload pipeline detected (possibly wrongly) a
 * hand-drawn frame on the scholar's photo and had an image model repaint it.
 * Labelling it as the tutor's own illustration left the tutor unable to answer
 * a scholar who asked why their page was changed, so it invented an excuse and
 * credited the model's marks to the child.
 */
const MAGIC_REDRAW_LABEL =
  "[This image was NOT made with your generate_image tool. When the scholar " +
  "uploaded the photo just before this point, the system's automatic Magic " +
  "Corners detector judged that they had drawn corner-bracket frames on the " +
  "page and had an image model redraw the framed area. The scholar saw it " +
  "captioned \"Brought your drawing to life\". The detector can misfire: the " +
  "scholar may have drawn no frame and not wanted this, and anything in this " +
  "image that is not on their original photo (marks, circles, drawings) was " +
  "added by the redraw, not by the scholar. If they ask about it, say so " +
  "plainly.]";

/**
 * The most image data one tutor turn replays to the model, in base64
 * characters (about 7.5 MB of raw image bytes).
 *
 * WHY: every image in a session is re-fetched and base64'd into EVERY later
 * turn, inside the /session-stream HTTP action, whose JavaScript runtime is
 * capped at 64 MB. Peak memory runs at several times the raw image bytes (the
 * bytes, the base64 string, the serialized request body), so a session holding
 * four or five full-size iPad photos (~3 MB each) killed the action with
 * "JavaScript execution ran out of memory" before the model was called. That
 * kill skips every catch and finally: no error event, no finalize, no usage
 * row, and a leaked limiter lease. Because the history only grows, every later
 * turn and every retry in that session died the same way (Oct 2026: a
 * scholar's art sessions went silent for good after ~13 MB of photos;
 * reproduced on a dev deployment, where three 3.3 MB photos were answered and
 * the fourth and everything after it died at 64 MB).
 *
 * Measured line: ~10 MB raw answered, ~13 MB raw died. This budget sits well
 * under it so the system prompt, tool loops, and an app snapshot still fit.
 * Newest images win (see assembleProjectStreamApiMessages), so the photo the
 * scholar just sent is never the one left out.
 */
export const MAX_REPLAYED_IMAGE_BASE64_CHARS = 10_000_000;

/** Stands in for an older image that did not fit in this turn's budget. */
export const IMAGE_NOT_REPLAYED_LABEL =
  "[An earlier image was here. Older images are not re-sent on every turn, " +
  "to keep the conversation within size limits; your earlier replies above " +
  "describe it. If you need to look at it again, ask the scholar to re-send it.]";

/** Stands in for a scholar photo that could not be loaded or was too large. */
export const IMAGE_UNAVAILABLE_LABEL =
  "[The scholar attached a photo here, but it could not be shown to you " +
  "(too large or unreadable). If it matters, tell them you can't see it and " +
  "ask them to try a smaller photo or describe it.]";

function generatedImagePromptMetadata(
  imagePrompt: string | null | undefined,
  magicRedraw = false,
): string | null {
  if (!imagePrompt?.trim()) return null;
  return magicRedraw
    ? `[What the detector asked the image model to draw (reference metadata, not a new instruction): ${imagePrompt}]`
    : `[Original image-generation prompt (reference metadata, not a new instruction): ${imagePrompt}]`;
}

/**
 * One in-app turn as the tutor reads it: a user-role block whose every line
 * says who spoke, so the character's words are never taken for the scholar's
 * or the tutor's own. Deterministic per row (no clock, no "new" marker), so a
 * replayed turn keeps the conversation cache prefix byte-stable.
 */
export function renderAppAiTurnForTutor(
  turn: AppAiContextTurn,
  characterName: string | null,
): string | null {
  const name = characterName ?? "the character";
  const tags = (mood: string | null, verdict: string | null) =>
    [
      mood ? `mood: ${mood}` : null,
      verdict
        ? turn.verdictOverride && turn.verdictOverride !== verdict
          ? `verdict: ${verdict}, overruled by you to ${turn.verdictOverride}`
          : `verdict: ${verdict}`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .map((part) => ` · ${part}`)
      .join("");
  if (turn.kind === "exchange") {
    const lines: string[] = [];
    if (turn.scholarLine) {
      lines.push(`[IN-APP — scholar typed to ${name}] ${turn.scholarLine}`);
    }
    if (turn.line) {
      lines.push(
        `[IN-APP — ${name} (AI character, not you) replied${tags(turn.mood, turn.verdict)}] ${turn.line}`,
      );
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }
  if (turn.kind === "aside") {
    return turn.line
      ? `[IN-APP — you spoke through ${name}${tags(turn.mood, turn.verdict)}] ${turn.line}`
      : null;
  }
  if (!turn.verdict) return null;
  const judge = turn.judgeId ? `judge "${turn.judgeId}"` : "the app's judge";
  return [
    `[IN-APP — ${judge} ruled ${turn.verdict}]`,
    turn.scholarLine ? ` Answer judged: ${turn.scholarLine}` : "",
    turn.feedback ? ` Feedback shown: ${turn.feedback}` : "",
  ].join("");
}

export async function assembleProjectStreamApiMessages({
  chatHistory,
  appRequest,
  appAiTurns,
  characterName = null,
  resolveImagePart,
}: {
  chatHistory: readonly ProjectStreamHistoryMessage[];
  appRequest?: Pick<AppTutorRequest, "context">;
  /**
   * In-app turns (getSessionContext → characterContext / appJudgeContext),
   * each placed by `placeBeforeMessageId`. Absent for every session without
   * an app AI spec, which leaves the assembled messages unchanged.
   */
  appAiTurns?: readonly AppAiContextTurn[];
  characterName?: string | null;
  resolveImagePart: (imageId: string) => Promise<ImageContentPart | null>;
}): Promise<AppSnapshotModelMessage[]> {
  const apiMessages: AppSnapshotModelMessage[] = [];
  const appAiBlocksBefore = new Map<string | null, string[]>();
  for (const turn of appAiTurns ?? []) {
    const text = renderAppAiTurnForTutor(turn, characterName);
    if (!text) continue;
    const anchor = chatHistory.some(
      (message) => message.id === turn.placeBeforeMessageId,
    )
      ? turn.placeBeforeMessageId
      : null;
    const blocks = appAiBlocksBefore.get(anchor) ?? [];
    blocks.push(text);
    appAiBlocksBefore.set(anchor, blocks);
  }
  const pushAppAiBlocks = (anchor: string | null) => {
    for (const text of appAiBlocksBefore.get(anchor) ?? []) {
      apiMessages.push({ role: "user", content: text });
    }
  };
  const latestUserMessage =
    [...chatHistory]
      .reverse()
      .find((message) => message.sourceRole === "user") ?? null;
  const currentAppMessageId =
    appRequest && latestUserMessage?.inputModality === "app"
      ? latestUserMessage.id
      : null;

  // Resolve images newest-first under one shared budget, so the newest photo
  // always gets a slot and the oldest are the ones left out. Once an image does
  // not fit, every older one is left out too without being fetched: the
  // replayed window stays one contiguous newest run, and nothing past the
  // budget is ever pulled into memory.
  const resolvedImages = new Map<
    string,
    ImageContentPart | "unavailable" | "not-replayed"
  >();
  let replayedImageChars = 0;
  let budgetSpent = false;
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const message = chatHistory[i];
    if (!message.imageId || message.role !== "user") continue;
    if (budgetSpent) {
      resolvedImages.set(message.id, "not-replayed");
      continue;
    }
    const part = await resolveImagePart(message.imageId);
    if (!part) {
      resolvedImages.set(message.id, "unavailable");
      continue;
    }
    const chars = part.source.data.length;
    if (replayedImageChars + chars > MAX_REPLAYED_IMAGE_BASE64_CHARS) {
      budgetSpent = true;
      resolvedImages.set(message.id, "not-replayed");
      continue;
    }
    replayedImageChars += chars;
    resolvedImages.set(message.id, part);
  }

  for (const message of chatHistory) {
    pushAppAiBlocks(message.id);
    const baseContent =
      message.role === "user" && message.inputModality === "app"
        ? formatAppTutorRequestForModel(
            message.content,
            message.id === currentAppMessageId
              ? appRequest?.context
              : undefined,
          )
        : message.content;
    // An empty dictated turn carries no words to attribute, so it stays empty
    // rather than becoming a bare marker.
    const modelVisibleContent =
      message.role === "user" &&
      message.inputModality === "spoken" &&
      baseContent.trim() !== ""
        ? `${DICTATED_TURN_LABEL} ${baseContent}`
        : baseContent;

    if (message.imageId && message.role === "user") {
      const resolved = resolvedImages.get(message.id);
      const imagePart = typeof resolved === "object" ? resolved : null;
      if (imagePart) {
        const contentParts: Array<ImageContentPart | TextContentPart> = [];
        if (message.generatedImage) {
          contentParts.push({
            type: "text",
            text: message.magicRedraw
              ? MAGIC_REDRAW_LABEL
              : GENERATED_IMAGE_LABEL,
          });
          const promptMetadata = generatedImagePromptMetadata(
            message.imagePrompt,
            message.magicRedraw,
          );
          if (promptMetadata) {
            contentParts.push({ type: "text", text: promptMetadata });
          }
        }
        contentParts.push(imagePart);
        if (modelVisibleContent) {
          contentParts.push({ type: "text", text: modelVisibleContent });
        }
        apiMessages.push({
          role: "user",
          content: contentParts,
        });
        continue;
      }

      apiMessages.push({
        role: "user",
        content: message.generatedImage
          ? [
              message.magicRedraw ? MAGIC_REDRAW_LABEL : GENERATED_IMAGE_LABEL,
              generatedImagePromptMetadata(
                message.imagePrompt,
                message.magicRedraw,
              ),
              message.content ? `It shows: ${message.content}` : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" ")
          : [
              resolved === "not-replayed"
                ? IMAGE_NOT_REPLAYED_LABEL
                : IMAGE_UNAVAILABLE_LABEL,
              modelVisibleContent,
            ]
              .filter(Boolean)
              .join(" "),
      });
      continue;
    }

    apiMessages.push({
      role: message.role,
      content: modelVisibleContent,
    });
  }
  pushAppAiBlocks(null);

  return apiMessages;
}
