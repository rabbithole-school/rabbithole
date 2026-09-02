"use client";

/**
 * SpeakableLabel — a tap-to-hear primitive.
 *
 * Wraps any label (a tile name, a seed/star hook, a card title) and speaks it
 * aloud through the EXISTING TTS path — the same module-singleton `TTSEngine`
 * the session's voice mode uses (hooks/useTTSQueue.ts → Convex `/tts`). No new
 * backend, no new audio path. Built for pre-readers who navigate by picture +
 * audio (young-learners plan §6), but it quietly serves anyone in voice mode —
 * hearing the word while seeing it.
 *
 * Contract:
 *  - One utterance app-wide (the engine is a singleton). Tapping ANY speaker
 *    stops whatever was playing and plays this one — audio never overlaps.
 *  - Tapping the SAME speaker while it's speaking stops it (toggle).
 *  - Only the label that started the current utterance shows the speaking/stop
 *    state, tracked by a module-level owner token (below) — not the shared
 *    engine state, which every instance would otherwise reflect.
 *  - Respects `ttsEnabled` (useCurrentUser): when TTS is off the children render
 *    completely unadorned (no icon, no tap handler).
 *
 * API: pass `text` to speak, and/or `children` as the visible label. Visible
 * content defaults to `children ?? text`; the spoken text defaults to
 * `text ?? <children when it's a plain string>`.
 */

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Box, IconButton, Tooltip, Portal } from "@chakra-ui/react";
import { SpeakerHigh, Pause, Play } from "@phosphor-icons/react";
import { useTTSQueue } from "@/hooks/useTTSQueue";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isLikelyMuted } from "@/lib/native";
import { toaster } from "@/lib/toaster";

// ── Module-level owner token ────────────────────────────────────────────────
// The TTS engine is a single shared instance, so its "speaking" state is global.
// To show the speaking/stop affordance on ONLY the label that started the
// current utterance, we track which instance currently owns the engine. Claiming
// ownership steals it from any other label (which re-renders back to idle).
let ownerToken: symbol | null = null;
const ownerListeners = new Set<() => void>();

function notifyOwner(): void {
  ownerListeners.forEach((fn) => fn());
}
function claimOwner(token: symbol): void {
  ownerToken = token;
  notifyOwner();
}
function releaseOwner(token: symbol): void {
  if (ownerToken === token) {
    ownerToken = null;
    notifyOwner();
  }
}
function subscribeOwner(fn: () => void): () => void {
  ownerListeners.add(fn);
  return () => ownerListeners.delete(fn);
}

export interface SpeakableLabelProps {
  /** Text to speak. Falls back to `children` when it's a plain string. */
  text?: string;
  /** The visible label. Defaults to `text` when omitted. */
  children?: ReactNode;
  /** Tap the whole label (not just the speaker icon) to hear it. */
  tapAnywhere?: boolean;
  /** Side the speaker icon sits on. Default "after". */
  iconPlacement?: "before" | "after";
  /** Hide the speaker icon (only sensible with `tapAnywhere`). */
  hideIcon?: boolean;
  /** Speaker icon size in px. Default 14. */
  iconSize?: number;
  /** aria-label for the speak control. Default "Hear <text>" / "Read aloud". */
  ariaLabel?: string;
}

/** Extract a plain string from children when possible (for the spoken text). */
function stringFromChildren(children: ReactNode): string {
  return typeof children === "string" || typeof children === "number"
    ? String(children)
    : "";
}

export function SpeakableLabel({
  text,
  children,
  tapAnywhere = false,
  iconPlacement = "after",
  hideIcon = false,
  iconSize = 14,
  ariaLabel,
}: SpeakableLabelProps) {
  const { user } = useCurrentUser();
  const ttsEnabled = user?.ttsEnabled !== false;

  const { state, speak, pause, resume } = useTTSQueue();

  // Stable per-instance token; identity is what the owner registry compares.
  const [token] = useState(() => Symbol("speakable"));

  const isOwner = useSyncExternalStore(
    subscribeOwner,
    () => ownerToken === token,
    () => false,
  );
  const speaking = isOwner && state === "speaking";
  const paused = isOwner && state === "paused";

  // Hand back ownership once the engine drains, so the affordance resets.
  useEffect(() => {
    if (state === "idle") releaseOwner(token);
  }, [state, token]);

  // Relinquish ownership if this instance unmounts mid-utterance.
  useEffect(() => () => releaseOwner(token), [token]);

  const spokenText = (text ?? stringFromChildren(children)).trim();
  const visible = children ?? text;

  const handleSpeak = useCallback(async () => {
    if (!spokenText) return;
    // Tapping the active speaker toggles pause/resume (it keeps ownership, so
    // the same label stays lit). Starting a different label stops this one.
    if (speaking) {
      pause();
      return;
    }
    if (paused) {
      resume();
      return;
    }
    // iPad muted → "read aloud" would play nothing with no feedback. Nudge the
    // volume up instead (same guard the session's read-aloud uses).
    if (await isLikelyMuted()) {
      toaster.error({
        title: "Turn up the volume",
        description: "Ready to read aloud, but this device's volume is all the way down.",
      });
      return;
    }
    claimOwner(token); // steal from any other speaking label; serialize audio
    speak(spokenText);
  }, [spokenText, speaking, paused, pause, resume, speak, token]);

  // TTS off, or nothing to say → render the label untouched.
  if (!ttsEnabled || !spokenText) return <>{visible}</>;

  const label = ariaLabel ?? (spokenText ? `Hear "${spokenText}"` : "Read aloud");
  const active = speaking || paused;
  const controlLabel = speaking
    ? "Pause reading"
    : paused
      ? "Resume reading"
      : label;

  const icon = hideIcon ? null : (
    <Tooltip.Root
      openDelay={400}
      closeDelay={0}
      positioning={{ placement: "top" }}
    >
      <Tooltip.Trigger asChild>
        <IconButton
          aria-label={controlLabel}
          size="2xs"
          variant="ghost"
          color={active ? "violet.600" : "charcoal.300"}
          _hover={{ color: "violet.600", bg: "violet.50" }}
          _active={{ transform: "scale(0.9)" }}
          borderRadius="full"
          css={speaking ? { animation: "tts-pulse 2s ease-in-out infinite" } : undefined}
          onClick={(e) => {
            // When the whole label is tappable, let the wrapper handle it once.
            if (tapAnywhere) return;
            e.stopPropagation();
            void handleSpeak();
          }}
        >
          {speaking ? (
            <Pause size={iconSize} weight="fill" />
          ) : paused ? (
            <Play size={iconSize} weight="fill" />
          ) : (
            <SpeakerHigh size={iconSize} />
          )}
        </IconButton>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content fontSize="xs">
            {speaking ? "Pause" : paused ? "Resume" : "Read aloud"}
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );

  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap={1}
      cursor={tapAnywhere ? "pointer" : undefined}
      role={tapAnywhere ? "button" : undefined}
      aria-label={tapAnywhere ? controlLabel : undefined}
      tabIndex={tapAnywhere ? 0 : undefined}
      onClick={
        tapAnywhere
          ? (e) => {
              e.stopPropagation();
              void handleSpeak();
            }
          : undefined
      }
      onKeyDown={
        tapAnywhere
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void handleSpeak();
              }
            }
          : undefined
      }
    >
      {iconPlacement === "before" && icon}
      {visible}
      {iconPlacement === "after" && icon}
    </Box>
  );
}
