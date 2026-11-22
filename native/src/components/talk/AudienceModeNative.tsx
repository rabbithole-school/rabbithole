import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import { createVideoPlayer } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Polygon } from "react-native-svg";

import {
  FacingRoomCamera,
  readHeadPose,
  type FacingRoomCameraHandle,
  type HeadPoseFrame,
  type HeadPoseTrack,
  type LiveHeadPose,
} from "../../../modules/facing-room";
import { api, type Id } from "@/lib/convex";
import { useKeepAwakeUnlessBedtime } from "@/hooks/useKeepAwakeUnlessBedtime";
import { usePresentingMic, type MicFrame } from "@/hooks/usePresentingMic";
import {
  BACK_ROW_WORDS,
  backRowColors,
  encodeLevels,
  HEARD_ABOVE_ROOM_DB,
  isHeard,
  liveRoomFloor,
  quantizeDbfs,
  roomFloor,
  SILENT_DECAY,
  stepDecayFrames,
  type DecayLevel,
} from "@/lib/backRowVoice";
import {
  DEFAULT_FACING_ZONE,
  encodeFacing,
  FACING_FRAME_MS,
  FACING_UPLOAD_MAX_CHARS,
  headNow,
  nudgeToward,
  readFacing,
  type FacingZone,
  type HeadNow,
} from "@/lib/facingRoom";
import { METER_FRAME_MS } from "@/lib/micLevel";
import { darkThemeColors, fonts, useColors, type Colors } from "@/theme";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { PresentationButton } from "@/components/slides/SlidesPresentationNative";
import { formatClock, recordFrame } from "@/lib/rehearsalTake";
import { HeaderPillButton } from "@/components/HeaderPillButton";
import { AwayNudge } from "./AwayNudge";
import { HeadPyramid } from "./HeadPyramid";
import { TakeReviewNative, type ReviewTake } from "./TakeReviewNative";
import { TakeSaveBox } from "./TakeSaveBox";
import {
  discard as discardSavedTake,
  release as releaseSavedTake,
  saveTake,
  useMeterTakeSaves,
} from "@/lib/meterTakeSaver";
import { TALK_COPY } from "./talkCopy";

/** About 2.5 Mbit/s of HEVC at 720p: roughly 19 MB a minute, half the camera's default. */
const VIDEO_BITRATE = 2_500_000;
/** Room readings kept while waiting, for the floor (roomFloor looks at the last 4 s). */
const ROOM_FRAMES_KEPT = Math.round(6000 / METER_FRAME_MS);
/** Frames kept while listening alone: the 20 s the live room floor looks at. */
const LIVE_FRAMES_KEPT = Math.round(20_000 / METER_FRAME_MS);
/** A quiet classroom reads around here; used only if the room was never heard. */
const FALLBACK_ROOM_DBFS = -50;
/**
 * How long reading head direction off a take may run before the take goes
 * without it (sent, or reviewed here): this plus a quarter of the video's
 * length. iPad XVR (A16) read the first real take, 34 s, in 2.4 s.
 */
const HEAD_POSE_BASE_MS = 15_000;
/** How often a linked BunnyPad tells the server it is still watching. */
const LISTENER_HEARTBEAT_MS = 20_000;
/** Waits before each retry of a failed upload; after the last, the take is marked failed. */
const UPLOAD_RETRY_MS = [2_000, 5_000, 15_000];
/** The camera never takes longer than this to start; a bigger gap is a bad measurement. */
const MAX_START_DELAY_MS = 3_000;

/**
 * Audience mode: this BunnyPad sits at the back of the room, facing whoever is
 * speaking, and its whole screen turns green while the back of the room can
 * hear them.
 *
 * It opens listening on its own. As soon as someone at this school is
 * presenting or rehearsing on their own BunnyPad with nobody watching, it links
 * to them: when they start recording a take, this BunnyPad films it, and when
 * they stop, the video goes to them (and their teachers) and this BunnyPad
 * keeps no copy. Stop watching opts out of that talk for good; Watch a
 * presenter picks one by hand.
 */
export function AudienceModeNative() {
  const [mode, setMode] = useState<
    { kind: "alone" } | { kind: "pick" } | { kind: "watch"; talkId: Id<"liveTalks"> }
  >({ kind: "alone" });
  // Talks this BunnyPad left (or couldn't join): never linked to again by itself.
  const declinedRef = useRef(new Set<string>());
  const talks = useQuery(api.liveTalks.listForAudience, mode.kind === "alone" ? {} : "skip");
  const join = useMutation(api.liveTalks.join);
  const joiningRef = useRef(false);
  // Filming or reviewing a take of its own: wait until that's over.
  const [aloneBusy, setAloneBusy] = useState(false);
  // The green threshold, in dB over the room: dragged on the meter, kept while it's open.
  const [thresholdDb, setThresholdDb] = useState(HEARD_ABOVE_ROOM_DB);
  // Facing the room: the pyramid beside the camera, moved and resized there, kept while it's open.
  const [facingZone, setFacingZone] = useState<FacingZone>(DEFAULT_FACING_ZONE);
  // Which halves the live screen shows, picked in the header and kept while it's open.
  const [layout, setLayout] = useState<MeterLayout>("both");

  // Snap to the first presentation with nobody watching it yet.
  useEffect(() => {
    if (mode.kind !== "alone" || aloneBusy || !talks || joiningRef.current) return;
    const free = talks.find(
      (talk) => talk.listening === null && !declinedRef.current.has(talk.talkId),
    );
    if (!free) return;
    joiningRef.current = true;
    void joinTalk(() => join({ talkId: free.talkId })).then((refusal) => {
      joiningRef.current = false;
      if (refusal) declinedRef.current.add(free.talkId);
      else setMode({ kind: "watch", talkId: free.talkId });
    });
  }, [aloneBusy, join, mode.kind, talks]);

  if (mode.kind === "watch") {
    const { talkId } = mode;
    return (
      <Watching
        talkId={talkId}
        thresholdDb={thresholdDb}
        onThresholdChange={setThresholdDb}
        zone={facingZone}
        onZoneChange={setFacingZone}
        layout={layout}
        onDone={() => {
          declinedRef.current.add(talkId);
          setMode({ kind: "alone" });
        }}
      />
    );
  }
  if (mode.kind === "pick") {
    return (
      <PickPresenter
        onPick={(talkId) => setMode({ kind: "watch", talkId })}
        onListenAlone={() => setMode({ kind: "alone" })}
      />
    );
  }
  return (
    <ListenAlone
      thresholdDb={thresholdDb}
      onThresholdChange={setThresholdDb}
      zone={facingZone}
      onZoneChange={setFacingZone}
      layout={layout}
      onLayoutChange={setLayout}
      presenting={(talks?.length ?? 0) > 0}
      onLinkPresentation={() => setMode({ kind: "pick" })}
      onBusy={setAloneBusy}
    />
  );
}

