import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { usePresentingMic, type MicFrame } from "@/hooks/usePresentingMic";
import type { LiveTalk } from "@/hooks/useLiveTalk";
import { closeMicTalking, NOT_TALKING, type CloseMicTalking } from "@/lib/backRowVoice";
import { METER_FRAME_MS } from "@/lib/micLevel";
import { recordFrame, recordSlide, type SlideShowing } from "@/lib/rehearsalTake";

export type TakeStatus = "idle" | "starting" | "recording" | "stopping";

/** What one take recorded on the presenter's BunnyPad, handed over when it stops. */
export type TakeRecording = {
  id: string;
  /** When the microphone started, epoch ms on this BunnyPad's clock. */
  recordedAt: number;
  durationMs: number;
  /** The close-mic level (0..1) every METER_FRAME_MS, used to line up the back-row video. */
  levels: number[];
  slides: SlideShowing[];
  /** The audio file, or null if the microphone never ran. */
  audioUri: string | null;
};

const MIC_UNAVAILABLE = {
  denied: "Recording needs the microphone, which is turned off for Rabbithole.",
  failed: "Recording couldn't start the microphone.",
} as const;

/**
 * One recorded take while a scholar presents slides or an app: the
 * presenter's own microphone, when each slide showed, and the live link that
 * starts and stops the camera at the back of the room (`useLiveTalk`).
 *
 * `start()` opens the microphone; once it is really recording, the take's
 * clock starts and the back-row camera is told to start. `stop()` ends both
 * and resolves the take. Going to the background ends a take too, through
 * `onAutoStop`, because iOS stops the microphone there.
 */
export function useTalkTake({
  live,
  slide,
  onAutoStop,
}: {
  live: LiveTalk;
  /** The slide showing now, for slides; null for an app. */
  slide: { index: number; slideId: string } | null;
  onAutoStop: (take: TakeRecording) => void;
}) {
  const [status, setStatus] = useState<TakeStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [micWanted, setMicWanted] = useState(false);

  const takeRef = useRef<{
    id: string;
    recordedAt: number;
    levels: number[];
    slides: SlideShowing[];
    atMs: number;
  } | null>(null);
  // Whether the presenter is talking, from this close mic, told to the back
  // screen only when it changes.
  const talkingRef = useRef<CloseMicTalking>(NOT_TALKING);
  const { setTalking } = live;
  const setTalkingRef = useRef(setTalking);
  useEffect(() => {
    setTalkingRef.current = setTalking;
  });
  const slideRef = useRef(slide);
  useEffect(() => {
    slideRef.current = slide;
  });

  const onFrame = useCallback((frame: MicFrame) => {
    const take = takeRef.current;
    if (!take) return;
    recordFrame(take.levels, frame.atMs, frame.level);
    take.atMs = frame.atMs;
    const was = talkingRef.current.talking;
    talkingRef.current = closeMicTalking(talkingRef.current, frame.dbfs);
    if (talkingRef.current.talking !== was) setTalkingRef.current(talkingRef.current.talking);
  }, []);

  const onUnavailable = useCallback((reason: "denied" | "failed") => {
    takeRef.current = null;
    setMicWanted(false);
    setStatus("idle");
    setNotice(MIC_UNAVAILABLE[reason]);
  }, []);

  const mic = usePresentingMic({
    enabled: micWanted,
    keepRecording: true,
    onFrame,
    onUnavailable,
  });
  const stopMic = mic.stop;

  // The take's clock starts when the microphone really records: that moment
  // is time 0 of the audio file, and the back-row camera starts from it.
  const { startRecording, stopRecording } = live;
  useEffect(() => {
    if (status !== "starting" || mic.status !== "on") return;
    const take = takeRef.current;
    if (!take) return;
    take.recordedAt = Date.now();
    const showing = slideRef.current;
    if (showing) recordSlide(take.slides, 0, showing.index, showing.slideId);
    setStatus("recording");
    void startRecording(take.id);
  }, [mic.status, startRecording, status]);

  // Slide changes while recording.
  const slideIndex = slide?.index ?? null;
  const slideId = slide?.slideId ?? null;
  useEffect(() => {
    const take = takeRef.current;
    if (status !== "recording" || !take || slideIndex === null || slideId === null) return;
    recordSlide(take.slides, take.atMs, slideIndex, slideId);
  }, [slideId, slideIndex, status]);

  const start = useCallback(() => {
    if (status !== "idle") return;
    setNotice(null);
    talkingRef.current = NOT_TALKING;
    takeRef.current = {
      id: `take-${Date.now()}`,
      recordedAt: Date.now(),
      levels: [],
      slides: [],
      atMs: 0,
    };
    setStatus("starting");
    setMicWanted(true);
  }, [status]);

  const stoppingRef = useRef(false);
  const stop = useCallback(async (): Promise<TakeRecording | null> => {
    const take = takeRef.current;
    if (!take || stoppingRef.current) return null;
    stoppingRef.current = true;
    setStatus("stopping");
    const [audioUri] = await Promise.all([stopMic(), stopRecording()]);
    setMicWanted(false);
    takeRef.current = null;
    stoppingRef.current = false;
    setStatus("idle");
    return {
      id: take.id,
      recordedAt: take.recordedAt,
      durationMs: Math.max(take.atMs, take.levels.length * METER_FRAME_MS),
      levels: take.levels.slice(),
      slides: take.slides.slice(),
      audioUri,
    };
  }, [stopMic, stopRecording]);

  // Leaving the app ends the take: iOS stops the microphone in the
  // background, and the take so far is kept.
  const onAutoStopRef = useRef(onAutoStop);
  useEffect(() => {
    onAutoStopRef.current = onAutoStop;
  });
  useEffect(() => {
    if (status !== "recording") return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "background") return;
      void stop().then((take) => {
        if (take) onAutoStopRef.current(take);
      });
    });
    return () => subscription.remove();
  }, [status, stop]);

  return { status, notice, start, stop, subscribe: mic.subscribe };
}

export type TalkTake = ReturnType<typeof useTalkTake>;
