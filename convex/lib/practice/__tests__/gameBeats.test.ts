import { describe, expect, it } from "vitest";

import {
  GAME_BEAT_COOLDOWN_MS,
  GAME_BEAT_REOFFER_CAP,
  bindingMatchesItem,
  gameBeatKey,
  gameBeatOfferId,
  isGameBeatSuppressed,
  selectRunGameBeat,
  type GameBindingLike,
  type GameOfferLike,
  type RunItemLike,
} from "../gameBeats";

const NOW = 1_700_000_000_000;
const DAY = "2026-07-26";
const ACTIVITY = "act_factor";

function binding(over: Partial<GameBindingLike> = {}): GameBindingLike {
  return {
    activityId: ACTIVITY,
    domain: "math",
    strand: "number-theory",
    isActive: true,
    ...over,
  };
}

function item(over: Partial<RunItemLike> = {}): RunItemLike {
  return {
    skillKey: "identify-factors",
    domain: "math",
    strand: "number-theory",
    lane: "new",
    ...over,
  };
}

function select(over: Partial<Parameters<typeof selectRunGameBeat>[0]> = {}) {
  return selectRunGameBeat({
    items: [item()],
    bindings: [binding()],
    offerByKey: new Map<string, GameOfferLike>(),
    lastPlayedByActivity: new Map<string, number>(),
    dayBucket: DAY,
    now: NOW,
    ...over,
  });
}

describe("gameBeatKey / gameBeatOfferId", () => {
  it("is stable and namespaced per activity", () => {
    expect(gameBeatKey(ACTIVITY)).toBe("game:act_factor");
    expect(gameBeatOfferId("u1", gameBeatKey(ACTIVITY))).toBe("u1:game:act_factor");
  });
});

describe("bindingMatchesItem", () => {
  it("matches on domain + strand", () => {
    expect(bindingMatchesItem(binding(), item())).toBe(true);
  });

  it("rejects a different domain or strand", () => {
    expect(bindingMatchesItem(binding({ domain: "ela" }), item())).toBe(false);
    expect(bindingMatchesItem(binding({ strand: "decimals" }), item())).toBe(false);
  });

  it("rejects an item with no strand at all", () => {
    expect(bindingMatchesItem(binding(), item({ strand: undefined }))).toBe(false);
  });

  it("narrows to skillKeys when the binding names them", () => {
    const narrow = binding({ skillKeys: ["identify-primes"] });
    expect(bindingMatchesItem(narrow, item({ skillKey: "identify-primes" }))).toBe(true);
    expect(bindingMatchesItem(narrow, item({ skillKey: "identify-factors" }))).toBe(false);
  });

  it("treats an empty skillKeys array as 'whole strand', not 'nothing'", () => {
    expect(bindingMatchesItem(binding({ skillKeys: [] }), item())).toBe(true);
  });

  it("honours isActive: false", () => {
    expect(bindingMatchesItem(binding({ isActive: false }), item())).toBe(false);
  });
});

describe("isGameBeatSuppressed", () => {
  it("does not suppress a game never offered and never played", () => {
    expect(isGameBeatSuppressed({ now: NOW })).toBe(false);
  });

  it("suppresses inside the cooldown after a real play", () => {
    expect(
      isGameBeatSuppressed({ lastPlayedAt: NOW - GAME_BEAT_COOLDOWN_MS + 1000, now: NOW }),
    ).toBe(true);
  });

  it("releases once the cooldown has elapsed — a game rests, it does not retire", () => {
    expect(
      isGameBeatSuppressed({ lastPlayedAt: NOW - GAME_BEAT_COOLDOWN_MS - 1, now: NOW }),
    ).toBe(false);
  });

  it("suppresses only when the cap is reached AND the scholar actually declined", () => {
    const key = gameBeatKey(ACTIVITY);
    const atCapNoDecline: GameOfferLike = { key, offerCount: GAME_BEAT_REOFFER_CAP };
    const atCapDeclined: GameOfferLike = {
      key,
      offerCount: GAME_BEAT_REOFFER_CAP,
      declinedAt: NOW - 1000,
    };
    expect(isGameBeatSuppressed({ offer: atCapNoDecline, now: NOW })).toBe(false);
    expect(isGameBeatSuppressed({ offer: atCapDeclined, now: NOW })).toBe(true);
  });

  it("does not suppress a single decline below the cap", () => {
    const offer: GameOfferLike = {
      key: gameBeatKey(ACTIVITY),
      offerCount: 1,
      declinedAt: NOW - 1000,
    };
    expect(isGameBeatSuppressed({ offer, now: NOW })).toBe(false);
  });
});

