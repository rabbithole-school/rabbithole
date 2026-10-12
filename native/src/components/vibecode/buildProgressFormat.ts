/**
 * The elapsed-clock format for the build-progress card/line (TRA-319), kept in a
 * pure, import-free module so it can be unit-tested in the node env (the
 * BuildProgress component pulls in react-native / expo-symbols) and so the card,
 * the chat line, and the overlay pill all read one m:ss vocabulary.
 *
 * Identical output to web's inline `useElapsedLabel` math: floor to whole
 * seconds, clamp negatives to 0, zero-pad the seconds.
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
