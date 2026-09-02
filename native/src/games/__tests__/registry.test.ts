/**
 * Games registry conformance — the CI gate that makes a broken game a RED BUILD
 * instead of a bricked classroom.
 *
 * Shaped after `src/components/manipulatives/__tests__/nativeManipulativeKinds.test.ts`,
 * which gets total routing coverage while importing not a single renderer. Same
 * trick here: this file only ever calls `loadGameModule()`, the framework-free
 * half. `react-native` never enters the test process, so the gate runs in plain
 * Node in CI and still proves that every registered module evaluates, matches
 * its catalog entry, and can only emit vocabulary the server knows how to read.
 *
 * The fleet build loads games LAZILY (blast-radius containment on kiosk iPads —
 * see the registry header). That laziness is only safe because this test is
 * eager: a module that throws at require time fails here, in CI, in front of the
 * person who broke it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  GAME_CATALOG,
  GAME_IDS,
  catalogEntryErrors,
  effectiveEvidencePlan,
  evidencePlanEntryError,
} from "../../../vendor/games/catalog";
import { HOST_EVENT_KEYS, isHostEventKey } from "../../../vendor/games/contract";
import {
  REGISTERED_GAME_IDS,
  eagerLoadFailureIsFatal,
  loadGameModule,
  shouldEagerLoadGames,
} from "../registry";

describe("game registry", () => {
  it("registers exactly the ids the catalog declares", () => {
    expect([...REGISTERED_GAME_IDS].sort()).toEqual([...GAME_IDS].sort());
  });

  it("has no duplicate registrations", () => {
    expect(new Set(REGISTERED_GAME_IDS).size).toBe(REGISTERED_GAME_IDS.length);
  });

  it("returns a typed failure for an unknown id instead of throwing", async () => {
    const loaded = await loadGameModule("no-such-game");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      // The scholar-facing half must never leak an id or a stack.
      expect(loaded.message).not.toContain("no-such-game");
      expect(loaded.detail).toContain("no-such-game");
    }
  });
});

/**
 * The boot-time eager check and its FATALITY are deliberately separate switches.
 *
 * `EXPO_PUBLIC_EAGER_LOAD_GAMES=1` is how the rhtest variant opts into finding a
 * broken game at boot — but rhtest is a RELEASE build, where an unhandled JS
 * exception is process death, not a dismissible RedBox, on a kiosk iPad in
 * Single App Mode with no app switcher and no USB recovery. Rethrowing there
 * would re-create, one file below the lazy registry, the exact event the lazy
 * registry exists to prevent. These tests pin that: opting into the check must
 * never be able to opt into terminating the app.
 */
describe("eager-load policy", () => {
  const realDev = (globalThis as { __DEV__?: unknown }).__DEV__;
  const realFlag = process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES;

  afterEach(() => {
    if (realDev === undefined) delete (globalThis as { __DEV__?: unknown }).__DEV__;
    else (globalThis as { __DEV__?: unknown }).__DEV__ = realDev;
    if (realFlag === undefined) delete process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES;
    else process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES = realFlag;
  });

  it("checks but never kills a release build that opted in (rhtest)", () => {
    (globalThis as { __DEV__?: unknown }).__DEV__ = false;
    process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES = "1";
    expect(shouldEagerLoadGames()).toBe(true);
    expect(eagerLoadFailureIsFatal()).toBe(false);
  });

  it("leaves a fleet build lazy and non-fatal", () => {
    (globalThis as { __DEV__?: unknown }).__DEV__ = false;
    delete process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES;
    expect(shouldEagerLoadGames()).toBe(false);
    expect(eagerLoadFailureIsFatal()).toBe(false);
  });

  it("is fatal only in dev, where RedBox is dismissible", () => {
    (globalThis as { __DEV__?: unknown }).__DEV__ = true;
    delete process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES;
    expect(shouldEagerLoadGames()).toBe(true);
    expect(eagerLoadFailureIsFatal()).toBe(true);
  });
});

describe("catalog", () => {
  it.each(GAME_IDS)("%s is a well-formed catalog entry", (gameId) => {
    expect(catalogEntryErrors(GAME_CATALOG[gameId])).toEqual([]);
  });

  it.each(GAME_IDS)("%s is iPad-only (D-5 is policy, not a hint)", (gameId) => {
    expect(GAME_CATALOG[gameId].platform).toBe("ipad");
  });
});

