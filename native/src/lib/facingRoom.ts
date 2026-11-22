/**
 * When a presenter turned away from the room, or looked down or up, from the
 * head direction the back BunnyPad read off its video (modules/facing-room).
 *
 * Head direction only, never eye contact: from the back of a room a
 * presenter's eye is a few pixels across. And only stretches of a couple of
 * seconds or more: shorter glances are normal while presenting, and in the
 * first real take (2026-11-18) the numbers couldn't tell a one-second glance
 * up or down from an ordinary look across the room.
 *
 * Uncalibrated (T6): the edges below come from that one adult take, which
 * never showed the two habits this is for (reading the slides off the TV,
 * reading from a BunnyPad in hand). They need a staged take and a scholar
 * presenting before they're trusted.
 */
import type { HeadPoseFrame } from "../../modules/facing-room";
import { formatClock, LISTEN_LEAD_MS, runAt, type Observation, type SlideRun } from "./rehearsalTake";

/**
 * The longest trace a linked take sends; longer and the take goes without it
 * rather than fail. The server refuses the same length (FACING_MAX_CHARS in
 * convex/liveTalks.ts); the longest video it takes is far shorter.
 */
export const FACING_UPLOAD_MAX_CHARS = 200_000;

/** Four readings a second: a 2 s look away is 8 of them, and a minute is a few seconds of work. */
export const FACING_FRAME_MS = 250;
/**
 * Where the head points while it faces the room: a pyramid from the
 * presenter's head, centred on (`centerYaw`, `centerPitch`) and reaching
 * `turnDeg` to either side and `tiltDeg` up or down. Past a side is turned
 * away; below or above is looking down or up. Degrees, yaw + toward the
 * presenter's left, pitch + chin down, as the camera sees them.
 *
 * It's centred on the back BunnyPad itself, which sits among the audience:
 * facing it is facing the room. An earlier version centred it on the
 * presenter's usual heading instead, and that counted whatever they did most
 * as facing the room, reading slides off the TV included. The meter's pyramid
 * moves and resizes it while it's open, for a BunnyPad set off to one side.
 */
export type FacingZone = { centerYaw: number; centerPitch: number; turnDeg: number; tiltDeg: number };
export const DEFAULT_FACING_ZONE: FacingZone = { centerYaw: 0, centerPitch: 0, turnDeg: 30, tiltDeg: 15 };
/** Only looks away at least this long are marked. */
export const MIN_AWAY_MS = 2_000;
/** Facing the room for less than this between two looks away makes them one. */
export const JOIN_GAP_MS = 500;
/** With a face in fewer frames than this, the back BunnyPad didn't see the presenter well enough to say. */
export const MIN_SEEN_SHARE = 0.4;

export type LookAway = {
  /** On the clock the frames were read on until `shiftFacing`; then the take's. */
  fromMs: number;
  toMs: number;
  /** "turned" includes no face at all: turned to the screen behind, or out of the picture. */
  kind: "turned" | "down" | "up";
};

export type FacingRead = { kind: "seen"; away: LookAway[] } | { kind: "unseen" };

/** "12,-4,56;;-3,2,55" — whole degrees and pixels, an empty entry where no face was found. */
export function encodeFacing(frames: readonly HeadPoseFrame[]): string {
  return frames
    .map((frame) => (frame ? frame.map((value) => Math.round(value)).join(",") : ""))
    .join(";");
}

export function decodeFacing(encoded: string): HeadPoseFrame[] {
  if (encoded === "") return [];
  return encoded.split(";").map((entry) => {
    const parts = entry.split(",").map(Number);
    return parts.length === 3 && parts.every(Number.isFinite)
      ? [parts[0], parts[1], parts[2]]
      : null;
  });
}

/** The stretches where the presenter's head left the facing zone: turned away, or looked down or up. */
export function readFacing(
  frames: readonly HeadPoseFrame[],
  frameMs: number,
  zone: FacingZone = DEFAULT_FACING_ZONE,
): FacingRead {
  const faces = frames.filter((frame): frame is [number, number, number] => frame !== null);
  if (frames.length === 0 || faces.length / frames.length < MIN_SEEN_SHARE) {
    return { kind: "unseen" };
  }

  // Runs of frames away from the room, then join the ones a short look back splits.
  const runs: { from: number; to: number; counts: Record<LookAway["kind"], number> }[] = [];
  frames.forEach((frame, i) => {
    const kind = awayKind(frame, zone);
    if (!kind) return;
    const last = runs[runs.length - 1];
    if (last && (i - last.to) * frameMs <= JOIN_GAP_MS) {
      last.to = i + 1;
    } else {
      runs.push({ from: i, to: i + 1, counts: { turned: 0, down: 0, up: 0 } });
    }
    runs[runs.length - 1].counts[kind] += 1;
  });

  const away = runs
    .filter((run) => (run.to - run.from) * frameMs >= MIN_AWAY_MS)
    .map(
      (run): LookAway => ({
        fromMs: run.from * frameMs,
        toMs: run.to * frameMs,
        kind: mostOf(run.counts),
      }),
    );
  return { kind: "seen", away };
}

