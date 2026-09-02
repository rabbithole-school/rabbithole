/**
 * The native game registry — the ONE place a game becomes reachable.
 *
 * ## Why the loaders are lazy
 *
 * Metro does not code-split a native production bundle, so a lazy loader saves
 * nothing at all in bytes. It is here for exactly one reason: **blast radius**.
 * These are kiosk iPads running in Single App Mode with
 * `allowHostPairing=false` — there is no app switcher, no Safari, no USB
 * recovery. A module-scope throw in one game's file, evaluated eagerly at
 * startup, would take down app launch for the whole fleet with no way in.
 * "The game is broken" and "the iPad is a brick" must never be the same event.
 *
 * ## Why `import()` and not `require()`
 *
 * The original sketch said `() => require("./game")`. On contact with the code
 * that turns out to defeat the OTHER half of the same requirement: a synchronous
 * `require()` of a TypeScript module cannot be executed by the Node-based CI
 * conformance test (Node's CJS loader has no TS), so the gate that is supposed
 * to catch a broken game before it reaches an iPad could never run. `import()`
 * is lazy in exactly the same way under Metro — the module body is not evaluated
 * until the loader is called — and it resolves in plain Node too. Laziness is
 * the requirement; `require` was only ever the mechanism.
 *
 * ## Why there are TWO loaders
 *
 * `loadModule()` is framework-free (manifest + codecs + rules); `loadScreen()`
 * pulls the React Native renderer. Splitting them is what lets the CI
 * conformance test `require()` every registered game in plain Node without
 * dragging in `react-native` — the same property that makes
 * `nativeManipulativeKinds.test.ts` able to give total routing coverage while
 * importing not a single renderer. It also makes "worklets may compute
 * presentation, never truth" structural: truth lives in a file a worklet-heavy
 * Screen cannot even be imported from.
 *
 * ## Fail fast where it's safe to fail
 *
 * Lazy in a fleet build; EAGER in dev and in the `rhtest` variant, where a
 * broken module should explode loudly at boot in front of the person who broke
 * it. CI is the real gate — see `__tests__/registry.test.ts`.
 */
import type { ComponentType } from "react";

import type { GameModule, GameScreenProps } from "../../vendor/games/contract";
import { GAME_IDS, type GameId } from "../../vendor/games/catalog";

type ModuleLoader = () => Promise<{ default: GameModule<never, never> }>;
type ScreenLoader = () => Promise<{ default: ComponentType<GameScreenProps<never, never>> }>;

interface RegistryEntry {
  loadModule: ModuleLoader;
  loadScreen: ScreenLoader;
}

/**
 * Build a registry entry. The generics are the point: `C`/`S` are inferred from
 * the MODULE and then checked against the SCREEN, so a game whose renderer
 * disagrees with its own state shape fails `tsc` at the registration site — the
 * one place both halves are visible at once.
 *
 * Past that check the pair is erased to `never`, because the host is deliberately
 * blind to a game's types: it moves opaque blobs between the module's codecs and
 * the server. This is the ONLY cast in the games platform, and it is why.
 */
function entry<C, S>(
  loadModule: () => Promise<{ default: GameModule<C, S> }>,
  loadScreen: () => Promise<{ default: ComponentType<GameScreenProps<C, S>> }>,
): RegistryEntry {
  return {
    loadModule: loadModule as unknown as ModuleLoader,
    loadScreen: loadScreen as unknown as ScreenLoader,
  };
}

const REGISTRY: Record<GameId, RegistryEntry> = {
  "toy-warmer-colder": entry(
    () => import("./toy-warmer-colder/module"),
    () => import("./toy-warmer-colder/Screen"),
  ),
  "factor-game": entry(
    () => import("./factor-game/module"),
    () => import("./factor-game/Screen"),
  ),
  studio: entry(
    () => import("./studio/module"),
    () => import("./studio/Screen"),
  ),
};

/** The ids the registry actually carries. Asserted == GAME_IDS in CI. */
export const REGISTERED_GAME_IDS = Object.keys(REGISTRY) as GameId[];

export type LoadedGame = {
  ok: true;
  gameId: GameId;
  module: GameModule<never, never>;
  Screen: ComponentType<GameScreenProps<never, never>>;
};

export type LoadGameFailure = {
  ok: false;
  gameId: string;
  /** Safe to show a scholar. Deliberately blames the game, not the scholar. */
  message: string;
  /** For the crash report. Never rendered. */
  detail: string;
};

const UNKNOWN_MESSAGE = "This game isn't in this version of the app yet.";
const BROKEN_MESSAGE = "This game didn't start. Tell your teacher.";

function failure(gameId: string, message: string, detail: string): LoadGameFailure {
  return { ok: false, gameId, message, detail };
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
}

/**
 * Load ONLY the framework-free half of a game. This is what the CI conformance
 * test calls: it proves every registered module requires cleanly, in plain Node,
 * without pulling `react-native` into the test process. `loadGame` below adds
 * the renderer for the host.
 */
