import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { api, type Id } from "@/lib/convex";

export type LiveTalkKind = "slides" | "app";
export type LiveTalkMode = "present" | "rehearse";

/** How often a presenting BunnyPad tells the school it is still presenting. */
const HEARTBEAT_MS = 20_000;

/**
 * The presenter's side of the live link to a BunnyPad at the back of the room
 * (audience mode). While mounted, the school can see this scholar presenting:
 * audience mode lists them, and a classmate or teacher who picks them links
 * their BunnyPad to this talk. Starting and stopping a take here starts and
 * stops the camera at the back.
 *
 * Presenting never depends on the link: if it can't start (no network, an
 * account without a school), `talkId` stays null and the take records on this
 * BunnyPad alone.
 */
export function useLiveTalk({
  kind,
  mode,
  title,
  slideCount,
  slideIndex,
}: {
  kind: LiveTalkKind;
  mode: LiveTalkMode;
  title: string;
  slideCount: number;
  slideIndex: number;
}) {
  const begin = useMutation(api.liveTalks.begin);
  const heartbeat = useMutation(api.liveTalks.heartbeat);
  const showSlide = useMutation(api.liveTalks.showSlide);
  const end = useMutation(api.liveTalks.end);
  const startRecordingMutation = useMutation(api.liveTalks.startRecording);
  const stopRecordingMutation = useMutation(api.liveTalks.stopRecording);
  const dropListenerMutation = useMutation(api.liveTalks.dropListener);
  const setTalkingMutation = useMutation(api.liveTalks.setTalking);

  const [talkId, setTalkId] = useState<Id<"liveTalks"> | null>(null);
  // Bumped to begin again after the server ended the talk (the app sat in the
  // background past the heartbeat window).
  const [generation, setGeneration] = useState(0);

  // What the talk was opened with; later changes go through showSlide.
  const openingRef = useRef({ kind, mode, title, slideCount, slideIndex });
  useEffect(() => {
    openingRef.current = { kind, mode, title, slideCount, slideIndex };
  });

  useEffect(() => {
    let cancelled = false;
    let opened: Id<"liveTalks"> | null = null;
    const opening = openingRef.current;
    begin({
      kind: opening.kind,
      mode: opening.mode,
      title: opening.title.slice(0, 200),
      slideCount: opening.slideCount,
      slideIndex: opening.slideIndex,
    })
      .then((id) => {
        if (cancelled) {
          void end({ talkId: id }).catch(() => {});
          return;
        }
        opened = id;
        setTalkId(id);
      })
      .catch((error: unknown) => {
        console.warn("[live-talk] couldn't announce the talk", error);
      });
    return () => {
      cancelled = true;
      setTalkId(null);
      if (opened) void end({ talkId: opened }).catch(() => {});
    };
  }, [begin, end, generation]);

  useEffect(() => {
    if (!talkId) return;
    const timer = setInterval(() => {
      void heartbeat({ talkId }).catch((error: unknown) => {
        console.warn("[live-talk] heartbeat failed", error);
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [heartbeat, talkId]);

  useEffect(() => {
    if (!talkId || kind !== "slides") return;
    void showSlide({ talkId, slideIndex }).catch(() => {});
  }, [kind, showSlide, slideIndex, talkId]);

  const status = useQuery(api.liveTalks.forPresenter, talkId ? { talkId } : "skip");
  // The server ends a talk that stopped heart-beating (the app sat in the
  // background); open a fresh one. Not one this account replaced by
  // presenting on another BunnyPad: reopening would end that one, and the
  // two would take turns forever. Scheduled, so it isn't a render cascade.
  const ended = status?.state === "ended" && status.endedReason === "stale";
  useEffect(() => {
    if (!ended) return;
    const reopen = setTimeout(() => setGeneration((n) => n + 1), 0);
    return () => clearTimeout(reopen);
  }, [ended]);

  const startRecording = useCallback(
    async (takeId: string) => {
      if (!talkId) return;
      await startRecordingMutation({ talkId, takeId }).catch((error: unknown) => {
        console.warn("[live-talk] couldn't start the back-row camera", error);
      });
    },
    [startRecordingMutation, talkId],
  );

  const stopRecording = useCallback(async () => {
    if (!talkId) return;
    await stopRecordingMutation({ talkId }).catch((error: unknown) => {
      console.warn("[live-talk] couldn't stop the back-row camera", error);
    });
  }, [stopRecordingMutation, talkId]);

  /** The presenter started or stopped talking (their close mic), for the back screen. */
  const setTalking = useCallback(
    (talking: boolean) => {
      if (!talkId) return;
      void setTalkingMutation({ talkId, talking }).catch(() => {});
    },
    [setTalkingMutation, talkId],
  );

  const dropListener = useCallback(() => {
    if (!talkId) return;
    void dropListenerMutation({ talkId }).catch(() => {});
  }, [dropListenerMutation, talkId]);

  return {
    talkId,
    listener: status?.listener ?? null,
    startRecording,
    stopRecording,
    setTalking,
    dropListener,
  };
}

export type LiveTalk = ReturnType<typeof useLiveTalk>;
