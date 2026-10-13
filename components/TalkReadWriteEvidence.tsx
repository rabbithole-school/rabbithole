"use client";

/**
 * The evidence under each level on the scholar profile's "Talk, read and
 * write" card, and the one growth chart beneath them (TRA-515). Teacher-only.
 *
 * One line of evidence per level, each shown only when it means something:
 *   Talk  — the tutor's reply grade against the setting, new words they've used.
 *   Read  — the week's read-aloud tally (beginners only).
 *   Write — spoken share of the last 2 weeks, plus the typed-writing estimate.
 *
 * The chart is the single rendering of growth for all three: one lane each on
 * a real date axis of Honolulu school weeks, with ◆ where a level was changed.
 * The old "Scholar writing over time" chart lives on as the Write lane (typed
 * grade line + scan rings, with spoken share behind); the talk-only history
 * sparkline became the ◆s.
 *
 * The Talk lane shows the observer's judgment of the scholar's language with NO
 * grade numbers, on a fixed K–8 scale (T6): it is not yet calibrated against
 * teachers (evals/spot-eval/talk-judgment-FINDINGS.md). TRA-521 restores the
 * numbers and the "Sessions suggest · Use / Keep" line once it is.
 */

import { useState } from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import {
  gradeValue,
  readAloudText,
  spokenShareText,
  tallyReadAloud,
  tutorRepliesText,
  WEEK_MS,
  type ReadAloudAttemptRow,
} from "@/convex/lib/levelEvidence";
import { formatRelative } from "@/lib/relativeTime";
import { EmptyState } from "@/components/ui/EmptyState";

// ── Shapes (mirroring the queries' returns) ──────────────────────────────

export interface LevelEvidenceData {
  windowStart: number;
  now: number;
  truncated: boolean;
  talk: { sessions: { at: number; level: string }[] };
  read: {
    recent: ReadAloudAttemptRow[];
    weeks: { start: number; words: number; matched: number; lines: number }[];
  };
  write: {
    spokenRecent: number;
    typedRecent: number;
    weeks: { start: number; spoken: number; typed: number; typedGrade: number | null }[];
  };
  markers: { dimension: "talk" | "read" | "write"; level: string; at: number; by: string | null }[];
}

export interface TutorReadability {
  meanGradeLevel: number | null;
  sampledResponseCount: number;
  windowDays: number;
  minWordsPerResponse: number;
}

export interface VocabularyWin {
  word: string;
  firstSeenAt: number;
  snippet: string;
  useCount: number;
}

export interface ScannedSample {
  id: string;
  caption: string | null;
  gradeLevel: number;
  wordCount: number;
  createdAt: number;
}

const lineProps = { fontSize: "xs", fontFamily: "body", color: "charcoal.500" } as const;

// ── Talk ─────────────────────────────────────────────────────────────────

export function TalkEvidence({
  talkLevel,
  tutorReadability,
  vocabularyWins,
}: {
  talkLevel: string | null;
  tutorReadability: TutorReadability | undefined;
  vocabularyWins: VocabularyWin[];
}) {
  const [wordsOpen, setWordsOpen] = useState(false);

  return (
    <VStack align="stretch" gap={1}>
      {tutorReadability && tutorReadability.meanGradeLevel !== null && (
        <Text
          {...lineProps}
          title={`Flesch–Kincaid grade, averaged over ${tutorReadability.sampledResponseCount} recent tutor replies from the last ${tutorReadability.windowDays} days (${tutorReadability.minWordsPerResponse}+ words each).`}
        >
          {tutorRepliesText(tutorReadability.meanGradeLevel, talkLevel)}
        </Text>
      )}
      {vocabularyWins.length > 0 && (
        <Box>
          <Text
            as="button"
            {...lineProps}
            textAlign="left"
            cursor="pointer"
            _hover={{ color: "navy.500" }}
            aria-expanded={wordsOpen}
            onClick={() => setWordsOpen((open) => !open)}
          >
            New words they&rsquo;ve used: {vocabularyWins.slice(0, 3).map((w) => w.word).join(", ")}
            {wordsOpen ? " ‹" : " ›"}
          </Text>
          {wordsOpen && (
            <VStack align="stretch" gap={1} mt={1} pl={2}>
              {vocabularyWins.map((win) => (
                <Box key={win.word}>
                  <HStack justify="space-between" align="baseline" gap={2}>
                    <Text fontSize="xs" fontFamily="heading" fontWeight="700" color="charcoal.600">
                      {win.word}
                    </Text>
                    <Text fontSize="2xs" color="charcoal.300" fontFamily="body" flexShrink={0}>
                      {formatRelative(win.firstSeenAt)}
                      {win.useCount > 1 ? ` · ${win.useCount} uses` : ""}
                    </Text>
                  </HStack>
                  {win.snippet && (
                    <Text fontSize="2xs" color="charcoal.400" fontFamily="body" lineClamp={1}>
                      “{win.snippet}”
                    </Text>
                  )}
                </Box>
              ))}
            </VStack>
          )}
        </Box>
      )}
    </VStack>
  );
}

