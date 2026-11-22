/**
 * Where slides rehearsals live: on this BunnyPad only, under the app's
 * document directory, one folder per deck. Each take is a JSON summary
 * (`RehearsalTake`) beside its audio file. Only the newest
 * `KEPT_TAKES_PER_DECK` takes of a deck are kept; saving a newer one deletes
 * the oldest, audio included. Nothing is uploaded and no teacher sees them.
 */

import * as FileSystem from "expo-file-system/legacy";

import {
  KEPT_TAKES_PER_DECK,
  parseTake,
  type RehearsalTake,
} from "@/lib/rehearsalTake";

/** A saved take and where its audio is, or null for a take without audio. */
export type StoredTake = RehearsalTake & { audioUri: string | null };

function deckFolder(deckKey: string): string {
  const root = FileSystem.documentDirectory;
  if (!root) throw new Error("This BunnyPad's app storage isn't available");
  return `${root}rehearsals/${deckKey.replace(/[^A-Za-z0-9_-]/g, "_")}/`;
}

/** The deck's kept takes, oldest first. */
export async function loadTakes(deckKey: string): Promise<StoredTake[]> {
  const folder = deckFolder(deckKey);
  const info = await FileSystem.getInfoAsync(folder);
  if (!info.exists) return [];
  const names = await FileSystem.readDirectoryAsync(folder);
  const takes: StoredTake[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const take = parseTake(
        JSON.parse(await FileSystem.readAsStringAsync(folder + name)) as unknown,
      );
      if (take) takes.push({ ...take, audioUri: folder + take.audioFile });
    } catch (error) {
      console.warn("[rehearsals] skipped an unreadable take", error);
    }
  }
  return takes.sort((a, b) => a.recordedAt - b.recordedAt);
}

/**
 * Saves a take: moves its recording into the deck's folder, writes the
 * summary beside it, then deletes takes beyond the newest few. Returns the
 * deck's kept takes, oldest first.
 */
export async function saveTake(
  deckKey: string,
  take: Omit<RehearsalTake, "audioFile">,
  recordingUri: string,
): Promise<StoredTake[]> {
  const folder = deckFolder(deckKey);
  await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
  const extension = recordingUri.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "m4a";
  const saved: RehearsalTake = { ...take, audioFile: `${take.id}.${extension}` };
  await FileSystem.moveAsync({ from: recordingUri, to: folder + saved.audioFile });
  await FileSystem.writeAsStringAsync(`${folder}${take.id}.json`, JSON.stringify(saved));

  const takes = await loadTakes(deckKey);
  const expired = takes.slice(0, Math.max(0, takes.length - KEPT_TAKES_PER_DECK));
  for (const old of expired) {
    // Audio first: if it won't delete, the summary stays and the next save
    // tries both again.
    await deleteQuietly(folder + old.audioFile);
    await deleteQuietly(`${folder}${old.id}.json`);
  }
  return takes.slice(expired.length);
}

// Takes live under the document directory, where expo-file-system may delete;
// a file that still won't go shouldn't fail the save of the new take.
async function deleteQuietly(uri: string) {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn("[rehearsals] could not delete an old take", error);
  }
}

/** Deletes a recording that won't become a take (too short to review). */
export async function discardRecording(uri: string): Promise<void> {
  await deleteQuietly(uri);
}
