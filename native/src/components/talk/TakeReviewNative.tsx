import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Line, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import { useQuery } from "convex/react";

import type { Deck } from "../../../vendor/shared/slidesScene";
import { api } from "@/lib/convex";
import {
  backRowColors,
  decodeLevels,
  HEARD_ABOVE_ROOM_DB,
  type BackRowAnalysis,
} from "@/lib/backRowVoice";
import {
  analyzeTakeFromBack,
  backRowTrace,
  formatClock,
  observeTake,
  percent,
  runAt,
  slideRuns,
  slideTimes,
  type BackRowRecording,
  type Observation,
  type SlideRun,
  type SlideTime,
} from "@/lib/rehearsalTake";
import type { StoredTake } from "@/lib/rehearsalStore";
import { alignRecordings } from "@/lib/talkAlignment";
import {
  decodeFacing,
  observeFacing,
  readFacing,
  shiftFacing,
  type FacingRead,
  type LookAway,
} from "@/lib/facingRoom";
import { fonts, useColors, type Colors } from "@/theme";
import { PresentationButton, SlideCanvas } from "@/components/slides/SlidesPresentationNative";
import { TALK_COPY } from "./talkCopy";

/**
 * A back-row video already on this BunnyPad, on the take's own clock.
 * `facing` fills in once this BunnyPad has read head direction off the video;
 * absent until then, and for good if its build can't.
 */
export type LocalBackRow = { url: string; recording: BackRowRecording; facing?: FacingRead | null };

/**
 * A take to review. `localBackRow` is set when this BunnyPad filmed the take
 * itself (audience mode with nobody linked); otherwise the back row's video,
 * if any, comes from the server.
 */
export type ReviewTake = StoredTake & { localBackRow?: LocalBackRow; transcript?: TakeTranscript | null };

/**
 * What was said in a take the server transcribed (a Decibel meter take,
 * decibelMeter.ts). Segments are [startMs, endMs, text] on the take's clock.
 */
export type TakeTranscript = {
  status: "pending" | "ready" | "error";
  segments: readonly (readonly [number, number, string])[];
  wordCount: number | null;
  fillerCount: number | null;
};

/**
 * The review of a recorded take, for slides or an app. With a BunnyPad at the
 * back of the room, it plays that video (the talk as the audience saw it)
 * with a switch between the back of the room's sound and the presenter's own
 * microphone, and says how well the back row could hear, slide by slide.
 * Without one, it plays the presenter's own recording and says only how long
 * each slide took: a close mic can't tell how loud the talk was (T1, T9).
 */