export async function loadGameModule(
  gameId: string,
): Promise<{ ok: true; gameId: GameId; module: GameModule<never, never> } | LoadGameFailure> {
  const entry = (REGISTRY as Record<string, RegistryEntry | undefined>)[gameId];
  if (!entry) {
    return failure(
      gameId,
      UNKNOWN_MESSAGE,
      `unknown gameId "${gameId}"; registered: ${REGISTERED_GAME_IDS.join(", ")}`,
    );
  }
  try {
    const gameModule = (await entry.loadModule()).default;
    if (!gameModule) {
      return failure(gameId, BROKEN_MESSAGE, `game "${gameId}" has no module default export`);
    }
    return { ok: true, gameId: gameId as GameId, module: gameModule };
  } catch (err) {
    return failure(gameId, BROKEN_MESSAGE, describe(err));
  }
}

/**
 * Load a game by id — module AND renderer. Returns a typed failure instead of
 * throwing so the host can render "this game didn't start" chrome and report a
 * crash, rather than letting an exception escape into a screen that has no
 * error boundary above it. Every failure mode — unknown id, module throw,
 * missing default export — lands in the same shape.
 */
export async function loadGame(gameId: string): Promise<LoadedGame | LoadGameFailure> {
  const loaded = await loadGameModule(gameId);
  if (!loaded.ok) return loaded;
  const entry = REGISTRY[loaded.gameId];
  try {
    const Screen = (await entry.loadScreen()).default;
    if (!Screen) {
      return failure(gameId, BROKEN_MESSAGE, `game "${gameId}" has no Screen default export`);
    }
    return { ok: true, gameId: loaded.gameId, module: loaded.module, Screen };
  } catch (err) {
    return failure(gameId, BROKEN_MESSAGE, describe(err));
  }
}

/**
 * `__DEV__` is a Metro global, so it is probed rather than referenced — this
 * module is also loaded by the plain-Node conformance test, where it is absent.
 */
function isDevBuild(): boolean {
  return typeof __DEV__ === "boolean" ? __DEV__ : false;
}

/**
 * The dev-only tail on an eager-load failure.
 *
 * The FIRST real occurrence of this error was not a broken game. A Metro server
 * left running across a branch rebase served a drifted module graph — it had
 * already reported `Requiring unknown module "2631" … try restarting Metro` and
 * `Unable to resolve "./FactorGame.native"` (a renderer that commit had deleted)
 * — and this loader rendered the consequence as `unknown gameId "factor-game";
 * registered: toy-warmer-colder`, which reads exactly like a registration bug.
 * Metro's own diagnosis stayed in a terminal on the Mac and never reached the
 * iPad showing the red screen. Say it where the person reading it is.
 */
const STALE_METRO_HINT =
  "\n\nBefore believing this: if you just rebased or switched branches, restart " +
  "Metro with a cleared transform cache and reload. A long-lived dev server " +
  "serves a drifted module graph, and a game reached through a lazy import() is " +
  "the first thing to go stale.";

/**
 * Require every registered game NOW and throw on the first failure. Called at
 * app boot in dev and the rhtest variant only — a fleet build stays lazy, per
 * the blast-radius argument above. This exists so a broken module is discovered
 * by a developer or a tester, not by a classroom.
 */
export async function eagerLoadAllGames(): Promise<void> {
  const failures: string[] = [];
  for (const gameId of GAME_IDS) {
    const loaded = await loadGame(gameId);
    if (!loaded.ok) failures.push(`${gameId}: ${loaded.detail}`);
  }
  if (failures.length === 0) return;
  throw new Error(
    `[games] ${failures.length} registered game(s) failed to load:\n${failures.join("\n")}` +
      (isDevBuild() ? STALE_METRO_HINT : ""),
  );
}

/**
 * True in the builds where a broken game should be discovered at boot. `__DEV__`
 * covers a developer's Metro session; the env flag is how the rhtest variant
 * opts in without shipping the behavior to the fleet.
 */
export function shouldEagerLoadGames(): boolean {
  return isDevBuild() || process.env.EXPO_PUBLIC_EAGER_LOAD_GAMES === "1";
}

/**
 * May an eager-load failure be rethrown as an unhandled exception? DEV ONLY.
 *
 * `shouldEagerLoadGames()` is deliberately broader than this: the rhtest variant
 * opts INTO the boot-time check via `EXPO_PUBLIC_EAGER_LOAD_GAMES=1`, but rhtest
 * is a RELEASE build, where an unhandled JS exception is not a dismissible
 * RedBox — it is process death, on a kiosk iPad in Single App Mode with no app
 * switcher and no USB recovery. Rethrowing unconditionally would re-create, one
 * file below the registry, the exact event the lazy loaders exist to prevent:
 * "the game is broken" and "the iPad is a brick" as the same event. So the
 * *check* runs everywhere it is asked to; only the *fatality* is dev-only. In
 * rhtest the failure is logged, and a tester who opens that game gets the host's
 * "This game didn't start. Tell your teacher." chrome — which is the signal that
 * was always meant to reach them anyway.
 */
export function eagerLoadFailureIsFatal(): boolean {
  return isDevBuild();
}
