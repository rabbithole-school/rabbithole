/**
 * How the app reads microphone loudness. Dictation, the bug-report recorder
 * and the presenting voice meter all poll expo-audio's metering at this rate
 * and map its dBFS reading onto 0..1 the same way, so a level means the same
 * thing on every surface.
 */

/** How often the metering hooks poll the recorder, in milliseconds. */
export const METER_FRAME_MS = 80;

/** expo-audio reports metering in dBFS: about -60 for a quiet room, 0 at full scale. */
export const SILENT_DBFS = -60;

/** Maps a metering reading (dBFS) onto 0..1; a missing reading counts as silence. */
export function levelFromDbfs(dbfs: number | undefined): number {
  const db = dbfs ?? SILENT_DBFS;
  return Math.max(0, Math.min(1, (db - SILENT_DBFS) / -SILENT_DBFS));
}