/** How one frame is away from the room, or null while it faces the room. No face counts as turned. */
function awayKind(frame: HeadPoseFrame, zone: FacingZone): LookAway["kind"] | null {
  if (!frame) return "turned";
  if (Math.abs(frame[0] - zone.centerYaw) > zone.turnDeg) return "turned";
  if (frame[1] - zone.centerPitch > zone.tiltDeg) return "down";
  if (zone.centerPitch - frame[1] > zone.tiltDeg) return "up";
  return null;
}

/** The kind most frames of a stretch had; turned wins a tie, then down. */
function mostOf(counts: Record<LookAway["kind"], number>): LookAway["kind"] {
  const kinds: LookAway["kind"][] = ["turned", "down", "up"];
  return kinds.reduce((best, kind) => (counts[kind] > counts[best] ? kind : best));
}

/**
 * No face in view, or the face in view: its pose as the camera sees it, and
 * how far it points from the zone's centre in whole degrees (chin + is down).
 */
export type HeadNow =
  | { kind: "none" }
  | { kind: "facing" | LookAway["kind"]; yaw: number; pitch: number; turnDeg: number; chinDeg: number };

/**
 * The head direction in one live reading, judged as `readFacing` judges a
 * frame but with no 2-second rule: this is what the camera sees right now.
 */
export function headNow(frame: HeadPoseFrame, zone: FacingZone = DEFAULT_FACING_ZONE): HeadNow {
  if (!frame) return { kind: "none" };
  return {
    kind: awayKind(frame, zone) ?? "facing",
    yaw: frame[0],
    pitch: frame[1],
    turnDeg: Math.round(Math.abs(frame[0] - zone.centerYaw)),
    chinDeg: Math.round(frame[1] - zone.centerPitch),
  };
}

/**
 * Which way the presenter should turn to face the room again, as they see the
 * back BunnyPad's screen: x + is right, y + is down, length 1. Only the part
 * past the zone's edge counts, so a turn that's too far left but level points
 * straight right. Null while facing the room, or with no face to go by.
 */
export function nudgeToward(head: HeadNow, zone: FacingZone): { x: number; y: number } | null {
  if (head.kind === "none" || head.kind === "facing") return null;
  // How far past the edge, signed; "+ 0" turns a -0 inside the edge into 0.
  const past = (offset: number, limit: number) => Math.sign(offset) * Math.max(0, Math.abs(offset) - limit) + 0;
  // Yaw + is toward the presenter's own left, which is the screen's left as
  // they face it, so the way back is to the right; pitch + is chin down.
  const x = past(head.yaw - zone.centerYaw, zone.turnDeg);
  const y = past(zone.centerPitch - head.pitch, zone.tiltDeg);
  const length = Math.hypot(x, y);
  return length === 0 ? null : { x: x / length, y: y / length };
}

/** Moves a read from the back video's clock onto the take's. */
export function shiftFacing(read: FacingRead, offsetMs: number): FacingRead {
  if (read.kind === "unseen") return read;
  return {
    kind: "seen",
    away: read.away.map((a) => ({ ...a, fromMs: a.fromMs + offsetMs, toMs: a.toMs + offsetMs })),
  };
}

/**
 * The review's sentence about facing the room, with a link to the longest
 * look away. Null when the back BunnyPad sent no head direction (a build
 * without the module, or reading it failed): then the review says nothing.
 */
export function observeFacing(read: FacingRead | null, runs: readonly SlideRun[]): Observation | null {
  if (!read) return null;
  if (read.kind === "unseen") {
    return {
      text: "The BunnyPad at the back couldn't see your face well enough to say when you faced the room.",
    };
  }
  const { away } = read;
  if (away.length === 0) {
    return { text: "From the back of the room, you never turned away or looked down or up for long." };
  }
  const did = (["turned", "down", "up"] as const)
    .filter((kind) => away.some((a) => a.kind === kind))
    .map((kind) => LOOK_AWAY_WORDS[kind]);
  const what = did.length === 1 ? did[0] : `${did.slice(0, -1).join(", ")} or ${did[did.length - 1]}`;
  const longest = away.reduce((a, b) => (b.toMs - b.fromMs > a.toMs - a.fromMs ? b : a));
  const seconds = Math.round((longest.toMs - longest.fromMs) / 1000);
  const run = runAt(runs, longest.fromMs);
  const where = run ? `on slide ${run.index + 1}` : `at ${formatClock(longest.fromMs)}`;
  const text =
    away.length === 1
      ? `You ${what} once, for ${seconds} seconds ${where}.`
      : `You ${what} ${away.length} times for ${MIN_AWAY_MS / 1000} seconds or more. The longest was ${seconds} seconds, ${where}.`;
  return {
    text,
    listen: { slideIndex: run ? run.index : null, atMs: Math.max(0, longest.fromMs - LISTEN_LEAD_MS) },
  };
}

const LOOK_AWAY_WORDS: Record<LookAway["kind"], string> = {
  turned: "turned away from the room",
  down: "looked down",
  up: "looked up",
};