function PickPresenter({
  onPick,
  onListenAlone,
}: {
  onPick: (talkId: Id<"liveTalks">) => void;
  onListenAlone: () => void;
}) {
  const colors = useColors();
  const talks = useQuery(api.liveTalks.listForAudience, {});
  const join = useMutation(api.liveTalks.join);
  const [joining, setJoining] = useState<Id<"liveTalks"> | null>(null);

  const pick = useCallback(
    async (talkId: Id<"liveTalks">) => {
      setJoining(talkId);
      const refusal = await joinTalk(() => join({ talkId }));
      setJoining(null);
      if (refusal) Alert.alert(TALK_COPY.audienceTitle, refusal);
      else onPick(talkId);
    },
    [join, onPick],
  );

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={styles.pickPage}
    >
      <Stack.Screen
        // The listening screen's header pills are items, which draw over headerRight: clear both.
        options={{
          ...LIGHT_HEADER,
          title: TALK_COPY.audienceTitle,
          headerShown: true,
          headerRight: undefined,
          unstable_headerRightItems: undefined,
        }}
      />
      <Text accessibilityRole="header" style={[styles.pickHeading, { color: colors.fg, fontFamily: fonts.semibold }]}>
        {TALK_COPY.pickHeading}
      </Text>
      {talks === undefined ? (
        <ActivityIndicator color={colors.fgMuted} />
      ) : talks === null || talks.length === 0 ? (
        <Text style={[styles.empty, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          {talks === null ? TALK_COPY.noSchool : TALK_COPY.nobodyPresenting}
        </Text>
      ) : (
        <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.bg }]}>
          {talks.map((talk, i) => {
            const taken = talk.listening === "someone";
            return (
              <Pressable
                key={talk.talkId}
                accessibilityRole="button"
                disabled={taken || joining !== null}
                onPress={() => void pick(talk.talkId)}
                style={({ pressed }) => [
                  styles.row,
                  i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
                  pressed && { backgroundColor: colors.bgSubtle },
                  taken && styles.disabled,
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.rowName, { color: colors.fg, fontFamily: fonts.semibold }]}>
                    {talk.presenterName}
                  </Text>
                  <Text numberOfLines={1} style={[styles.rowDetail, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
                    {taken
                      ? TALK_COPY.someoneWatching
                      : talk.mode === "rehearse"
                        ? TALK_COPY.rehearsingRow(talk.title)
                        : TALK_COPY.presentingRow(talk.title)}
                  </Text>
                </View>
                {joining === talk.talkId ? <ActivityIndicator color={colors.fgMuted} /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
      <View style={styles.cardButtons}>
        <PresentationButton label={TALK_COPY.listenAlone} onPress={onListenAlone} colors={colors} />
      </View>
    </ScrollView>
  );
}

/** The thermometer's scale, dBFS: the BunnyPad microphone's own digital level. */
const SCALE_TOP_DBFS = -10;
const SCALE_BOTTOM_DBFS = -70;
const SCALE_TICK_DB = 10;
const SCALE_HEIGHT = 480;
const PX_PER_DB = SCALE_HEIGHT / (SCALE_TOP_DBFS - SCALE_BOTTOM_DBFS);
/** How far over the room the green threshold may be dragged. */
const THRESHOLD_MIN_DB = 1;
const THRESHOLD_MAX_DB = 30;
/** The height of one labeled row on the scale (a tick, the room line). */
const METER_ROW = 20;

/** What the meter shows each frame: the reading, the decay line, and the room it's judged against. */
type MeterReading = { dbfs: number | null; decay: DecayLevel; roomDbfs: number | null };
const QUIET_READING: MeterReading = { dbfs: null, decay: SILENT_DECAY, roomDbfs: null };

/** Green while the decay line is at or above the threshold over the room (`isHeard`, the review's rule too). */
function meterIsGreen(reading: MeterReading, thresholdDb: number): boolean {
  return reading.roomDbfs !== null && isHeard(reading.decay.dbfs, reading.roomDbfs, thresholdDb);
}

/** Dark grey until the back row can hear; green while it can. */
function meterColors(dark: boolean, green: boolean): { fill: string; ink: string; word: string } {
  const color = green ? backRowColors(dark).heard : backRowColors(true).listening;
  return { ...color, word: green ? BACK_ROW_WORDS.heard : BACK_ROW_WORDS.listening };
}

function scaleY(dbfs: number): number {
  const clamped = Math.max(SCALE_BOTTOM_DBFS, Math.min(SCALE_TOP_DBFS, dbfs));
  return (SCALE_TOP_DBFS - clamped) * PX_PER_DB;
}

function clampThreshold(db: number): number {
  return Math.round(Math.max(THRESHOLD_MIN_DB, Math.min(THRESHOLD_MAX_DB, db)));
}

/**
 * The level meter, labeled like an audio engineer's: dBFS, the microphone's
 * own digital level (it isn't calibrated to sound pressure, so dB SPL would be
 * invented). The bar is each reading; the line above it is the decay line,
 * which jumps up at once and falls slowly. The dashed line is the room's own
 * level, measured from the quiet moments; the triangle is the green threshold,
 * a set number of dB over the room, and dragging it moves it.
 */
function Thermometer({
  reading,
  ink,
  thresholdDb,
  onThresholdChange,
}: {
  reading: MeterReading;
  /** The screen's text color: the meter is drawn straight on its background. */
  ink: string;
  thresholdDb: number;
  onThresholdChange: (db: number) => void;
}) {
  // Where a drag of the triangle started: the finger's height and the threshold then.
  const dragRef = useRef<{ pageY: number; db: number } | null>(null);
  const ticks: number[] = [];
  for (let db = SCALE_TOP_DBFS; db >= SCALE_BOTTOM_DBFS; db -= SCALE_TICK_DB) ticks.push(db);
  const level = reading.dbfs === null ? null : scaleY(reading.dbfs);
  const decay = reading.dbfs === null ? null : scaleY(reading.decay.dbfs);
  const room = reading.roomDbfs === null ? null : scaleY(reading.roomDbfs);
  const threshold = reading.roomDbfs === null ? null : scaleY(reading.roomDbfs + thresholdDb);
  const label = [styles.meterLabel, { color: ink, fontFamily: fonts.medium }];
  return (
    <View style={styles.meterColumn}>
      <Text style={[styles.meterUnit, { color: ink, fontFamily: fonts.semibold }]}>dBFS</Text>
      <View style={styles.meterScale}>
        {ticks.map((db) => (
          <View key={db} style={[styles.meterTick, { top: scaleY(db) - METER_ROW / 2 }]}>
            <Text style={label}>{db}</Text>
            <View style={[styles.meterTickMark, { backgroundColor: ink }]} />
          </View>
        ))}
        <View style={[styles.meterTrack, { backgroundColor: ink }]} />
        {level !== null ? (
          <View style={[styles.meterFill, { top: level, backgroundColor: ink }]} />
        ) : null}
        {room !== null ? (
          <View style={[styles.meterRoom, { top: room - METER_ROW / 2 }]}>
            <View style={[styles.meterRoomLine, { borderColor: ink }]} />
            <Text style={label}>room</Text>
          </View>
        ) : null}
        {decay !== null ? (
          <View style={[styles.meterDecay, { top: decay - 2, backgroundColor: ink }]} />
        ) : null}
        {threshold !== null ? (
          <View
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={(event) => {
              dragRef.current = { pageY: event.nativeEvent.pageY, db: thresholdDb };
            }}
            onResponderMove={(event) => {
              const start = dragRef.current;
              if (!start) return;
              const next = clampThreshold(start.db - (event.nativeEvent.pageY - start.pageY) / PX_PER_DB);
              if (next !== thresholdDb) onThresholdChange(next);
            }}
            onResponderRelease={() => {
              dragRef.current = null;
            }}
            accessibilityRole="adjustable"
            accessibilityLabel={`Green threshold, ${thresholdDb} dB over the room`}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(event) =>
              onThresholdChange(
                clampThreshold(thresholdDb + (event.nativeEvent.actionName === "increment" ? 1 : -1)),
              )
            }
            style={[styles.meterThreshold, { top: threshold - 22 }]}
          >
            <Svg width={20} height={22}>
              <Polygon points="0,11 20,0 20,22" fill={ink} />
            </Svg>
            <Text style={[styles.meterThresholdLabel, { color: ink, fontFamily: fonts.semibold }]}>
              +{thresholdDb} dB
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Takes kept while listening on its own; older ones are deleted. */
const KEPT_ALONE_TAKES = 3;

/** A take being filmed with nobody linked: levels count from `startedAt`, as for a linked take. */
/**
 * A take being filmed with nobody linked. The meter keeps following the room
 * through it, so `rooms` holds the room it judged each frame against;
 * `thresholdDb` is the green threshold at Stop.
 */
type AloneFilming = {
  startedAt: number;
  roomDbfs: number;
  levels: number[];
  rooms: number[];
  stopRequestedAt: number | null;
  thresholdDb: number | null;
};

/**
 * Listening with nobody linked, where audience mode opens: straight onto the
 * back row's word on the whole screen. With no quiet moment before a take, the
 * room's floor comes from the pauses of the last 20 s (`liveRoomFloor`), so it
 * reads "Listening" for its first couple of seconds. Without a presenter's own
 * BunnyPad a voice too quiet to rise over the room at all reads as a pause.
 *
 * Record films a take with the front camera while the word keeps showing; Stop
 * opens its review here, the same review a presenter sees, with the back row's
 * video and how much of it the back row heard. Every take is also saved for
 * the school (meterTakeSaver): it lands in the teachers' scanner inbox unless
 * the review names the speaker, and the review shows what was said once it is
 * written out. The last few takes stay reviewable here while audience mode is
 * open; their videos leave this BunnyPad once they're saved and let go.
 */
function ListenAlone({
  presenting,
  onLinkPresentation,
  onBusy,
  thresholdDb,
  onThresholdChange,
  zone,
  onZoneChange,
  layout,
  onLayoutChange,
}: {
  /** The green threshold, in dB over the room. */
  thresholdDb: number;
  onThresholdChange: (db: number) => void;
  /** Where the head points while it faces the room. */
  zone: FacingZone;
  onZoneChange: (zone: FacingZone) => void;
  /** Which halves the live screen shows. */
  layout: MeterLayout;
  onLayoutChange: (layout: MeterLayout) => void;
  /** Someone at this school is presenting or rehearsing right now. */
  presenting: boolean;
  onLinkPresentation: () => void;
  /** Recording or reviewing: not a moment to jump to someone's talk. */
  onBusy: (busy: boolean) => void;
}) {
  useKeepAwakeUnlessBedtime();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const dark = useColorScheme() === "dark";
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const askedRef = useRef(false);
  const permissionsKnown = micPermission !== null && cameraPermission !== null;
  useEffect(() => {
    if (askedRef.current || !permissionsKnown) return;
    askedRef.current = true;
    void (async () => {
      if (!micPermission?.granted) await requestMic();
      if (!cameraPermission?.granted) await requestCamera();
    })();
  }, [cameraPermission?.granted, micPermission?.granted, permissionsKnown, requestCamera, requestMic]);
  const allowed = micPermission?.granted === true;
  const refused = micPermission !== null && !micPermission.granted && !micPermission.canAskAgain;
  const canFilm = cameraPermission?.granted === true;

  const heardRef = useRef<number[]>([]);
  const filmRef = useRef<AloneFilming | null>(null);
  const [reading, setReading] = useState<MeterReading>(QUIET_READING);
  const onFrame = useCallback((frame: MicFrame) => {
    // The meter judges the reading as the take stores it (`quantizeDbfs`), so
    // the review replays exactly what this screen showed.
    const dbfs = quantizeDbfs(frame.dbfs);
    const heard = heardRef.current;
    heard.push(dbfs);
    if (heard.length > LIVE_FRAMES_KEPT) heard.splice(0, heard.length - LIVE_FRAMES_KEPT);
    const film = filmRef.current;
    // While filming, the room it can't measure yet is the one the take started with.
    const room = liveRoomFloor(heard) ?? (film ? film.roomDbfs : null);
    let frames = 1;
    if (film && room !== null) {
      // One level per frame on the recording's clock, filling any frame
      // skipped; the decay line steps once per filled frame, as the review will.
      frames = recordFrame(film.levels, Date.now() - film.startedAt, dbfs);
      for (let i = 0; i < frames; i++) film.rooms.push(room);
    }
    setReading((prev) => ({
      dbfs: frame.dbfs,
      decay: stepDecayFrames(prev.decay, dbfs, frames),
      roomDbfs: room,
    }));
  }, []);
  usePresentingMic({ enabled: allowed, onFrame });

  // ── Filming a take ──
  const cameraRef = useRef<FacingRoomCameraHandle>(null);
  const [head, onHeadPose] = useLiveHead(zone);
  const [cameraReady, setCameraReady] = useState(false);
  const [filming, setFilming] = useState(false);
  // The take's running time, for the count-up clock above Record.
  const [filmStartedAt, setFilmStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (filmStartedAt === null) return;
    const tick = setInterval(() => setElapsedMs(Date.now() - filmStartedAt), 250);
    return () => clearInterval(tick);
  }, [filmStartedAt]);
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filmFailed, setFilmFailed] = useState(false);
  const [takes, setTakes] = useState<ReviewTake[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const takesRef = useRef<ReviewTake[]>([]);
  useEffect(() => {
    takesRef.current = takes;
  }, [takes]);
  // Closing audience mode lets go of the takes filmed here; each video goes
  // from this BunnyPad once its save is over. A take whose save starts after
  // the meter has closed is let go as soon as it starts.
  const openRef = useRef(true);
  useEffect(
    () => () => {
      openRef.current = false;
      for (const take of takesRef.current) releaseSavedTake(take.id);
    },
    [],
  );
  const saves = useMeterTakeSaves();
  const savedIds = takes.flatMap((take) => {
    const save = saves.get(take.id);
    return save?.state === "saved" ? [save.portfolioItemId] : [];
  });
  const savedRows = useQuery(
    api.decibelMeter.takesForRecorder,
    savedIds.length > 0 ? { portfolioItemIds: savedIds } : "skip",
  );

  const reviewing = selected !== null && takes.length > 0;
  const busy = filming || saving || reviewing;
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);

  // The zone when a take's head direction is read, which is after the take.
  const zoneRef = useRef(zone);
  useEffect(() => {
    zoneRef.current = zone;
  }, [zone]);
  // The threshold a take is judged by, as the meter had it at Stop.
  const thresholdRef = useRef(thresholdDb);
  useEffect(() => {
    thresholdRef.current = thresholdDb;
  }, [thresholdDb]);
  const record = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera || filmRef.current) return;
    const film: AloneFilming = {
      startedAt: Date.now(),
      roomDbfs: liveRoomFloor(heardRef.current) ?? FALLBACK_ROOM_DBFS,
      levels: [],
      rooms: [],
      stopRequestedAt: null,
      thresholdDb: null,
    };
    filmRef.current = film;
    // The take's decay line starts silent, live and in its review alike (as it
    // does when a linked presenter starts a take).
    setReading((prev) => ({ ...prev, decay: SILENT_DECAY }));
    setFilmFailed(false);
    setFilming(true);
    setElapsedMs(0);
    setFilmStartedAt(film.startedAt);
    void (async () => {
      const uri = await recordVideo(camera);
      const endedAt = film.stopRequestedAt ?? Date.now();
      filmRef.current = null;
      setFilming(false);
      setFilmStartedAt(null);
      setStopping(false);
      if (!uri) {
        setFilmFailed(true);
        return;
      }
      setSaving(true);
      // The camera starts a moment after it is asked to: drop the levels from
      // before it did, so the take's clock is the video's.
      const videoMs = await videoDurationMs(uri);
      const wallMs = endedAt - film.startedAt;
      const startDelayMs =
        videoMs === null ? 0 : Math.max(0, Math.min(MAX_START_DELAY_MS, wallMs - videoMs));
      // The review starts where the video does, its decay line silent there:
      // speech in the camera's start-up moment (usually under a second) isn't
      // carried into the review's first moment the way the screen carried it.
      const startFrame = Math.round(startDelayMs / METER_FRAME_MS);
      const thresholdDb = film.thresholdDb ?? thresholdRef.current;
      const take: ReviewTake = {
        version: 1,
        id: `back-${film.startedAt}`,
        recordedAt: film.startedAt + startDelayMs,
        durationMs: videoMs ?? wallMs,
        frameMs: METER_FRAME_MS,
        levels: [],
        slides: [],
        audioFile: "",
        audioUri: null,
        localBackRow: {
          url: uri,
          recording: {
            dbfs: film.levels.slice(startFrame),
            frameMs: METER_FRAME_MS,
            roomDbfs: film.roomDbfs,
            roomDbfsAt: film.rooms.slice(startFrame),
            thresholdDb,
            offsetMs: 0,
          },
        },
      };
      const kept = [...takesRef.current, take];
      for (const old of kept.slice(0, Math.max(0, kept.length - KEPT_ALONE_TAKES))) {
        releaseSavedTake(old.id);
      }
      const next = kept.slice(-KEPT_ALONE_TAKES);
      setTakes(next);
      setSelected(next.length - 1);
      setSaving(false);

      // The review opens at once; when or whether the presenter turned away
      // fills in once this BunnyPad has read it off the video. The save waits
      // for the same read, so it carries head direction too.
      const posePromise = readHeadPose(uri, FACING_FRAME_MS, HEAD_POSE_BASE_MS + take.durationMs / 4);
      saveTake({
        takeId: take.id,
        uri,
        durationMs: take.durationMs,
        levels: take.localBackRow?.recording.dbfs ?? [],
        frameMs: METER_FRAME_MS,
        roomDbfs: film.roomDbfs,
        thresholdDb,
        pose: posePromise,
        zone: () => zoneRef.current,
      });
      if (!openRef.current) releaseSavedTake(take.id);
      const pose = await posePromise;
      if (!pose) return;
      const facing = readFacing(pose.frames, pose.frameMs, zoneRef.current);
      setTakes((current) =>
        current.map((t) =>
          t.id === take.id && t.localBackRow ? { ...t, localBackRow: { ...t.localBackRow, facing } } : t,
        ),
      );
    })();
  }, []);

  // A stop that arrives before the camera has really started is lost, so keep asking until it ends.
  const stop = useCallback(() => {
    const film = filmRef.current;
    if (film && film.stopRequestedAt === null) {
      film.stopRequestedAt = Date.now();
      // The take is judged by the threshold now, not after the video has saved.
      film.thresholdDb = thresholdRef.current;
    }
    setStopping(true);
    cameraRef.current?.stopRecording();
  }, []);
  useEffect(() => {
    if (!stopping || !filming) return;
    const again = setInterval(() => cameraRef.current?.stopRecording(), 500);
    return () => clearInterval(again);
  }, [filming, stopping]);

  // Linking to a presentation, when someone is giving one, and Record or Stop:
  // the app's header pills, as one custom item with iOS 26's shared glass
  // capsule hidden (see HeaderPillButton).
  const headerItems = useCallback(
    () => [
      {
        type: "custom" as const,
        hidesSharedBackground: true,
        element: (
          <View style={styles.headerButtons}>
            {!filming && presenting ? (
              <HeaderPillButton icon="link" label={TALK_COPY.linkPresentation} onPress={onLinkPresentation} />
            ) : null}
            {canFilm ? (
              <HeaderPillButton
                icon={filming ? "stop.circle" : "record.circle"}
                label={saving ? TALK_COPY.saving : filming ? TALK_COPY.stop : TALK_COPY.record}
                busy={saving}
                disabled={saving || stopping || (!filming && !cameraReady)}
                onPress={filming ? stop : record}
              />
            ) : null}
          </View>
        ),
      },
    ],
    [cameraReady, canFilm, filming, onLinkPresentation, presenting, record, saving, stop, stopping],
  );

  if (refused) {
    return (
      <Centered colors={colors} insets={insets}>
        <Text style={[styles.message, { color: colors.fg, fontFamily: fonts.medium }]}>
          {TALK_COPY.needsMic}
        </Text>
      </Centered>
    );
  }
  if (reviewing && selected !== null) {
    // Each saved take's transcript, once the server has written it out.
    const reviewTakes = takes.map((take): ReviewTake => {
      const save = saves.get(take.id);
      const row =
        save?.state === "saved"
          ? savedRows?.find((r) => r.portfolioItemId === save.portfolioItemId)
          : undefined;
      return row?.transcriptStatus
        ? {
            ...take,
            transcript: {
              status: row.transcriptStatus,
              segments: row.transcriptSegments
                ? (JSON.parse(row.transcriptSegments) as [number, number, string][])
                : [],
              wordCount: row.wordCount,
              fillerCount: row.fillerCount,
            },
          }
        : take;
    });
    const discardTake = (takeId: string) => {
      Alert.alert(TALK_COPY.discardTitle, TALK_COPY.discardBody, [
        { text: TALK_COPY.keepIt, style: "cancel" },
        {
          text: TALK_COPY.discard,
          style: "destructive",
          onPress: () => {
            void discardSavedTake(takeId).catch((error: unknown) => {
              // The take stays saved (a teacher filed it meanwhile): say so.
              console.warn("[audience] discarding a take failed", error);
              const message =
                error instanceof ConvexError
                  ? (error.data as { message?: unknown } | null)?.message
                  : null;
              Alert.alert(TALK_COPY.discardFailed, typeof message === "string" ? message : undefined);
            });
            const remaining = takesRef.current.filter((t) => t.id !== takeId);
            setTakes(remaining);
            if (remaining.length === 0) {
              setCameraReady(false);
              setSelected(null);
            } else {
              setSelected((current) => Math.min(current ?? 0, remaining.length - 1));
            }
          },
        },
      ]);
    };
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <TakeReviewNative
          title={TALK_COPY.backReviewTitle}
          deck={null}
          takes={reviewTakes}
          selected={Math.min(selected, takes.length - 1)}
          onSelect={setSelected}
          takeExtras={(take) => (
            <TakeSaveBox
              takeId={take.id}
              save={saves.get(take.id) ?? null}
              row={(() => {
                const save = saves.get(take.id);
                return save?.state === "saved"
                  ? (savedRows?.find((r) => r.portfolioItemId === save.portfolioItemId) ?? null)
                  : null;
              })()}
              onDiscard={() => discardTake(take.id)}
            />
          )}
          againLabel={TALK_COPY.recordAgain}
          // The camera opens again on leaving the review: Record waits for it.
          onAgain={() => {
            setCameraReady(false);
            setSelected(null);
          }}
          onDone={() => {
            setCameraReady(false);
            setSelected(null);
          }}
        />
      </>
    );
  }
  const meter = meterColors(dark, meterIsGreen(reading, thresholdDb));
  return (
    <View style={[styles.watching, { backgroundColor: "#000" }]}>
      <StatusBar style="light" />
      <Stack.Screen
        options={{
          ...DARK_HEADER,
          title: TALK_COPY.audienceTitle,
          headerShown: true,
          // Which halves to show, once there's a camera to show a face with.
          headerTitle: canFilm
            ? () => (
                <ViewToggle
                  options={LAYOUT_OPTIONS}
                  value={layout}
                  onChange={onLayoutChange}
                  colors={darkThemeColors}
                />
              )
            : undefined,
          unstable_headerRightItems: headerItems,
        }}
      />
      <SplitMeter
        layout={layout}
        face={canFilm ? { head, zone, onZoneChange, pipTop: PIP_TOP } : null}
        reading={reading}
        thresholdDb={thresholdDb}
        onThresholdChange={onThresholdChange}
      >
        {filming || filmFailed ? (
          <Text
            accessibilityLabel={filming ? `${TALK_COPY.recordingHere} ${formatClock(elapsedMs)}` : undefined}
            style={[
              filming ? styles.aloneClock : styles.cueName,
              { color: meter.ink, fontFamily: filming ? fonts.semibold : fonts.medium },
            ]}
          >
            {filming ? `● ${formatClock(elapsedMs)}` : TALK_COPY.filmFailed}
          </Text>
        ) : null}
      </SplitMeter>
      {canFilm ? (
        <View style={pipStyle(layout, width, PIP_TOP)} pointerEvents={layout === "voice" ? "none" : "auto"}>
          <FacingRoomCamera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            poseFrameMs={LIVE_POSE_MS}
            videoBitrate={VIDEO_BITRATE}
            onReady={() => setCameraReady(true)}
            onMountError={(message) => {
              console.warn("[audience] camera failed", message);
              setCameraReady(false);
            }}
            onHeadPose={onHeadPose}
          />
        </View>
      ) : null}
    </View>
  );
}

type Upload =
  | { kind: "none" }
  | { kind: "sending"; pct: number | null }
  | { kind: "sent" }
  | { kind: "failed" };

/** One take being filmed: its levels count from `startedAt`, the moment the camera was asked to record. */
type Filming = {
  recordingId: Id<"talkRecordings">;
  startedAt: number;
  roomDbfs: number;
  levels: number[];
  stopRequestedAt: number | null;
  /** The green threshold when the take stopped. */
  thresholdDb: number | null;
};

function Watching({
  talkId,
  onDone,
  thresholdDb,
  onThresholdChange,
  zone,
  onZoneChange,
  layout,
}: {
  talkId: Id<"liveTalks">;
  onDone: () => void;
  /** The green threshold, in dB over the room. */
  thresholdDb: number;
  onThresholdChange: (db: number) => void;
  /** Where the head points while it faces the room. */
  zone: FacingZone;
  onZoneChange: (zone: FacingZone) => void;
  /** Which halves the live screen shows (picked in the listening screen's header). */
  layout: MeterLayout;
}) {
  useKeepAwakeUnlessBedtime();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const dark = useColorScheme() === "dark";
  const talk = useQuery(api.liveTalks.forListener, { talkId });
  const leave = useMutation(api.liveTalks.leave);
  const generateUploadUrl = useMutation(api.liveTalks.generateUploadUrl);
  const finishUpload = useMutation(api.liveTalks.finishUpload);
  const markUploadFailed = useMutation(api.liveTalks.markUploadFailed);

  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  // Ask once, as this screen opens (iOS shows each prompt only the first time).
  const askedRef = useRef(false);
  const permissionsKnown = cameraPermission !== null && micPermission !== null;
  useEffect(() => {
    if (askedRef.current || !permissionsKnown) return;
    askedRef.current = true;
    void (async () => {
      if (!cameraPermission?.granted) await requestCamera();
      if (!micPermission?.granted) await requestMic();
    })();
  }, [cameraPermission?.granted, micPermission?.granted, permissionsKnown, requestCamera, requestMic]);
  const allowed = cameraPermission?.granted === true && micPermission?.granted === true;
  const refused =
    (cameraPermission && !cameraPermission.granted && !cameraPermission.canAskAgain) ||
    (micPermission && !micPermission.granted && !micPermission.canAskAgain);

  // ── Listening: the room before a take, the back row during one ──
  const cameraRef = useRef<FacingRoomCameraHandle>(null);
  const [head, onHeadPose] = useLiveHead(zone);
  // The zone when a take is sent, and the green threshold when it stops: the
  // presenter's review judges the take as this meter had them.
  const zoneRef = useRef(zone);
  useEffect(() => {
    zoneRef.current = zone;
  }, [zone]);
  const thresholdRef = useRef(thresholdDb);
  useEffect(() => {
    thresholdRef.current = thresholdDb;
  }, [thresholdDb]);
  const [cameraReady, setCameraReady] = useState(false);
  // The camera wouldn't open (no camera, or it failed): takes can't be filmed.
  const [cameraFailed, setCameraFailed] = useState(false);
  const roomRef = useRef<number[]>([]);
  const filmRef = useRef<Filming | null>(null);
  const [reading, setReading] = useState<MeterReading>(QUIET_READING);
  const onFrame = useCallback((frame: MicFrame) => {
    const film = filmRef.current;
    if (!film) {
      const room = roomRef.current;
      room.push(frame.dbfs);
      if (room.length > ROOM_FRAMES_KEPT) room.splice(0, room.length - ROOM_FRAMES_KEPT);
      return;
    }
    // One level per frame on the recording's clock, as the upload sends it
    // (`quantizeDbfs`), filling any frame skipped; the decay line steps once
    // per filled frame, so the presenter's review replays what this screen showed.
    const dbfs = quantizeDbfs(frame.dbfs);
    const frames = recordFrame(film.levels, Date.now() - film.startedAt, dbfs);
    setReading((prev) => ({
      dbfs: frame.dbfs,
      decay: stepDecayFrames(prev.decay, dbfs, frames),
      roomDbfs: film.roomDbfs,
    }));
  }, []);
  // The microphone starts before the camera records (see the TRA-715 spike:
  // the other order leaves a gap in the video's sound).
  usePresentingMic({ enabled: allowed && talk?.state !== "ended", onFrame });

  // Still linked: tell the server every 20 s, so a BunnyPad that was closed
  // or put away is unlinked within a minute.
  const heartbeat = useMutation(api.liveTalks.listenerHeartbeat);
  useEffect(() => {
    const timer = setInterval(() => {
      void heartbeat({ talkId }).catch(() => {});
    }, LISTENER_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [heartbeat, talkId]);
  // Leaving this screen any way (Stop watching, the back gesture) unlinks it.
  useEffect(() => () => void leave({ talkId }).catch(() => {}), [leave, talkId]);

  // ── Recording: follow the presenter's Start and Stop, take by take ──
  const [upload, setUpload] = useState<Upload>({ kind: "none" });
  const [filmingId, setFilmingId] = useState<Id<"talkRecordings"> | null>(null);
  const handledRef = useRef(new Set<string>());
  const recording = talk?.recording ?? null;
  const takeIsLive =
    talk?.connected === true &&
    talk.state === "recording" &&
    recording?.status === "recording";
  const canFilm = allowed && cameraReady;

  const sendVideo = useCallback(
    async (uri: string, film: Filming, timing: { durationMs: number; startDelayMs: number }) => {
      setUpload({ kind: "sending", pct: null });
      // Read the presenter's head direction off the video while it uploads;
      // the take goes without it if that fails or takes too long.
      const facing = readHeadPose(uri, FACING_FRAME_MS, HEAD_POSE_BASE_MS + timing.durationMs / 4);
      const outcome = await uploadTake({
        uri,
        film,
        timing,
        facing,
        zone: zoneRef.current,
        thresholdDb: film.thresholdDb ?? thresholdRef.current,
        generateUploadUrl,
        finishUpload,
        onProgress: (pct) => setUpload({ kind: "sending", pct }),
      });
      if (outcome === "failed") {
        void markUploadFailed({ recordingId: film.recordingId }).catch(() => {});
      }
      setUpload({ kind: outcome === "sent" ? "sent" : outcome === "failed" ? "failed" : "none" });
      // This BunnyPad keeps no copy, sent or not, once nothing still reads it.
      await facing;
      await deleteQuietly(uri);
    },
    [finishUpload, generateUploadUrl, markUploadFailed],
  );

  // Start filming a take the presenter started.
  useEffect(() => {
    if (!takeIsLive || !recording || filmingId !== null) return;
    if (handledRef.current.has(recording.recordingId)) return;
    if (!canFilm) {
      // No camera here (refused, or it never opened): say so now, rather
      // than leave the presenter waiting for a video.
      if (refused || cameraFailed) {
        handledRef.current.add(recording.recordingId);
        void markUploadFailed({ recordingId: recording.recordingId }).catch(() => {});
      }
      return;
    }
    const camera = cameraRef.current;
    if (!camera) return;
    handledRef.current.add(recording.recordingId);
    const film: Filming = {
      recordingId: recording.recordingId,
      startedAt: Date.now(),
      roomDbfs: roomFloor(roomRef.current) ?? FALLBACK_ROOM_DBFS,
      levels: [],
      stopRequestedAt: null,
      thresholdDb: null,
    };
    filmRef.current = film;
    setReading({ ...QUIET_READING, roomDbfs: film.roomDbfs });
    setUpload({ kind: "none" });
    setFilmingId(film.recordingId);
    void (async () => {
      const uri = await recordVideo(camera);
      const endedAt = film.stopRequestedAt ?? Date.now();
      filmRef.current = null;
      roomRef.current = [];
      setFilmingId(null);
      if (!uri) {
        void markUploadFailed({ recordingId: film.recordingId }).catch(() => {});
        return;
      }
      // The camera starts a moment after it is asked to, and the levels
      // were counted from the asking: measure the gap from the video's own
      // length so the levels (and the presenter's sound) line up with it.
      const videoMs = await videoDurationMs(uri);
      const wallMs = endedAt - film.startedAt;
      const startDelayMs =
        videoMs === null ? 0 : Math.max(0, Math.min(MAX_START_DELAY_MS, wallMs - videoMs));
      await sendVideo(uri, film, { durationMs: videoMs ?? wallMs, startDelayMs });
    })();
  }, [cameraFailed, canFilm, filmingId, markUploadFailed, recording, refused, sendVideo, takeIsLive]);

  // Stop filming when that take is over: stopped, replaced by a newer take,
  // or this BunnyPad was disconnected. A stop that arrives before the camera
  // has really started is lost, so keep asking until it ends.
  const filmingThisTake = filmingId !== null && recording?.recordingId === filmingId && takeIsLive;
  useEffect(() => {
    if (filmingId === null || filmingThisTake) return;
    const film = filmRef.current;
    if (film && film.stopRequestedAt === null) {
      film.stopRequestedAt = Date.now();
      film.thresholdDb = thresholdRef.current;
    }
    cameraRef.current?.stopRecording();
    const again = setInterval(() => cameraRef.current?.stopRecording(), 500);
    return () => clearInterval(again);
  }, [filmingId, filmingThisTake]);

  const stopWatching = useCallback(() => {
    cameraRef.current?.stopRecording();
    void leave({ talkId }).catch(() => {});
    onDone();
  }, [leave, onDone, talkId]);

  // ── Drawing ──
  const name = talk?.presenterName ?? "";
  const filming = filmingId !== null;
  const busyUploading = upload.kind === "sending";
  const over =
    talk === null ||
    (!filming && !busyUploading && talk !== undefined && (!talk.connected || talk.state === "ended"));
  const meter = meterColors(dark, meterIsGreen(reading, thresholdDb));

  if (over) {
    return (
      <Centered colors={colors} insets={insets}>
        <Text style={[styles.message, { color: colors.fg, fontFamily: fonts.medium }]}>
          {talk && !talk.connected ? TALK_COPY.disconnected(name) : TALK_COPY.finished(name)}
        </Text>
        <PresentationButton label={TALK_COPY.done} onPress={onDone} colors={colors} />
      </Centered>
    );
  }
  if (refused) {
    return (
      <Centered colors={colors} insets={insets}>
        <Text style={[styles.message, { color: colors.fg, fontFamily: fonts.medium }]}>
          {TALK_COPY.needsCamera}
        </Text>
        <PresentationButton label={TALK_COPY.stopWatching} onPress={stopWatching} colors={colors} />
      </Centered>
    );
  }

  return (
    <View style={[styles.watching, { backgroundColor: "#000" }]}>
      <StatusBar style="light" />
      <Stack.Screen options={{ headerShown: false }} />
      {allowed ? (
        // Whole screen while aiming, a corner while filming: same element, so the take carries on.
        <View
          style={filming ? pipStyle(layout, width, insets.top + PIP_TOP) : StyleSheet.absoluteFill}
          pointerEvents={filming && layout === "voice" ? "none" : "auto"}
        >
          <FacingRoomCamera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            poseFrameMs={LIVE_POSE_MS}
            videoBitrate={VIDEO_BITRATE}
            onReady={() => setCameraReady(true)}
            onMountError={(message) => {
              console.warn("[audience] camera failed", message);
              setCameraFailed(true);
            }}
            onHeadPose={onHeadPose}
          />
        </View>
      ) : null}
      {filming ? (
        <SplitMeter
          layout={layout}
          face={{ head, zone, onZoneChange, pipTop: insets.top + PIP_TOP }}
          reading={reading}
          thresholdDb={thresholdDb}
          onThresholdChange={onThresholdChange}
        >
          <Text style={[styles.cueName, { color: meter.ink, fontFamily: fonts.medium }]}>
            ● {TALK_COPY.recordingName(name)}
          </Text>
        </SplitMeter>
      ) : (
        <View
          style={[
            styles.waitingCard,
            {
              backgroundColor: colors.bg,
              marginTop: Math.max(insets.top, 20),
              marginLeft: Math.max(insets.left, 20),
            },
          ]}
        >
          <Text style={[styles.cardTitle, { color: colors.fg, fontFamily: fonts.semibold }]}>
            {TALK_COPY.aimCamera(name)}
          </Text>
          <Text style={[styles.cardBody, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
            {upload.kind === "sending"
              ? TALK_COPY.sending(name, upload.pct)
              : upload.kind === "sent"
                ? TALK_COPY.sent(name)
                : upload.kind === "failed"
                  ? TALK_COPY.sendFailed(name)
                  : TALK_COPY.waitingForStart(name)}
          </Text>
          <View style={styles.cardButtons}>
            <PresentationButton
              disabled={upload.kind === "sending"}
              label={TALK_COPY.stopWatching}
              onPress={stopWatching}
              colors={colors}
            />
          </View>
        </View>
      )}
    </View>
  );
}

function Centered({
  colors,
  insets,
  headerRight,
  children,
}: {
  colors: Colors;
  insets: { top: number; bottom: number };
  /** A control at the right of the header bar (all screens of this route share one header). */
  headerRight?: () => React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View
      style={[
        styles.centered,
        { backgroundColor: colors.bg, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
      ]}
    >
      <Stack.Screen
        options={{
          ...LIGHT_HEADER,
          title: TALK_COPY.audienceTitle,
          headerShown: true,
          headerRight,
          unstable_headerRightItems: undefined,
        }}
      />
      {children}
    </View>
  );
}

/**
 * How often the camera reads head direction for the live view: about 15 times
 * a second (a reading takes about 17 ms on an A16 BunnyPad). A take's own read,
 * after it ends, stays at FACING_FRAME_MS.
 */
const LIVE_POSE_MS = 66;

/** Which halves of the live screen show: both, the sound alone, or the face alone. */
type MeterLayout = "both" | "voice" | "face";
const LAYOUT_OPTIONS = (["both", "voice", "face"] as const).map((value) => ({
  value,
  label: TALK_COPY.meterLayouts[value],
}));

/** The live screen's header is dark like the screen under it: a white bar pulls the eye. */
const DARK_HEADER = {
  headerStyle: { backgroundColor: darkThemeColors.bg },
  headerTintColor: darkThemeColors.fg,
  headerTitleStyle: { color: darkThemeColors.fg },
  headerShadowVisible: false,
};
/** The route's other screens are ordinary pages: back to the app's own header. */
const LIGHT_HEADER = {
  headerStyle: undefined,
  headerTintColor: undefined,
  headerTitleStyle: undefined,
  headerShadowVisible: undefined,
  headerTitle: undefined,
};

/**
 * Where the camera's picture sits: centred at the top of the face half, or of
 * the whole screen with the face alone. With the sound alone it's hidden but
 * stays the same element, so a take carries on and head direction is still read.
 */
function pipStyle(layout: MeterLayout, width: number, top: number) {
  if (layout === "voice") return [styles.pip, styles.pipHidden, { top, left: 0 }];
  const span = layout === "face" ? width : width / 2;
  return [styles.pip, { top, left: (span - PIP_WIDTH) / 2, borderColor: FACE_COLORS.ink }];
}

/** The camera's picture at the top of the face half. */
const PIP_WIDTH = 320;
const PIP_HEIGHT = 180;
const PIP_TOP = 24;
const HEAD_PYRAMID_SIZE = 300;
const HALF_GAP = 16;
/** The angles line under the head drawing. */
const ANGLES_HEIGHT = 28;

/** The face half's steady colors: a neutral dark gray, as the sound half's when it can't hear. Green means heard. */
const FACE_COLORS = backRowColors(true).listening;

/**
 * Looked away this long, the face half's bands start. A presenter who has
 * looked away sees the back of the room only from the corner of their eye,
 * which notices flicker far sooner than a change of color; the second's wait
 * keeps a glance, or a reading at the zone's edge, from setting it off.
 */
const AWAY_AFTER_MS = 1000;

/** True once the presenter has been away for `AWAY_AFTER_MS`; false the moment they're back. */
function useAwayAWhile(away: boolean): boolean {
  const [since, setSince] = useState<"waiting" | "long" | null>(null);
  useEffect(() => {
    if (!away) return;
    const timer = setTimeout(() => setSince("long"), AWAY_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setSince(null);
    };
  }, [away]);
  return away && since === "long";
}

/** The presenter's head direction in the camera's latest reading. Feed the camera's `onHeadPose` to the returned callback. */
function useLiveHead(zone: FacingZone): [HeadNow | null, (pose: LiveHeadPose) => void] {
  const [latest, setLatest] = useState<HeadPoseFrame | undefined>(undefined);
  const onHeadPose = useCallback((pose: LiveHeadPose) => {
    setLatest(pose.face ? [pose.yaw, pose.pitch, pose.faceWidth] : null);
  }, []);
  return [latest === undefined ? null : headNow(latest, zone), onHeadPose];
}

/**
 * The live screen in two equal halves: the presenter's head on the left,
 * neutral gray, with bands sweeping the way to turn back once they've looked
 * away a second; and the sound at the back on the right, green while it's
 * heard. Their words share a line. With no camera the sound takes the whole
 * screen.
 *
 * The camera's picture sits at the top of the face half, but the caller draws
 * it, where it stays the same element while a take carries on; this leaves
 * room for it at `pipTop`. `children` go under the sound's word.
 */
function SplitMeter({
  layout,
  face,
  reading,
  thresholdDb,
  onThresholdChange,
  children,
}: {
  layout: MeterLayout;
  face: {
    head: HeadNow | null;
    zone: FacingZone;
    onZoneChange: (zone: FacingZone) => void;
    pipTop: number;
  } | null;
  reading: MeterReading;
  thresholdDb: number;
  onThresholdChange: (db: number) => void;
  children?: React.ReactNode;
}) {
  const dark = useColorScheme() === "dark";
  const sound = meterColors(dark, meterIsGreen(reading, thresholdDb));
  const head = face?.head ?? null;
  const awayAWhile = useAwayAWhile(head !== null && head.kind !== "facing");
  if (!face || layout === "voice") {
    return (
      <View style={[StyleSheet.absoluteFill, styles.soundAlone, { backgroundColor: sound.fill }]}>
        <View accessibilityLiveRegion="polite" style={styles.meterWords}>
          <Text style={[styles.cueWord, { color: sound.ink, fontFamily: fonts.semibold }]}>{sound.word}</Text>
          {children}
        </View>
        <Thermometer reading={reading} ink={sound.ink} thresholdDb={thresholdDb} onThresholdChange={onThresholdChange} />
      </View>
    );
  }
  // Both halves' words start on this line.
  const pyramidTop = face.pipTop + PIP_HEIGHT + HALF_GAP;
  const wordTop = pyramidTop + HEAD_PYRAMID_SIZE + ANGLES_HEIGHT + HALF_GAP;
  const faceOnly = layout === "face";
  return (
    <View style={[StyleSheet.absoluteFill, styles.split]}>
      <View style={[styles.faceHalf, faceOnly && styles.faceWhole, { backgroundColor: FACE_COLORS.fill }]}>
        <AwayNudge
          active={awayAWhile}
          baseColor={FACE_COLORS.fill}
          toward={head ? nudgeToward(head, face.zone) : null}
        />
        <View pointerEvents="box-none" style={[styles.pyramidRow, { top: pyramidTop }]}>
          <HeadPyramid
            head={head}
            zone={face.zone}
            onZoneChange={face.onZoneChange}
            ink={FACE_COLORS.ink}
            size={HEAD_PYRAMID_SIZE}
          />
          {/* How far from the zone's centre, right under the drawing it describes. */}
          <Text style={[styles.faceAngles, { color: FACE_COLORS.ink, fontFamily: fonts.regular }]}>
            {head && head.kind !== "none" ? TALK_COPY.headAngles(head.turnDeg, head.chinDeg) : " "}
          </Text>
        </View>
        <View style={[styles.halfWords, { paddingTop: wordTop }]} pointerEvents="none">
          <Text
            numberOfLines={2}
            adjustsFontSizeToFit
            style={[styles.halfWord, { color: FACE_COLORS.ink, fontFamily: fonts.semibold }]}
          >
            {TALK_COPY.headWord[head ? head.kind : "none"]}
          </Text>
          {faceOnly ? children : null}
        </View>
      </View>
      {faceOnly ? null : (
      <View style={[styles.soundHalf, { backgroundColor: sound.fill }]}>
        <View accessibilityLiveRegion="polite" style={[styles.halfWords, { paddingTop: wordTop }]}>
          <Text
            numberOfLines={2}
            adjustsFontSizeToFit
            style={[styles.halfWord, { color: sound.ink, fontFamily: fonts.semibold }]}
          >
            {sound.word}
          </Text>
          {children}
        </View>
        <Thermometer reading={reading} ink={sound.ink} thresholdDb={thresholdDb} onThresholdChange={onThresholdChange} />
      </View>
      )}
    </View>
  );
}

/** Records until the camera is told to stop; the file, or null if it failed. */
async function recordVideo(camera: FacingRoomCameraHandle): Promise<string | null> {
  try {
    const result = await camera.record();
    return result.uri;
  } catch (error) {
    console.warn("[audience] the camera stopped with an error", error);
    return null;
  }
}

/** Joins a talk; returns why it was refused, or null when it worked. */
async function joinTalk(join: () => Promise<unknown>): Promise<string | null> {
  try {
    await join();
    return null;
  } catch (error) {
    return error instanceof ConvexError &&
      typeof (error.data as { message?: unknown })?.message === "string"
      ? (error.data as { message: string }).message
      : "This BunnyPad couldn't connect. Please try again.";
  }
}

/**
 * Sends one take's video to the presenter, retrying a failed upload a few
 * times. "closed" means nobody will take it any more (the presenter
 * disconnected this BunnyPad, or the take was closed), so it isn't retried.
 */
async function uploadTake({
  uri,
  film,
  timing,
  facing,
  zone,
  thresholdDb,
  generateUploadUrl,
  finishUpload,
  onProgress,
}: {
  uri: string;
  film: Filming;
  timing: { durationMs: number; startDelayMs: number };
  /** Head direction on the video's clock, null without it. */
  facing: Promise<HeadPoseTrack | null>;
  /** Where the meter counted facing the room, so the presenter's review judges the trace the same way. */
  zone: FacingZone;
  /** The meter's green threshold, so the presenter's review judges the loudness the same way. */
  thresholdDb: number;
  generateUploadUrl: (args: { recordingId: Id<"talkRecordings"> }) => Promise<string>;
  finishUpload: (args: {
    recordingId: Id<"talkRecordings">;
    storageId: Id<"_storage">;
    mimeType: string;
    sizeBytes: number;
    durationMs: number;
    levels: string;
    frameMs: number;
    roomDbfs: number;
    thresholdDb: number;
    cameraStartedAtClient: number;
    facing?: string;
    facingFrameMs?: number;
    facingZone?: FacingZone;
  }) => Promise<unknown>;
  onProgress: (pct: number) => void;
}): Promise<"sent" | "closed" | "failed"> {
  const levels = film.levels.slice(Math.round(timing.startDelayMs / METER_FRAME_MS));
  const info = await FileSystem.getInfoAsync(uri);
  const sizeBytes = info.exists ? info.size : 0;
  const mimeType = uri.toLowerCase().endsWith(".mp4") ? "video/mp4" : "video/quicktime";
  let attempt = 0;
  while (attempt <= UPLOAD_RETRY_MS.length) {
    const result = await uploadOnce();
    if (result !== "retry") return result;
    if (attempt === UPLOAD_RETRY_MS.length) break;
    await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_MS[attempt]));
    attempt += 1;
  }
  return "failed";

  async function uploadOnce(): Promise<"sent" | "closed" | "retry"> {
    try {
      const uploadUrl = await generateUploadUrl({ recordingId: film.recordingId });
      const task = FileSystem.createUploadTask(
        uploadUrl,
        uri,
        {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { "Content-Type": mimeType },
        },
        ({ totalBytesSent, totalBytesExpectedToSend }) => {
          if (totalBytesExpectedToSend > 0) {
            onProgress(Math.min(99, Math.round((totalBytesSent / totalBytesExpectedToSend) * 100)));
          }
        },
      );
      const response = await task.uploadAsync();
      if (!response || response.status < 200 || response.status >= 300) {
        console.warn("[audience] upload answered", response?.status);
        return "retry";
      }
      const { storageId } = JSON.parse(response.body) as { storageId: Id<"_storage"> };
      const pose = await facing;
      const trace = pose ? encodeFacing(pose.frames) : null;
      await finishUpload({
        recordingId: film.recordingId,
        storageId,
        mimeType,
        sizeBytes,
        durationMs: timing.durationMs,
        levels: encodeLevels(levels),
        frameMs: METER_FRAME_MS,
        roomDbfs: film.roomDbfs,
        thresholdDb,
        cameraStartedAtClient: film.startedAt + timing.startDelayMs,
        // An overlong trace would sink the whole take: send the video without it.
        ...(pose && trace !== null && trace.length <= FACING_UPLOAD_MAX_CHARS
          ? { facing: trace, facingFrameMs: pose.frameMs, facingZone: zone }
          : {}),
      });
      return "sent";
    } catch (error) {
      if (errorKind(error) === "closed") return "closed";
      console.warn("[audience] sending the video failed", error);
      return "retry";
    }
  }
}

/** The length of a recorded video, read by opening it; null if it won't open in a few seconds. */
async function videoDurationMs(uri: string): Promise<number | null> {
  const player = createVideoPlayer({ uri });
  try {
    const seconds = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        subscription.remove();
        resolve(null);
      }, 4000);
      const subscription = player.addListener("statusChange", ({ status }) => {
        if (status !== "readyToPlay" && status !== "error") return;
        clearTimeout(timer);
        subscription.remove();
        resolve(status === "readyToPlay" ? player.duration : null);
      });
    });
    return seconds && seconds > 0 ? seconds * 1000 : null;
  } finally {
    player.release();
  }
}

/** A ConvexError's `kind` (liveTalks.ts refusals), if it is one. */
function errorKind(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const kind = (error.data as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : null;
}

// The camera writes into the app's cache, where deleting is allowed; a file
// that won't go is left for iOS to reclaim.
async function deleteQuietly(uri: string) {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn("[audience] could not delete a sent video", error);
  }
}

const styles = StyleSheet.create({
  pickPage: { padding: 32, gap: 16, maxWidth: 760, width: "100%", alignSelf: "center" },
  pickHeading: { fontSize: 28 },
  empty: { fontSize: 18, lineHeight: 25, paddingVertical: 24 },
  list: { borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 16 },
  rowText: { flex: 1, gap: 2 },
  rowName: { fontSize: 20 },
  rowDetail: { fontSize: 16 },
  disabled: { opacity: 0.5 },
  watching: { flex: 1 },
  cue: { alignItems: "center", justifyContent: "center", gap: 24, padding: 32 },
  cueWord: { fontSize: 96, textAlign: "center" },
  cueName: { fontSize: 24 },
  pip: {
    position: "absolute",
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: 12,
    borderWidth: 2,
    overflow: "hidden",
    zIndex: 2,
  },
  split: { flexDirection: "row" },
  faceHalf: { width: "50%", alignItems: "center", overflow: "hidden" },
  faceWhole: { width: "100%" },
  pipHidden: { opacity: 0 },
  soundHalf: { width: "50%", flexDirection: "row", alignItems: "center", paddingHorizontal: 32, gap: 24 },
  soundAlone: { flexDirection: "row", alignItems: "center", paddingHorizontal: 40, gap: 32 },
  halfWords: { flex: 1, alignSelf: "stretch", alignItems: "center", gap: 8, minWidth: 0, paddingHorizontal: 24 },
  halfWord: { fontSize: 52, textAlign: "center" },
  faceAngles: { fontSize: 20, lineHeight: ANGLES_HEIGHT, marginTop: -8, fontVariant: ["tabular-nums"] },
  // The app builder's header spacing (VibecodeScreen styles.headerRight).
  headerButtons: { flexDirection: "row", alignItems: "center", gap: 10 },
  pyramidRow: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  waitingCard: { position: "absolute", maxWidth: 520, borderRadius: 14, padding: 20, gap: 10 },
  cardTitle: { fontSize: 22 },
  cardBody: { fontSize: 17, lineHeight: 24 },
  cardButtons: { flexDirection: "row", gap: 12, marginTop: 6 },
  aloneClock: { fontSize: 64, fontVariant: ["tabular-nums"] },
  meterWords: { flex: 1, alignItems: "center", gap: 24 },
  meterColumn: { gap: 12, alignItems: "center" },
  meterUnit: { fontSize: 15 },
  meterScale: { width: 190, height: SCALE_HEIGHT },
  meterTick: { position: "absolute", left: 0, width: 62, height: METER_ROW, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 },
  meterTickMark: { width: 8, height: 1 },
  meterLabel: { fontSize: 14 },
  meterTrack: { position: "absolute", left: 66, top: 0, width: 40, height: SCALE_HEIGHT, borderRadius: 6, opacity: 0.18 },
  meterFill: { position: "absolute", left: 66, width: 40, bottom: 0, borderRadius: 6, opacity: 0.6 },
  meterRoom: { position: "absolute", left: 66, height: METER_ROW, flexDirection: "row", alignItems: "center", gap: 6 },
  meterRoomLine: { width: 40, borderTopWidth: 2, borderStyle: "dashed" },
  meterDecay: { position: "absolute", left: 62, width: 48, height: 4, borderRadius: 2 },
  meterThreshold: { position: "absolute", left: 108, height: 44, paddingVertical: 11, flexDirection: "row", alignItems: "center", gap: 6 },
  meterThresholdLabel: { fontSize: 15 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20, paddingHorizontal: 40 },
  message: { fontSize: 22, textAlign: "center", maxWidth: 640 },
});