// ── Read ─────────────────────────────────────────────────────────────────

export function ReadEvidence({ evidence }: { evidence: LevelEvidenceData | undefined }) {
  if (!evidence) return null;
  const text = readAloudText(tallyReadAloud(evidence.read.recent));
  if (!text) return null;
  return (
    <Text
      {...lineProps}
      title="Each your-turn line read aloud, checked word by word against speech-to-text. A full match means it sounded right; a miss is stronger evidence."
    >
      {text}
    </Text>
  );
}

// ── Write ────────────────────────────────────────────────────────────────

export function WriteEvidence({
  evidence,
  writingEstimate,
}: {
  evidence: LevelEvidenceData | undefined;
  writingEstimate: string;
}) {
  const share = evidence
    ? spokenShareText(evidence.write.spokenRecent, evidence.write.typedRecent)
    : null;
  const estimate = share
    ? writingEstimate.charAt(0).toLowerCase() + writingEstimate.slice(1)
    : writingEstimate;
  return <Text {...lineProps}>{share ? `${share} · ${estimate}` : estimate}</Text>;
}

// ── Growth over time ─────────────────────────────────────────────────────

// Drawn at about the card's width (the chart box caps at W px), so marks keep
// their size instead of scaling up with a wide card.
const W = 560;
const LANE_H = 40;
/** The Write lane carries two series (typed grade + spoken share), so it is taller. */
const WRITE_H = 56;
/** Spoken-share bars: pale, behind the typed line, a hue no other series uses. */
const SPOKEN_BAR = "#B6E3DF";
const PAD_X = 6;
const PAD_Y = 6;
/**
 * The Talk lane's fixed scale: K at the bottom, grade 8 at the top (above
 * clamps to the top). Fixed, so the lane never stretches a one-grade wobble
 * to full height (T10).
 */
const TALK_SCALE_MAX = 8;

const DIMENSION_LABEL = { talk: "Talk", read: "Read", write: "Write" } as const;

function levelName(dimension: "talk" | "read" | "write", level: string): string {
  if (dimension === "talk") {
    return level === "K" ? "K" : level === "college" ? "college" : `grade ${level}`;
  }
  if (level === "voice") return "by voice";
  if (level === "own") return "on their own";
  return level;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "Pacific/Honolulu",
  });
}

/** Points joined only across consecutive weeks, so a gap reads as a gap. */
function weekSegments(points: { start: number; x: number; y: number }[]) {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    if (i > 0 && p.start - points[i - 1].start > WEEK_MS) {
      segments.push(current);
      current = [];
    }
    current.push({ x: p.x, y: p.y });
  });
  if (current.length) segments.push(current);
  return segments.filter((s) => s.length > 1);
}

function Lane({
  caption,
  children,
  label,
  height = LANE_H,
}: {
  caption: string;
  label: string;
  children: React.ReactNode;
  height?: number;
}) {
  return (
    <Box>
      <HStack gap={2} align="baseline">
        <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="charcoal.600" w="40px" flexShrink={0}>
          {label}
        </Text>
        <Text fontSize="2xs" fontFamily="body" color="charcoal.400" lineClamp={1}>
          {caption}
        </Text>
      </HStack>
      <svg width="100%" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`${label}: ${caption}`} style={{ display: "block" }}>
        <line x1={PAD_X} x2={W - PAD_X} y1={height - PAD_Y} y2={height - PAD_Y} stroke="#CBD2D9" strokeWidth="1" />
        {children}
      </svg>
    </Box>
  );
}

