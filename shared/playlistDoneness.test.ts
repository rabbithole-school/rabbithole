import { describe, expect, it } from "vitest";
import {
  derivePlaylistDoneness,
  hasActionablePlaylist,
  playlistCompleteEyebrow,
  playlistMastheadDateline,
  type PlaylistDonenessInput,
} from "./playlistDoneness";

const nextUpStub = { key: "k", label: "K", reason: "next" as const };

/** A minimal set row — only `doneToday` is read by the verdict. */
const row = (doneToday: boolean) => ({ doneToday });

describe("derivePlaylistDoneness", () => {
  it("is NOT caught up while the set still has undone skills", () => {
    const input: PlaylistDonenessInput = {
      set: [row(true), row(false), row(false)],
      nextUp: nextUpStub,
      firstPostPlacementBlock: false,
    };
    expect(derivePlaylistDoneness(input)).toEqual({ allDone: false, caughtUp: false, blocked: false });
  });

  it("is caught up when every skill in the set is done today", () => {
    const input: PlaylistDonenessInput = {
      set: [row(true), row(true)],
      // nextUp can still point at a done skill; allDone carries the verdict.
      nextUp: nextUpStub,
      firstPostPlacementBlock: false,
    };
    expect(derivePlaylistDoneness(input)).toEqual({ allDone: true, caughtUp: true, blocked: false });
  });

  it("an empty set is never allDone, and caught up only via a null nextUp", () => {
    expect(
      derivePlaylistDoneness({ set: [], nextUp: null, firstPostPlacementBlock: false }),
    ).toEqual({ allDone: false, caughtUp: true, blocked: false });
    expect(
      derivePlaylistDoneness({ set: [], nextUp: nextUpStub, firstPostPlacementBlock: false }),
    ).toEqual({ allDone: false, caughtUp: false, blocked: false });
  });

  it("nextUp === null means caught up even with undone rows (nothing left to serve)", () => {
    const input: PlaylistDonenessInput = {
      set: [row(false)],
      nextUp: null,
      firstPostPlacementBlock: false,
    };
    expect(derivePlaylistDoneness(input)).toEqual({ allDone: false, caughtUp: true, blocked: false });
  });

  it("blocked is the OTHER escape hatch — a plan boundary is never caught up", () => {
    // The server hands back a scope-blocked playlist shaped exactly like a
    // finished day (empty set, no next up). Without the flag that reads as
    // "caught up" and the scholar gets a green check for a boundary someone
    // else drew.
    expect(
      derivePlaylistDoneness({
        set: [],
        nextUp: null,
        firstPostPlacementBlock: false,
        blocked: true,
      }),
    ).toEqual({ allDone: false, caughtUp: false, blocked: true });
    // …and it stays a boundary even with an all-done set behind it.
    expect(
      derivePlaylistDoneness({
        set: [row(true)],
        nextUp: null,
        firstPostPlacementBlock: false,
        blocked: true,
      }),
    ).toEqual({ allDone: true, caughtUp: false, blocked: true });
  });

  it("an absent or false blocked flag changes nothing", () => {
    const base = { set: [row(false)], nextUp: nextUpStub, firstPostPlacementBlock: false };
    expect(derivePlaylistDoneness({ ...base, blocked: false })).toEqual(
      derivePlaylistDoneness(base),
    );
  });

  it("firstPostPlacementBlock is the escape hatch — never caught up while calibrating", () => {
    // Even with nothing queued AND an all-done set, a first post-placement block
    // must not read as caught up.
    expect(
      derivePlaylistDoneness({ set: [row(true)], nextUp: null, firstPostPlacementBlock: true }),
    ).toEqual({ allDone: true, caughtUp: false, blocked: false });
    expect(
      derivePlaylistDoneness({ set: [], nextUp: null, firstPostPlacementBlock: true }),
    ).toEqual({ allDone: false, caughtUp: false, blocked: false });
  });
});

describe("playlistCompleteEyebrow", () => {
  it("names the honest stopping point when caught up", () => {
    expect(playlistCompleteEyebrow(true)).toBe("Playlist complete");
  });

  it("says a round wrapped while the playlist is still going", () => {
    expect(playlistCompleteEyebrow(false)).toBe("Round complete");
  });
});

describe("playlistMastheadDateline", () => {
  const base = {
    effectiveNeedsPlacement: false,
    practicedToday: false,
    setLength: 0,
    practicedCount: 0,
    goalMin: 20,
  };

  it("uses the goal-minute fallback before practice on both checkpoint mastheads", () => {
    expect(playlistMastheadDateline(base)).toBe("~20 min");
  });

  it("prefers practiced-today progress over the goal-minute fallback", () => {
    expect(
      playlistMastheadDateline({
        ...base,
        practicedToday: true,
        setLength: 4,
        practicedCount: 2,
      }),
    ).toBe("2 of 4 skills practiced today");
  });

  it("suppresses the dateline during placement and without a goal", () => {
    expect(
      playlistMastheadDateline({ ...base, effectiveNeedsPlacement: true }),
    ).toBeNull();
    expect(playlistMastheadDateline({ ...base, goalMin: null })).toBeNull();
  });
});

describe("hasActionablePlaylist", () => {
  it.each([undefined, null])(
    "keeps the home default state while the playlist is %s",
    (playlist) => {
      expect(hasActionablePlaylist(playlist)).toBe(false);
    },
  );

  it("demotes the hero only for a resolved playlist with work", () => {
    expect(
      hasActionablePlaylist({
        set: [row(false)],
        nextUp: nextUpStub,
        firstPostPlacementBlock: false,
      }),
    ).toBe(true);
  });

  it("keeps the hero first for a resolved playlist with nothing left to serve", () => {
    expect(
      hasActionablePlaylist({
        set: [row(true)],
        nextUp: null,
        firstPostPlacementBlock: false,
      }),
    ).toBe(false);
  });

  it("keeps the hero first when the plan blocks practice (a boundary is not work)", () => {
    // `caughtUp` is deliberately false while blocked, so this has to exclude
    // blocked explicitly or the hero would demote behind an unusable card.
    expect(
      hasActionablePlaylist({
        set: [],
        nextUp: null,
        firstPostPlacementBlock: false,
        blocked: true,
      }),
    ).toBe(false);
  });
});
