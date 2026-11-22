import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for the BunnyPad's document directory.
const files = new Map<string, string>();
const DOCS = "file:///docs/";

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///docs/",
  getInfoAsync: async (uri: string) => ({
    exists: [...files.keys()].some((path) => path.startsWith(uri)),
  }),
  readDirectoryAsync: async (uri: string) =>
    [...files.keys()]
      .filter((path) => path.startsWith(uri))
      .map((path) => path.slice(uri.length)),
  readAsStringAsync: async (uri: string) => files.get(uri) ?? "",
  writeAsStringAsync: async (uri: string, contents: string) => {
    files.set(uri, contents);
  },
  makeDirectoryAsync: async () => {},
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    files.set(to, files.get(from) ?? "");
    files.delete(from);
  },
  deleteAsync: async (uri: string) => {
    files.delete(uri);
  },
}));

const { loadTakes, saveTake } = await import("./rehearsalStore");

async function rehearse(deckKey: string, n: number) {
  const recording = `file:///cache/recording-${n}.m4a`;
  files.set(recording, `audio ${n}`);
  return saveTake(
    deckKey,
    {
      version: 1,
      id: `take-${n}`,
      recordedAt: 1_000 * n,
      durationMs: 5_000,
      frameMs: 80,
      levels: [0.5, 0.6],
      slides: [{ atMs: 0, index: 0, slideId: "sl1" }],
    },
    recording,
  );
}

describe("rehearsal takes on the BunnyPad", () => {
  beforeEach(() => files.clear());

  it("keeps the newest three takes of a deck and deletes older ones, audio included", async () => {
    for (let n = 1; n <= 5; n++) await rehearse("deck-a", n);

    const kept = await loadTakes("deck-a");
    expect(kept.map((take) => take.id)).toEqual(["take-3", "take-4", "take-5"]);
    const stored = [...files.keys()].sort();
    expect(stored).toEqual(
      ["take-3", "take-4", "take-5"]
        .flatMap((id) => [`${DOCS}rehearsals/deck-a/${id}.json`, `${DOCS}rehearsals/deck-a/${id}.m4a`])
        .sort(),
    );
    expect(kept[2].audioUri).toBe(`${DOCS}rehearsals/deck-a/take-5.m4a`);
  });

  it("keeps each deck's takes apart", async () => {
    await rehearse("deck-a", 1);
    await rehearse("deck-b", 2);
    expect((await loadTakes("deck-a")).map((take) => take.id)).toEqual(["take-1"]);
    expect((await loadTakes("deck-b")).map((take) => take.id)).toEqual(["take-2"]);
  });

  it("has no takes for a deck never rehearsed", async () => {
    expect(await loadTakes("deck-new")).toEqual([]);
  });
});