describe.each(GAME_IDS)("%s module", (gameId) => {
  let loaded: Awaited<ReturnType<typeof loadGameModule>>;

  beforeAll(async () => {
    loaded = await loadGameModule(gameId);
  });

  it("loads cleanly in plain Node", () => {
    if (!loaded.ok) throw new Error(`${gameId} failed to load: ${loaded.detail}`);
    expect(loaded.module).toBeTruthy();
  });

  it("has a manifest that agrees with its catalog entry", () => {
    if (!loaded.ok) throw new Error(loaded.detail);
    const entry = GAME_CATALOG[gameId];
    expect(loaded.module.manifest.gameId).toBe(gameId);
    expect(loaded.module.manifest.version).toBe(entry.version);
    expect(loaded.module.manifest.version).toBeGreaterThan(0);
  });

  it("can only emit vocabulary the server plan interprets", () => {
    if (!loaded.ok) throw new Error(loaded.detail);
    const plan = effectiveEvidencePlan(gameId);
    for (const key of loaded.module.manifest.eventKeys) {
      expect(plan[key], `eventKey "${key}" has no evidence plan entry`).toBeTruthy();
    }
    // Every plan entry is well-formed — no forbidden scoring field sneaks in.
    for (const [key, entry] of Object.entries(plan)) {
      expect(evidencePlanEntryError(entry), `plan entry "${key}"`).toBeNull();
    }
  });

  it("cannot declare, redefine or suppress a host event key", () => {
    if (!loaded.ok) throw new Error(loaded.detail);
    const plan = effectiveEvidencePlan(gameId);
    for (const hostKey of Object.values(HOST_EVENT_KEYS)) {
      // The host emits these on the game's behalf...
      expect(plan[hostKey], `host key "${hostKey}" missing from the effective plan`).toBeTruthy();
      // ...and the game neither declares them nor can shadow them.
      expect(loaded.module.manifest.eventKeys).not.toContain(hostKey);
    }
    for (const key of loaded.module.manifest.eventKeys) {
      expect(isHostEventKey(key), `game claimed reserved key "${key}"`).toBe(false);
    }
  });

  it("accepts its own default config and rejects garbage", () => {
    if (!loaded.ok) throw new Error(loaded.detail);
    const entry = GAME_CATALOG[gameId];
    expect(() => loaded.module.config.parse(entry.defaultConfig)).not.toThrow();
    // Studio is the one module where an empty object is meaningful authored
    // config: omitted levelIds means the full ladder. Every other game must
    // continue rejecting it rather than silently inventing required settings.
    const junk = [
      null,
      undefined,
      7,
      "nope",
      [],
      ...(gameId === "studio" ? [] : [{}]),
    ];
    for (const value of junk) {
      expect(
        () => loaded.module.config.parse(value),
        `config.parse should reject ${JSON.stringify(value) ?? "undefined"}`,
      ).toThrow();
    }
  });

  it("creates deterministic state for a fixed seed", () => {
    if (!loaded.ok) throw new Error(loaded.detail);
    const config = loaded.module.config.parse(GAME_CATALOG[gameId].defaultConfig);
    const a = loaded.module.state.create({ config, seed: "fixed-seed-42" });
    const b = loaded.module.state.create({ config, seed: "fixed-seed-42" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("creates state that survives a JSON round trip", () => {
    // Not for resume — nothing is ever loaded back. But the final snapshot is
    // stored as JSON, and a state carrying a Map, a Set or an undefined would
    // silently record something other than what the scholar saw.
    if (!loaded.ok) throw new Error(loaded.detail);
    const config = loaded.module.config.parse(GAME_CATALOG[gameId].defaultConfig);
    const created = loaded.module.state.create({ config, seed: "round-trip" });
    expect(JSON.parse(JSON.stringify(created))).toEqual(created);
  });

  it("exposes no state.parse — a round is never resumed", () => {
    // The absence is the contract. A game that grows a `parse` is a game
    // someone is about to try to resume, and resume is the thing this host
    // deliberately does not do.
    if (!loaded.ok) throw new Error(loaded.detail);
    expect(
      (loaded.module.state as { parse?: unknown }).parse,
      "state.parse must not exist: sessions start fresh, never resume",
    ).toBeUndefined();
  });
});
