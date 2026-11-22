import { useCallback, useRef, useState } from "react";
import { Alert } from "react-native";

import { useLiveTalk, type LiveTalkKind, type LiveTalkMode } from "@/hooks/useLiveTalk";
import { useTalkTake, type TakeRecording } from "@/hooks/useTalkTake";
import { METER_FRAME_MS } from "@/lib/micLevel";
import {
  discardRecording,
  loadTakes,
  saveTake,
  type StoredTake,
} from "@/lib/rehearsalStore";

/** A take shorter than this was a mis-tap, not a talk. */
const MIN_TAKE_MS = 1000;

export type TalkPhase =
  | { kind: "presenting" }
  | { kind: "saving" }
  | { kind: "review"; takes: StoredTake[]; selected: number };

/**
 * A scholar presenting slides or an app, with recorded takes: the live link
 * to a BunnyPad at the back of the room (`useLiveTalk`), the take being
 * recorded (`useTalkTake`), and the review of saved takes after each one.
 * The slides and app screens share it, so both record, link and review the
 * same way. Takes are kept per `workKey` (the deck's or app's artifact id).
 */
export function useTalkSession({
  workKey,
  kind,
  mode,
  title,
  slideCount,
  slide,
}: {
  workKey: string;
  kind: LiveTalkKind;
  mode: LiveTalkMode;
  title: string;
  slideCount: number;
  /** The slide showing now, for slides; null for an app. */
  slide: { index: number; slideId: string } | null;
}) {
  const [phase, setPhase] = useState<TalkPhase>({ kind: "presenting" });
  const live = useLiveTalk({
    kind,
    mode,
    title,
    slideCount,
    slideIndex: slide?.index ?? 0,
  });

  const savingRef = useRef(false);
  const keepTake = useCallback(
    async (recording: TakeRecording) => {
      if (savingRef.current) return;
      savingRef.current = true;
      if (recording.audioUri && recording.durationMs >= MIN_TAKE_MS) {
        setPhase({ kind: "saving" });
      }
      const next = await storeTake(workKey, recording);
      savingRef.current = false;
      setPhase(next);
    },
    [workKey],
  );

  const take = useTalkTake({
    live,
    slide: phase.kind === "presenting" ? slide : null,
    onAutoStop: (recording) => void keepTake(recording),
  });

  const { stop: stopTake } = take;
  const stop = useCallback(() => {
    void stopTake().then((recording) => {
      if (recording) void keepTake(recording);
    });
  }, [keepTake, stopTake]);

  const presentAgain = useCallback(() => setPhase({ kind: "presenting" }), []);
  const selectTake = useCallback(
    (selected: number) =>
      setPhase((current) => (current.kind === "review" ? { ...current, selected } : current)),
    [],
  );

  return { phase, live, take, stop, presentAgain, selectTake };
}

/**
 * Saves a finished take on this BunnyPad and says what to show next: its
 * review, or (a mis-tap too short to keep) the earlier takes or presenting
 * again. Never throws; a failed save says so and goes back to presenting.
 */
async function storeTake(workKey: string, recording: TakeRecording): Promise<TalkPhase> {
  if (!recording.audioUri || recording.durationMs < MIN_TAKE_MS) {
    if (recording.audioUri) await discardRecording(recording.audioUri);
    const takes = await loadTakes(workKey).catch(() => []);
    return takes.length > 0
      ? { kind: "review", takes, selected: takes.length - 1 }
      : { kind: "presenting" };
  }
  try {
    const takes = await saveTake(
      workKey,
      {
        version: 1,
        id: recording.id,
        recordedAt: recording.recordedAt,
        durationMs: recording.durationMs,
        frameMs: METER_FRAME_MS,
        levels: recording.levels,
        slides: recording.slides,
      },
      recording.audioUri,
    );
    return { kind: "review", takes, selected: takes.length - 1 };
  } catch (error) {
    console.warn("[talk] saving a take failed", error);
    Alert.alert("Recording not saved", "The recording couldn't be saved on this BunnyPad.");
    return { kind: "presenting" };
  }
}