describe("selectRunGameBeat", () => {
  it("offers a bound game in front of the item whose strand it covers", () => {
    const chosen = select();
    expect(chosen).not.toBeNull();
    expect(chosen?.at).toBe(0);
    expect(chosen?.key).toBe(gameBeatKey(ACTIVITY));
  });

  it("returns null with no bindings at all", () => {
    expect(select({ bindings: [] })).toBeNull();
  });

  it("positions the beat on the FIRST covered item, never on an uncovered one", () => {
    const chosen = select({
      items: [
        item({ strand: "decimals", skillKey: "round-decimals" }),
        item({ strand: "decimals", skillKey: "compare-decimals" }),
        item(),
      ],
    });
    // Position correctness is the whole point of selecting from served items:
    // the strand the beat names is by construction items[at]'s strand.
    expect(chosen?.at).toBe(2);
  });

  it("skips lanes a beat must not interrupt (mapping, challenge, stretch)", () => {
    for (const lane of ["mapping", "challenge", "stretch"]) {
      expect(select({ items: [item({ lane })] })).toBeNull();
    }
    expect(select({ items: [item({ lane: "review" })] })?.at).toBe(0);
  });

  it("skips an item with no lane", () => {
    expect(select({ items: [item({ lane: undefined })] })).toBeNull();
  });

  it("skips a suppressed game and keeps scanning for another binding", () => {
    const other = "act_other";
    const chosen = select({
      items: [item(), item({ strand: "decimals", skillKey: "round-decimals" })],
      bindings: [binding(), binding({ activityId: other, strand: "decimals" })],
      lastPlayedByActivity: new Map([[ACTIVITY, NOW - 1000]]),
    });
    expect(chosen?.at).toBe(1);
    expect(chosen?.key).toBe(gameBeatKey(other));
  });

  it("returns null when every candidate is suppressed", () => {
    expect(select({ lastPlayedByActivity: new Map([[ACTIVITY, NOW - 1000]]) })).toBeNull();
  });

  it("withholds when a DIFFERENT game was already offered today", () => {
    const offerByKey = new Map<string, GameOfferLike>([
      ["game:act_other", { key: "game:act_other", lastOfferedDayBucket: DAY }],
    ]);
    expect(select({ offerByKey })).toBeNull();
  });

  it("still offers when the other game's impression was on a PREVIOUS day", () => {
    const offerByKey = new Map<string, GameOfferLike>([
      ["game:act_other", { key: "game:act_other", lastOfferedDayBucket: "2026-07-25" }],
    ]);
    expect(select({ offerByKey })?.at).toBe(0);
  });

  it("does NOT retract itself once its own doorway has claimed today's impression", () => {
    // The regression this guards: the card claims its impression on mount, so a
    // blanket "anything offered today" governor would flip true the moment it
    // rendered and yank the doorway off-screen mid-decision.
    const key = gameBeatKey(ACTIVITY);
    const offerByKey = new Map<string, GameOfferLike>([
      [key, { key, offerCount: 1, lastOfferedDayBucket: DAY }],
    ]);
    expect(select({ offerByKey })?.key).toBe(key);
  });

  it("returns null for an empty run", () => {
    expect(select({ items: [] })).toBeNull();
  });
});
