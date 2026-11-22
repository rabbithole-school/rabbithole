/**
 * Latency marks for the native voice-first loop. The vocabulary and compact
 * summary format intentionally match lib/voicePerf.ts so web and iPad
 * measurements are directly comparable.
 *
 * Silent by default. Set EXPO_PUBLIC_VOICE_DEBUG=1 before Metro bundles the app;
 * Expo inlines EXPO_PUBLIC_* values at bundle time. In dev builds, [voice-perf]
 * summaries are written to the Metro log (console.log — this dev client does not forward console.info).
 *
 * A cycle arms on micClosed/speechEnd and reports once at firstAudio. Marks
 * outside an armed cycle (for example, unrelated tap-to-hear audio) are ignored.
 */

type Mark =
  | "micClosed"
  | "speechEnd"
  | "transcript"
  | "sendMessage"
  | "firstText"
  | "firstAudio";

const ORDER: Mark[] = [
  "micClosed",
  "speechEnd",
  "transcript",
  "sendMessage",
  "firstText",
  "firstAudio",
];
const ARM_MARKS: ReadonlySet<Mark> = new Set(["micClosed", "speechEnd"]);

const times: Partial<Record<Mark, number>> = {};
let armed = false;

function enabled(): boolean {
  return process.env.EXPO_PUBLIC_VOICE_DEBUG === "1";
}

export function voiceMark(mark: Mark): void {
  if (!enabled()) return;
  const now = performance.now();
  if (ARM_MARKS.has(mark)) {
    for (const key of ORDER) delete times[key];
    times[mark] = now;
    armed = true;
    return;
  }
  if (!armed || times[mark] !== undefined) return;
  times[mark] = now;
  if (mark === "firstAudio") {
    armed = false;
    const hit = ORDER.filter((m) => times[m] !== undefined);
    const segments = hit.slice(1).map((m, i) => {
      const prev = hit[i];
      return `${prev}→${m} ${Math.round(times[m]! - times[prev]!)}ms`;
    });
    const total =
      hit.length >= 2
        ? `TOTAL ${hit[0]}→firstAudio ${Math.round(times.firstAudio! - times[hit[0]]!)}ms`
        : "TOTAL —";
    console.log(`[voice-perf] ${segments.join(" | ")} | ${total}`);
  }
}

/**
 * The front half of a take: how long from the mic opening (key down or tap) to
 * each startup milestone. Same flag as voiceMark. `micOpen` arms a take; it
 * reports once both `listening` and `sessionReady` have happened, in either
 * order, with every mark as an offset from the open:
 *
 *   [voice-start] secret +2ms | capture +180ms | listening +180ms | transport +640ms | sessionReady +700ms
 *
 * `listening` is when the UI first says so; `capture` is when audio first
 * reaches the hook, so the gap between the two is the kept-audio guarantee.
 */
type StartMark =
  | "micOpen"
  | "secret"
  | "capture"
  | "listening"
  | "transport"
  | "sessionReady";

let startAt: number | null = null;
const startMarks: Partial<Record<StartMark, number>> = {};

export function voiceStartMark(mark: StartMark): void {
  if (!enabled()) return;
  const now = performance.now();
  if (mark === "micOpen") {
    for (const key of Object.keys(startMarks)) {
      delete startMarks[key as StartMark];
    }
    startAt = now;
    return;
  }
  if (startAt === null || startMarks[mark] !== undefined) return;
  startMarks[mark] = now - startAt;
  if (
    startMarks.listening !== undefined &&
    startMarks.sessionReady !== undefined
  ) {
    const parts = (Object.entries(startMarks) as [StartMark, number][])
      .sort((a, b) => a[1] - b[1])
      .map(([name, offset]) => `${name} +${Math.round(offset)}ms`);
    startAt = null;
    console.log(`[voice-start] ${parts.join(" | ")}`);
  }
}