export function TakeReviewNative({
  title,
  deck,
  takes,
  selected,
  onSelect,
  againLabel,
  onAgain,
  onDone,
  resolveAsset,
  takeExtras,
}: {
  title: string;
  /** The deck, for slides; null for an app. */
  deck: Deck | null;
  /** The kept takes, oldest first. */
  takes: readonly ReviewTake[];
  selected: number;
  onSelect: (index: number) => void;
  againLabel: string;
  onAgain: () => void;
  onDone: () => void;
  resolveAsset?: (assetId: string) => string | null;
  /** The caller's own controls for one take, at the top of the side column. */
  takeExtras?: (take: ReviewTake) => React.ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const take = takes[selected];
  const previous = selected > 0 ? takes[selected - 1] : undefined;

  if (!take) return null;
  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.bg,
          paddingTop: Math.max(insets.top, 20),
          paddingRight: Math.max(insets.right, 20),
          paddingBottom: Math.max(insets.bottom, 20),
          paddingLeft: Math.max(insets.left, 20),
        },
      ]}
    >
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[styles.title, { color: colors.fg, fontFamily: fonts.medium }]}
        >
          {title}
          <Text style={{ color: colors.fgMuted }}> · recorded {describeWhen(take.recordedAt)}</Text>
        </Text>
        {takes.length > 1 ? (
          <View accessibilityRole="tablist" style={[styles.takes, { backgroundColor: colors.bgSubtle }]}>
            {takes.map((t, i) => (
              <Pressable
                key={t.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: i === selected }}
                onPress={() => onSelect(i)}
                style={[styles.takeTab, i === selected && { backgroundColor: colors.bg }]}
              >
                <Text
                  style={{
                    fontSize: 16,
                    fontFamily: fonts.medium,
                    color: i === selected ? colors.fg : colors.fgMuted,
                  }}
                >
                  Take {i + 1}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <PresentationButton label={againLabel} onPress={onAgain} colors={colors} />
        <PresentationButton label="Done" onPress={onDone} colors={colors} />
      </View>
      <TakeReview
        key={take.id}
        deck={deck}
        take={take}
        previous={previous}
        resolveAsset={resolveAsset}
        extras={takeExtras?.(take) ?? null}
      />
    </View>
  );
}

/** Two BunnyPads' clocks rarely disagree by more than this when both are right. */
const CLOCK_PRIOR_LIMIT_MS = 5_000;
/** The back camera usually starts this long after the presenter's mic (the link, then the camera). */
const TYPICAL_BACK_ROW_LAG_MS = 1_000;

type BackRowState =
  | { kind: "none" }
  | { kind: "coming" }
  | { kind: "failed" }
  | {
      kind: "ready";
      url: string;
      recording: BackRowRecording;
      matched: boolean;
      /** When the presenter turned away or looked down, on the take's clock; null if the back device sent none. */
      facing: FacingRead | null;
    };

function TakeReview({
  deck,
  take,
  previous,
  resolveAsset,
  extras,
}: {
  deck: Deck | null;
  take: ReviewTake;
  previous?: StoredTake;
  resolveAsset?: (assetId: string) => string | null;
  extras: React.ReactNode;
}) {
  const local = take.localBackRow;
  const backRow = useQuery(api.liveTalks.backRowForTake, local ? "skip" : { takeId: take.id });

  const back = useMemo((): BackRowState => {
    if (local) {
      return {
        kind: "ready",
        url: local.url,
        recording: local.recording,
        matched: true,
        facing: local.facing ?? null,
      };
    }
    if (!backRow) return { kind: "none" };
    if (backRow.status === "failed") return { kind: "failed" };
    if (
      backRow.status !== "ready" ||
      !backRow.url ||
      backRow.levels == null ||
      backRow.frameMs == null ||
      backRow.roomDbfs == null
    ) {
      return { kind: "coming" };
    }
    const dbfs = decodeLevels(backRow.levels);
    // The two BunnyPads' clocks give the first guess. If they disagree by
    // more than any real start-up gap, a clock is off: search wider instead.
    const clockPrior = (backRow.cameraStartedAtClient ?? take.recordedAt) - take.recordedAt;
    const clocksAgree = Math.abs(clockPrior) <= CLOCK_PRIOR_LIMIT_MS;
    const alignment = alignRecordings({
      presenterLevels: take.levels,
      backDbfs: dbfs,
      frameMs: backRow.frameMs,
      priorOffsetMs: clocksAgree ? clockPrior : TYPICAL_BACK_ROW_LAG_MS,
      searchMs: clocksAgree ? 4000 : 10_000,
    });
    const facing =
      backRow.facing != null && backRow.facingFrameMs != null
        ? shiftFacing(readFacing(decodeFacing(backRow.facing), backRow.facingFrameMs, backRow.facingZone ?? undefined), alignment.offsetMs)
        : null;
    return {
      kind: "ready",
      url: backRow.url,
      matched: alignment.matched,
      facing,
      recording: {
        dbfs,
        frameMs: backRow.frameMs,
        roomDbfs: backRow.roomDbfs,
        // A back device that predates sending its threshold judged by the default.
        thresholdDb: backRow.thresholdDb ?? HEARD_ABOVE_ROOM_DB,
        offsetMs: alignment.offsetMs,
      },
    };
  }, [backRow, local, take.levels, take.recordedAt]);

  const runs = useMemo(() => slideRuns(take), [take]);
  const times = useMemo(() => slideTimes(runs), [runs]);
  const analysis = useMemo(
    () =>
      back.kind === "ready"
        ? analyzeTakeFromBack(
            runs,
            back.recording,
            // No presenter's close mic (a take filmed on its own): nobody says when they talk.
            take.levels.length > 0 ? take.levels : undefined,
            take.frameMs,
          )
        : null,
    [back, runs, take.frameMs, take.levels],
  );
  const observations = useMemo(() => {
    const said = observeTake({ take, times, back: analysis, previous });
    const facing = back.kind === "ready" ? observeFacing(back.facing, runs) : null;
    return facing ? [...said, facing] : said;
  }, [analysis, back, previous, runs, take, times]);

  const transcript = take.transcript ?? null;
  const shared = { deck, take, runs, times, analysis, observations, back, resolveAsset, transcript, extras };
  return back.kind === "ready" ? (
    <VideoReview {...shared} url={back.url} offsetMs={back.recording.offsetMs} />
  ) : (
    <AudioReview {...shared} />
  );
}

type Playback = {
  /** On the take's clock. */
  positionMs: number;
  playing: boolean;
  canPlay: boolean;
  seek: (ms: number, play: boolean) => void;
  toggle: () => void;
};

type ReviewParts = {
  deck: Deck | null;
  take: StoredTake;
  runs: readonly SlideRun[];
  times: readonly SlideTime[];
  analysis: BackRowAnalysis | null;
  observations: Observation[];
  back: BackRowState;
  resolveAsset?: (assetId: string) => string | null;
  transcript: TakeTranscript | null;
  extras: React.ReactNode;
};

/** The presenter's own recording plays (no back-row video, or it hasn't arrived). */
function AudioReview(parts: ReviewParts) {
  const { take } = parts;
  const player = useAudioPlayer(take.audioUri, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const [scrubMs, setScrubMs] = useState(0);
  const hasAudio = take.audioUri !== null;
  const positionMs = Math.min(take.durationMs, hasAudio ? status.currentTime * 1000 : scrubMs);

  const seek = useCallback(
    (ms: number, play: boolean) => {
      const clamped = Math.max(0, Math.min(take.durationMs, ms));
      setScrubMs(clamped);
      if (!hasAudio) return;
      void player.seekTo(clamped / 1000).then(() => {
        if (play) player.play();
      });
    },
    [hasAudio, player, take.durationMs],
  );
  const toggle = useCallback(() => {
    if (status.playing) player.pause();
    else if (status.didJustFinish || positionMs >= take.durationMs - 100) seek(0, true);
    else player.play();
  }, [player, positionMs, seek, status.didJustFinish, status.playing, take.durationMs]);

  return (
    <ReviewLayout
      parts={parts}
      playback={{ positionMs, playing: status.playing, canPlay: hasAudio, seek, toggle }}
      media={null}
      soundSwitch={null}
    />
  );
}

type Sound = "back" | "mine";

/**
 * The back-row video plays, and the take's clock follows it through the
 * alignment offset. "Your BunnyPad" mutes the video and plays the presenter's
 * own recording in step with it.
 */
function VideoReview({ url, offsetMs, ...parts }: ReviewParts & { url: string; offsetMs: number }) {
  const { take } = parts;
  const video = useVideoPlayer(url, (p) => {
    p.timeUpdateEventInterval = 0.1;
  });
  const { currentTime } = useEvent(video, "timeUpdate", {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const { isPlaying } = useEvent(video, "playingChange", { isPlaying: false });
  const mine = useAudioPlayer(take.audioUri, { updateInterval: 100 });
  const mineStatus = useAudioPlayerStatus(mine);
  const [sound, setSound] = useState<Sound>("back");

  const positionMs = Math.max(0, Math.min(take.durationMs, currentTime * 1000 + offsetMs));

  // Keep the presenter's recording in step with the video while it is heard.
  useEffect(() => {
    setPlayerMuted(video, sound === "mine");
    if (sound !== "mine" || !isPlaying || take.audioUri === null) {
      if (mineStatus.playing) mine.pause();
      return;
    }
    const wantS = (currentTime * 1000 + offsetMs) / 1000;
    if (wantS < 0 || wantS * 1000 > take.durationMs) {
      if (mineStatus.playing) mine.pause();
      return;
    }
    if (Math.abs(mineStatus.currentTime - wantS) > 0.15) void mine.seekTo(wantS);
    if (!mineStatus.playing) mine.play();
  }, [currentTime, isPlaying, mine, mineStatus.currentTime, mineStatus.playing, offsetMs, sound, take.audioUri, take.durationMs, video]);

  const seek = useCallback(
    (ms: number, play: boolean) => {
      setPlayerTime(video, Math.max(0, (ms - offsetMs) / 1000));
      if (play) video.play();
    },
    [offsetMs, video],
  );
  const toggle = useCallback(() => {
    if (isPlaying) {
      video.pause();
      return;
    }
    if (video.duration > 0 && video.currentTime >= video.duration - 0.1) setPlayerTime(video, 0);
    video.play();
  }, [isPlaying, video]);

  const colors = useColors();
  return (
    <ReviewLayout
      parts={parts}
      playback={{ positionMs, playing: isPlaying, canPlay: true, seek, toggle }}
      media={
        <View style={styles.videoBox}>
          <VideoView player={video} nativeControls={false} contentFit="contain" style={styles.video} />
        </View>
      }
      soundSwitch={
        // Nothing to switch to without the presenter's own recording.
        take.audioUri === null ? null : (
        <View style={styles.soundRow}>
          <Text style={[styles.soundLabel, { color: colors.fgMuted, fontFamily: fonts.medium }]}>
            {TALK_COPY.soundFrom}
          </Text>
          <View accessibilityRole="radiogroup" style={[styles.takes, { backgroundColor: colors.bgSubtle }]}>
            {(["back", "mine"] as const).map((option) => (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected: sound === option }}
                disabled={option === "mine" && take.audioUri === null}
                onPress={() => setSound(option)}
                style={[styles.takeTab, sound === option && { backgroundColor: colors.bg }]}
              >
                <Text
                  style={{
                    fontSize: 16,
                    fontFamily: fonts.medium,
                    color: sound === option ? colors.fg : colors.fgMuted,
                  }}
                >
                  {option === "back" ? TALK_COPY.soundBack : TALK_COPY.soundMine}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        )
      }
    />
  );
}

function ReviewLayout({
  parts,
  playback,
  media,
  soundSwitch,
}: {
  parts: ReviewParts;
  playback: Playback;
  media: React.ReactNode;
  soundSwitch: React.ReactNode;
}) {
  const { deck, take, runs, times, analysis, observations, back, resolveAsset, transcript, extras } = parts;
  const colors = useColors();
  const { positionMs } = playback;
  const run = runAt(runs, positionMs);
  const slide =
    deck && run ? (deck.slides.find((s) => s.id === run.slideId) ?? deck.slides[run.index]) : undefined;
  const watching = back.kind === "ready";

  const slideArea = deck ? (
    <View style={media ? styles.slideBeside : styles.slideArea}>
      <Text style={[styles.sectionLabel, { color: colors.fgMuted, fontFamily: fonts.medium }]}>
        {run ? `Slide ${run.index + 1} of ${deck.slides.length}` : "Slide"}
      </Text>
      <View accessible={false} style={styles.slideBox}>
        {slide ? <SlideCanvas slide={slide} resolveAsset={resolveAsset} /> : null}
      </View>
    </View>
  ) : null;

  return (
    <View style={styles.body}>
      <View style={styles.left}>
        {media ? (
          <View style={styles.mediaRow}>
            {media}
            {slideArea}
          </View>
        ) : (
          (slideArea ?? (
            <View style={[styles.slideArea, styles.noMedia, { borderColor: colors.border }]}>
              <Text style={[styles.noMediaText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
                {TALK_COPY.yourRecording}
              </Text>
            </View>
          ))
        )}
        <View style={styles.playRow}>
          <PresentationButton
            disabled={!playback.canPlay}
            label={playback.playing ? "Pause" : "Play"}
            onPress={playback.toggle}
            colors={colors}
          />
          <Text style={[styles.clock, { color: colors.fg, fontFamily: fonts.medium }]}>
            {formatClock(positionMs)}
            <Text style={{ color: colors.fgMuted }}> / {formatClock(take.durationMs)}</Text>
          </Text>
          <View style={styles.spacer} />
          {soundSwitch}
        </View>
        <Timeline
          durationMs={take.durationMs}
          runs={runs}
          back={back.kind === "ready" ? back.recording : null}
          away={back.kind === "ready" && back.facing?.kind === "seen" ? back.facing.away : null}
          positionMs={positionMs}
          onSeek={(ms) => playback.seek(ms, playback.playing)}
          colors={colors}
        />
      </View>
      <ScrollView style={styles.right} contentContainerStyle={styles.rightContent}>
        {extras}
        {observations.length > 0 || back.kind !== "none" ? (
          <Text accessibilityRole="header" style={[styles.boxTitle, { color: colors.fg, fontFamily: fonts.semibold }]}>
            What stood out
          </Text>
        ) : null}
        {back.kind === "coming" || back.kind === "failed" ? (
          <Text style={[styles.observationText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
            {back.kind === "coming" ? TALK_COPY.backOnItsWay : TALK_COPY.backDidntArrive}
          </Text>
        ) : null}
        {observations.map((observation) => (
          <ObservationRow
            key={observation.text}
            observation={observation}
            watching={watching}
            onListen={(atMs) => playback.seek(atMs, true)}
            colors={colors}
          />
        ))}
        {transcript ? (
          <TranscriptBox
            transcript={transcript}
            durationMs={take.durationMs}
            positionMs={positionMs}
            onSeek={(ms) => playback.seek(ms, true)}
            colors={colors}
          />
        ) : null}
        {times.length > 0 ? (
          <>
            <Text
              accessibilityRole="header"
              style={[styles.boxTitle, styles.tableTitle, { color: colors.fg, fontFamily: fonts.semibold }]}
            >
              Slide by slide
            </Text>
            <SlideTable
              times={times}
              analysis={analysis}
              currentIndex={run?.index}
              onPick={(ms) => playback.seek(ms, true)}
              colors={colors}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** What was said, line by line; a line plays the take from there. */
function TranscriptBox({
  transcript,
  durationMs,
  positionMs,
  onSeek,
  colors,
}: {
  transcript: TakeTranscript;
  durationMs: number;
  positionMs: number;
  onSeek: (ms: number) => void;
  colors: Colors;
}) {
  const minutes = durationMs / 60_000;
  const pace =
    transcript.wordCount !== null && minutes >= 0.25
      ? Math.round(transcript.wordCount / minutes)
      : null;
  return (
    <View style={styles.transcript}>
      <Text accessibilityRole="header" style={[styles.boxTitle, styles.tableTitle, { color: colors.fg, fontFamily: fonts.semibold }]}>
        {TALK_COPY.transcriptHeading}
      </Text>
      {transcript.status === "pending" ? (
        <Text style={[styles.observationText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          {TALK_COPY.transcriptPending}
        </Text>
      ) : transcript.status === "error" ? (
        <Text style={[styles.observationText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          {TALK_COPY.transcriptFailed}
        </Text>
      ) : transcript.segments.length === 0 ? (
        <Text style={[styles.observationText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          {TALK_COPY.transcriptEmpty}
        </Text>
      ) : (
        <>
          {pace !== null ? (
            <Text style={[styles.observationText, { color: colors.fg, fontFamily: fonts.medium }]}>
              {TALK_COPY.pace(pace, transcript.fillerCount ?? 0)}
            </Text>
          ) : null}
          {transcript.segments.map(([startMs, endMs, text]) => {
            const now = positionMs >= startMs && positionMs < endMs;
            return (
              <Pressable
                key={startMs}
                accessibilityRole="button"
                accessibilityLabel={`${formatClock(startMs)} ${text}`}
                onPress={() => onSeek(startMs)}
                style={[styles.transcriptLine, now && { backgroundColor: colors.bgSubtle }]}
              >
                <Text style={[styles.transcriptTime, { color: colors.fgMuted, fontFamily: fonts.medium }]}>
                  {formatClock(startMs)}
                </Text>
                <Text style={[styles.transcriptText, { color: colors.fg, fontFamily: fonts.regular }]}>
                  {text}
                </Text>
              </Pressable>
            );
          })}
        </>
      )}
    </View>
  );
}

function ObservationRow({
  observation,
  watching,
  onListen,
  colors,
}: {
  observation: Observation;
  watching: boolean;
  onListen: (atMs: number) => void;
  colors: Colors;
}) {
  const { listen } = observation;
  return (
    <View style={styles.observation}>
      <Text style={[styles.observationText, { color: colors.fg, fontFamily: fonts.regular }]}>
        {observation.text}
      </Text>
      {listen ? (
        <Pressable accessibilityRole="button" onPress={() => onListen(listen.atMs)} hitSlop={8}>
          <Text style={[styles.listen, { color: colors.navy, fontFamily: fonts.semibold }]}>
            {listen.slideIndex === null
              ? watching
                ? TALK_COPY.watchAt(formatClock(listen.atMs))
                : TALK_COPY.listenAt(formatClock(listen.atMs))
              : watching
                ? TALK_COPY.watchSlide(listen.slideIndex + 1)
                : TALK_COPY.listenSlide(listen.slideIndex + 1)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SlideTable({
  times,
  analysis,
  currentIndex,
  onPick,
  colors,
}: {
  times: readonly SlideTime[];
  analysis: BackRowAnalysis | null;
  currentIndex?: number;
  onPick: (atMs: number) => void;
  colors: Colors;
}) {
  const head = [styles.cell, styles.headCell, { color: colors.fgMuted, fontFamily: fonts.medium }];
  const heardBy = new Map(analysis?.rows.map((row) => [row.index, analysis.share(row)]) ?? []);
  return (
    <View>
      <View style={[styles.tableRow, { borderBottomColor: colors.border }]}>
        <Text style={[...head, styles.slideCell]}>Slide</Text>
        <Text style={[...head, styles.numberCell]}>Time</Text>
        {analysis ? <Text style={[...head, styles.numberCell]}>Heard at the back</Text> : null}
      </View>
      {times.map((row) => {
        const cell = [styles.cell, { color: colors.fg, fontFamily: fonts.regular }];
        const heard = heardBy.get(row.index) ?? null;
        const heardText = heard === null ? "—" : percent(heard);
        return (
          <Pressable
            key={row.index}
            accessibilityRole="button"
            accessibilityLabel={`Slide ${row.index + 1}, ${formatClock(row.timeMs)}${analysis ? `, heard at the back ${heard === null ? "not enough talking" : heardText}` : ""}`}
            accessibilityHint="Plays the recording from this slide"
            onPress={() => onPick(row.firstShownMs)}
            style={[
              styles.tableRow,
              { borderBottomColor: colors.border },
              row.index === currentIndex && { backgroundColor: colors.bgSubtle },
            ]}
          >
            <Text style={[...cell, styles.slideCell]}>{row.index + 1}</Text>
            <Text style={[...cell, styles.numberCell]}>{formatClock(row.timeMs)}</Text>
            {analysis ? <Text style={[...cell, styles.numberCell]}>{heardText}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// Timeline geometry, in points: a slide strip (slides only), the back-row plot
// (with a back-row recording only), the looks away (when the back device read
// head direction), a time axis. GUTTER fits the longest row label, "Head
// direction", with room before the plot starts.
const GUTTER = 112;
const STRIP_H = 26;
const PLOT_H = 100;
const AWAY_H = 14;
const GAP = 10;
const AXIS_H = 20;

function Timeline({
  durationMs,
  runs,
  back,
  away,
  positionMs,
  onSeek,
  colors,
}: {
  durationMs: number;
  runs: readonly SlideRun[];
  back: BackRowRecording | null;
  away: readonly LookAway[] | null;
  positionMs: number;
  onSeek: (ms: number) => void;
  colors: Colors;
}) {
  const words = backRowColors(useColorScheme() === "dark");
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const plotWidth = Math.max(0, width - GUTTER - 4);
  const duration = Math.max(1, durationMs);
  const x = (ms: number) => GUTTER + (Math.max(0, Math.min(duration, ms)) / duration) * plotWidth;

  const hasStrip = runs.length > 0;
  const stripY = 0;
  const plotY = hasStrip ? STRIP_H + GAP : 0;
  const plotBottom = back ? plotY + PLOT_H : hasStrip ? STRIP_H : 8;
  const awayY = plotBottom + GAP;
  const marksBottom = away ? awayY + AWAY_H : plotBottom;
  const axisY = marksBottom + AXIS_H - 4;
  const height = marksBottom + AXIS_H;

  // The back-row line on the take's clock, broken wherever nobody talked.
  const plot = useMemo(() => {
    if (!back || plotWidth <= 0) return null;
    const columns = Math.max(1, Math.floor(plotWidth / 3));
    const backDuration = back.dbfs.length * back.frameMs;
    const { trace, heardAt } = backRowTrace(back, columns);
    const lines: string[] = [];
    let points: string[] = [];
    for (let c = 0; c <= trace.length; c++) {
      const value = trace[c] ?? null;
      const takeMs = ((c + 0.5) / columns) * backDuration + back.offsetMs;
      if (value === null || takeMs < 0 || takeMs > duration) {
        if (points.length > 1) lines.push(points.join(" "));
        points = [];
        continue;
      }
      const px = GUTTER + (takeMs / duration) * plotWidth;
      const py = plotY + PLOT_H * (1 - value);
      points.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    return { lines, heardY: plotY + PLOT_H * (1 - heardAt) };
  }, [back, duration, plotWidth, plotY]);

  const step = duration > 150_000 ? 60_000 : duration > 40_000 ? 15_000 : 5_000;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  return (
    <Pressable
      accessibilityLabel="Timeline. Tap to jump to a moment."
      accessibilityRole="button"
      onLayout={onLayout}
      onPress={(event) => {
        if (plotWidth <= 0) return;
        const share = (event.nativeEvent.locationX - GUTTER) / plotWidth;
        onSeek(Math.max(0, Math.min(1, share)) * duration);
      }}
      style={{ height }}
    >
      {width > 0 ? (
        <Svg width={width} height={height}>
          {hasStrip ? (
            <SvgText x={0} y={stripY + 18} fontSize={13} fill={colors.fgMuted}>
              Slide
            </SvgText>
          ) : null}
          {runs.map((run, i) => (
            <Rect
              key={`${run.index}-${i}`}
              x={x(run.fromMs) + 0.5}
              y={stripY}
              width={Math.max(1, x(run.toMs) - x(run.fromMs) - 1)}
              height={STRIP_H}
              rx={4}
              fill={run.index % 2 === 0 ? colors.gray100 : colors.gray200}
            />
          ))}
          {runs.map((run, i) => {
            const from = x(run.fromMs);
            const to = x(run.toMs);
            return to - from > 16 ? (
              <SvgText
                key={`label-${run.index}-${i}`}
                x={(from + to) / 2}
                y={stripY + 18}
                fontSize={13}
                fontWeight="600"
                textAnchor="middle"
                fill={colors.fg}
              >
                {run.index + 1}
              </SvgText>
            ) : null;
          })}
          {plot ? (
            <>
              <Rect
                x={GUTTER}
                y={plotY}
                width={plotWidth}
                height={Math.max(0, plot.heardY - plotY)}
                fill={`${words.heard.fill}33`}
              />
              <SvgText x={0} y={(plotY + plot.heardY) / 2 + 4} fontSize={12} fontWeight="600" fill={colors.fg}>
                {TALK_COPY.timelineHeard}
              </SvgText>
              {plot.lines.map((line, i) => (
                <Polyline
                  key={i}
                  points={line}
                  fill="none"
                  stroke={colors.fg}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                />
              ))}
            </>
          ) : null}
          {away ? (
            <>
              <SvgText x={0} y={awayY + 11} fontSize={12} fill={colors.fgMuted}>
                {TALK_COPY.headDirection}
              </SvgText>
              <Line
                x1={GUTTER}
                x2={GUTTER + plotWidth}
                y1={awayY + AWAY_H / 2}
                y2={awayY + AWAY_H / 2}
                stroke={colors.border}
                strokeWidth={1}
              />
              {away.map((a) => (
                <Rect
                  key={a.fromMs}
                  x={x(a.fromMs)}
                  y={awayY}
                  width={Math.max(3, x(a.toMs) - x(a.fromMs))}
                  height={AWAY_H}
                  rx={3}
                  fill={colors.fgMuted}
                />
              ))}
            </>
          ) : null}
          {ticks.map((t) => (
            <SvgText key={t} x={x(t)} y={axisY} fontSize={12} textAnchor="middle" fill={colors.fgMuted}>
              {formatClock(t)}
            </SvgText>
          ))}
          <Line
            x1={x(positionMs)}
            x2={x(positionMs)}
            y1={0}
            y2={marksBottom}
            stroke={colors.violet}
            strokeWidth={2}
          />
        </Svg>
      ) : null}
    </Pressable>
  );
}

// The video player is an object the native side owns; seeking and muting
// are property writes on it, kept out here away from the component.
function setPlayerTime(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
}
function setPlayerMuted(player: VideoPlayer, muted: boolean) {
  player.muted = muted;
}

function describeWhen(recordedAt: number): string {
  return new Date(recordedAt).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: 14 },
  header: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 16 },
  title: { flex: 1, fontSize: 18 },
  takes: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 2 },
  takeTab: { minHeight: 38, justifyContent: "center", paddingHorizontal: 14, borderRadius: 8 },
  body: { flex: 1, minHeight: 0, flexDirection: "row", gap: 24 },
  left: { flex: 3, minWidth: 0, gap: 12 },
  mediaRow: { flex: 1, minHeight: 0, flexDirection: "row", gap: 14 },
  videoBox: { flex: 3, minWidth: 0, backgroundColor: "#000" },
  video: { flex: 1 },
  slideBeside: { flex: 2, minWidth: 0, gap: 6 },
  slideArea: { flex: 1, minHeight: 0, gap: 6 },
  noMedia: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 8 },
  noMediaText: { fontSize: 18 },
  sectionLabel: { fontSize: 15 },
  slideBox: { flex: 1, minHeight: 0, backgroundColor: "#000" },
  playRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  spacer: { flex: 1 },
  soundRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  soundLabel: { fontSize: 15 },
  clock: { fontSize: 18, fontVariant: ["tabular-nums"] },
  right: { flex: 2, minWidth: 0 },
  rightContent: { gap: 12, paddingBottom: 12 },
  boxTitle: { fontSize: 18 },
  tableTitle: { marginTop: 12 },
  transcript: { gap: 4 },
  transcriptLine: { flexDirection: "row", gap: 10, paddingVertical: 6, paddingHorizontal: 6, borderRadius: 6 },
  transcriptTime: { width: 44, fontSize: 15, lineHeight: 23, fontVariant: ["tabular-nums"] },
  transcriptText: { flex: 1, fontSize: 17, lineHeight: 23 },
  observation: { gap: 4 },
  observationText: { fontSize: 17, lineHeight: 24 },
  listen: { fontSize: 16 },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 40,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
  },
  cell: { fontSize: 16, fontVariant: ["tabular-nums"] },
  headCell: { fontSize: 14 },
  slideCell: { width: 52 },
  numberCell: { flex: 1, textAlign: "right" },
});