function Diamond({ x, y, title }: { x: number; y: number; title: string }) {
  const r = 4;
  return (
    <polygon
      points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`}
      fill="#52606D"
      stroke="white"
      strokeWidth="1"
    >
      <title>{title}</title>
    </polygon>
  );
}

function GrowthSection({ children }: { children: React.ReactNode }) {
  return (
    <Box mt={3} pt={3} borderTop="1px solid" borderColor="gray.100">
      <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="navy.500" mb={2}>
        Growth over time
      </Text>
      {children}
    </Box>
  );
}

export function LevelsGrowthChart({
  evidence,
  scans,
}: {
  evidence: LevelEvidenceData;
  scans: ScannedSample[];
}) {
  const { windowStart, now } = evidence;
  // `now` is minute-rounded, so a change made this minute can sit just past
  // it: clamp onto the right edge rather than off the chart.
  const toX = (t: number) =>
    PAD_X + ((Math.min(t, now) - windowStart) / (now - windowStart)) * (W - PAD_X * 2);
  const weekX = (start: number) => toX(Math.min(start + WEEK_MS / 2, now));
  const yFrac = (f: number, h = LANE_H) => h - PAD_Y - f * (h - PAD_Y * 2);
  const inWindow = (t: number) => t >= windowStart;

  // Talk: one dot per judged session, oldest first, on the fixed K–8 scale.
  const talk = [...evidence.talk.sessions]
    .reverse()
    .map((s) => ({ at: s.at, value: gradeValue(s.level) }))
    .filter((s): s is { at: number; value: number } => s.value !== null);
  const talkY = (v: number) => yFrac(Math.min(v, TALK_SCALE_MAX) / TALK_SCALE_MAX);

  const readWeeks = evidence.read.weeks.filter((w) => w.words > 0);
  const writeWeeks = evidence.write.weeks.filter((w) => w.spoken + w.typed > 0);
  const typed = evidence.write.weeks.filter(
    (w): w is typeof w & { typedGrade: number } => w.typedGrade !== null,
  );
  const scansInWindow = scans.filter((s) => inWindow(s.createdAt));

  const markersFor = (dimension: "talk" | "read" | "write") =>
    evidence.markers
      .filter((m) => m.dimension === dimension && inWindow(m.at))
      .map((m) => (
        <Diamond
          key={`${m.dimension}-${m.at}`}
          x={toX(m.at)}
          y={PAD_Y}
          title={`${DIMENSION_LABEL[dimension]}: ${levelName(dimension, m.level)}${m.by ? ` · set by ${m.by}` : ""} · ${shortDate(m.at)}`}
        />
      ));

  const nothing =
    talk.length === 0 &&
    readWeeks.length === 0 &&
    writeWeeks.length === 0 &&
    scansInWindow.length === 0 &&
    evidence.markers.length === 0;
  if (nothing) {
    return (
      <GrowthSection>
        <EmptyState
          title="No growth to show yet"
          hint="Judged sessions, read-alouds, spoken and typed turns, and level changes from the last 13 school weeks appear here."
        />
      </GrowthSection>
    );
  }

  // No grade numbers for Talk until it is calibrated (TRA-521).
  const talkCaption =
    talk.length === 0
      ? "language in sessions — none judged yet"
      : "language in sessions — rough, not yet checked against teachers";

  const readAcc = readWeeks.map((w) => w.matched / w.words);
  const readCaption =
    readWeeks.length === 0
      ? "no read-aloud in this window"
      : readWeeks.length === 1
        ? `read-aloud accuracy: ${pct(readAcc[0])}`
        : `read-aloud accuracy: ${pct(readAcc[0])} → ${pct(readAcc[readAcc.length - 1])}`;

  // Write lane: the typed-writing grade is the line (the old "Scholar writing
  // over time" chart, T10), scans are amber rings on the same grade scale, and
  // the weekly spoken share sits behind as pale bars on its own 0–100% scale.
  const shares = writeWeeks.map((w) => w.spoken / (w.spoken + w.typed));
  const writeGrades = [...typed.map((w) => w.typedGrade), ...scansInWindow.map((s) => s.gradeLevel)];
  const gMin = Math.min(...writeGrades);
  const gMax = Math.max(...writeGrades);
  const writeY = (g: number) => yFrac(gMax === gMin ? 0.5 : (g - gMin) / (gMax - gMin), WRITE_H);
  const barW = ((W - PAD_X * 2) * WEEK_MS) / (now - windowStart) - 2;
  const writeCaption = [
    typed.length === 0
      ? "typed writing: none in this window"
      : typed.length === 1
        ? `typed writing: grade ${typed[0].typedGrade.toFixed(1)}`
        : `typed writing: grade ${typed[0].typedGrade.toFixed(1)} → ${typed[typed.length - 1].typedGrade.toFixed(1)}`,
    writeWeeks.length === 0
      ? null
      : writeWeeks.length === 1
        ? `bars: spoken share ${pct(shares[0])}`
        : `bars: spoken share ${pct(shares[0])} → ${pct(shares[shares.length - 1])}`,
    scansInWindow.length > 0 ? "○ scanned writing" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Month ticks on the real date axis (Honolulu calendar).
  const ticks: { t: number; label: string }[] = [];
  const d = new Date(windowStart);
  d.setUTCDate(1);
  d.setUTCHours(10, 0, 0, 0); // midnight in Honolulu
  d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() <= now) {
    ticks.push({ t: d.getTime(), label: d.toLocaleDateString("en-US", { month: "short", timeZone: "Pacific/Honolulu" }) });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }

  const lineColor = "#7A3D8A";

  return (
    <GrowthSection>
    <VStack align="stretch" gap={1.5} maxW={`${W}px`}>
      <Lane label="Talk" caption={talkCaption}>
        {talk.length > 1 && (
          <polyline
            points={talk.map((s) => `${toX(s.at)},${talkY(s.value)}`).join(" ")}
            fill="none"
            stroke={lineColor}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}
        {talk.map((s) => (
          <circle key={s.at} cx={toX(s.at)} cy={talkY(s.value)} r="2.5" fill={lineColor}>
            <title>{`Session judged ${shortDate(s.at)}`}</title>
          </circle>
        ))}
        {markersFor("talk")}
      </Lane>

      <Lane label="Read" caption={readCaption}>
        {weekSegments(readWeeks.map((w, i) => ({ start: w.start, x: weekX(w.start), y: yFrac(readAcc[i]) }))).map((seg, i) => (
          <polyline key={i} points={seg.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={lineColor} strokeWidth="1.5" />
        ))}
        {readWeeks.map((w, i) => (
          <circle key={w.start} cx={weekX(w.start)} cy={yFrac(readAcc[i])} r="2.5" fill={lineColor}>
            <title>{`Week of ${shortDate(w.start)} · ${pct(readAcc[i])} of words right · ${w.lines} ${w.lines === 1 ? "line" : "lines"}`}</title>
          </circle>
        ))}
        {markersFor("read")}
      </Lane>

      <Lane label="Write" caption={writeCaption} height={WRITE_H}>
        {writeWeeks.map((w, i) => {
          const h = shares[i] * (WRITE_H - PAD_Y * 2);
          return (
            <rect
              key={w.start}
              x={toX(w.start) + 1}
              y={WRITE_H - PAD_Y - h}
              width={Math.max(1, Math.min(barW, toX(now) - toX(w.start) - 1))}
              height={h}
              fill={SPOKEN_BAR}
            >
              <title>{`Week of ${shortDate(w.start)} · ${pct(shares[i])} spoken · ${w.spoken + w.typed} turns`}</title>
            </rect>
          );
        })}
        {weekSegments(typed.map((w) => ({ start: w.start, x: weekX(w.start), y: writeY(w.typedGrade) }))).map((seg, i) => (
          <polyline key={i} points={seg.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinejoin="round" />
        ))}
        {typed.map((w) => (
          <circle key={w.start} cx={weekX(w.start)} cy={writeY(w.typedGrade)} r="2.5" fill={lineColor}>
            <title>{`Week of ${shortDate(w.start)} · typed writing grade ${w.typedGrade.toFixed(1)}`}</title>
          </circle>
        ))}
        {/* Scanned writing: a separate source on the same grade scale, drawn
            as open amber rings and never joined into the typed line. */}
        {scansInWindow.map((s) => (
          <circle key={s.id} cx={toX(s.createdAt)} cy={writeY(s.gradeLevel)} r="3" fill="white" stroke="#D97706" strokeWidth="1.5">
            <title>{`${s.caption || "Scanned writing"} · grade ${s.gradeLevel.toFixed(1)} · ${s.wordCount} words`}</title>
          </circle>
        ))}
        {markersFor("write")}
      </Lane>

      {/* Month ticks as HTML at the same x fraction, so their type stays
          the app's size however wide the lanes draw. */}
      <Box position="relative" h="14px" aria-hidden="true">
        {ticks.map((tick) => (
          <Text
            key={tick.t}
            position="absolute"
            left={`${(toX(tick.t) / W) * 100}%`}
            transform="translateX(-50%)"
            fontSize="2xs"
            fontFamily="body"
            color="charcoal.400"
          >
            {tick.label}
          </Text>
        ))}
      </Box>
      <Text fontSize="2xs" fontFamily="body" color="charcoal.400">
        ◆ a level was changed (hover for who and when)
        {evidence.truncated
          ? ` · from ${shortDate(windowStart)} only: this scholar has more sessions than one view reads`
          : ""}
      </Text>
    </VStack>
    </GrowthSection>
  );
}
