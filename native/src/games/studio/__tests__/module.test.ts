import { describe, expect, test } from "vitest";

import {
  MAX_EVENT_TEXT_LEN,
  gameEventInputError,
} from "../../../../vendor/games/contract";
import {
  STUDIO_RUN_TRACE_FRAME_LIMIT,
  type StudioRunResult,
  type StudioWorld,
} from "../../../../vendor/shared/studioContract";
import {
  buildWorld,
  levelById,
} from "../../../../vendor/shared/studioLevels";
import studioModule from "../module";
import {
  allocateStudioWorld,
  studioRunEvidence,
} from "../rules";

function serializeWorld(world: StudioWorld) {
  return {
    walls: [...world.walls].sort(),
    paint: [...world.paint.entries()].sort(),
    start: world.start,
    goal: world.goal,
    treasure: world.treasure,
    needCarry: world.needCarry,
    free: world.free,
  };
}

function run(overrides: Partial<StudioRunResult> = {}): StudioRunResult {
  return {
    levelId: "maze",
    status: "win",
    steps: 42,
    seed: "studio:0123456789abcdef",
    assisted: false,
    trace: {
      frames: Array.from({ length: STUDIO_RUN_TRACE_FRAME_LIMIT }, (_, i) => ({
        line: i + 1,
        x: i % 9,
        y: Math.floor(i / 9),
        note: "move",
      })),
      totalFrames: 400,
      truncated: true,
    },
    message: "Solved.",
    ...overrides,
  };
}

describe("studio config codec", () => {
  test("absent or empty levelIds means every authored level", () => {
    const fromAbsent = studioModule.config.parse({});
    const fromEmpty = studioModule.config.parse({ levelIds: [] });
    expect(fromAbsent.levelIds).toHaveLength(11);
    expect(fromEmpty).toEqual(fromAbsent);
  });

  test("keeps a valid authored subset in authored order", () => {
    expect(studioModule.config.parse({ levelIds: ["maze", "go"] })).toEqual({
      levelIds: ["maze", "go"],
    });
  });

  test("rejects unknown, duplicate, or malformed levelIds", () => {
    expect(() => studioModule.config.parse({ levelIds: ["not-a-level"] })).toThrow(
      /unknown level id/,
    );
    expect(() => studioModule.config.parse({ levelIds: ["go", "go"] })).toThrow(
      /duplicate/,
    );
    expect(() => studioModule.config.parse({ levelIds: "go" })).toThrow(/must be an array/);
  });
});

describe("studio seeded worlds", () => {
  test("the same launch seed, level, and attempt reproduce the same world", () => {
    const config = studioModule.config.parse({ levelIds: ["maze"] });
    const state = studioModule.state.create({ config, seed: "launch-a" });
    const first = allocateStudioWorld(state, "launch-a", "maze");
    const again = allocateStudioWorld(state, "launch-a", "maze");
    expect(first.seed).toBe(again.seed);
    expect(serializeWorld(buildWorld(levelById("maze")!, first.seed))).toEqual(
      serializeWorld(buildWorld(levelById("maze")!, again.seed)),
    );
  });

  test("a different attempt produces a different seed and world", () => {
    const config = studioModule.config.parse({ levelIds: ["maze"] });
    const state = studioModule.state.create({ config, seed: "launch-a" });
    const first = allocateStudioWorld(state, "launch-a", "maze");
    const second = allocateStudioWorld(first.state, "launch-a", "maze");
    expect(second.seed).not.toBe(first.seed);
    expect(serializeWorld(buildWorld(levelById("maze")!, second.seed))).not.toEqual(
      serializeWorld(buildWorld(levelById("maze")!, first.seed)),
    );
  });
});

describe("studio run evidence", () => {
  test("carries the requested run facts and survives the host validator", () => {
    const event = studioRunEvidence(run({ assisted: true }));
    expect(gameEventInputError(event)).toBeNull();
    expect(event.payload.kind).toBe("local_rule_result");
    if (event.payload.kind !== "local_rule_result") return;
    expect(event.payload.detail).toContain("level=maze");
    expect(event.payload.detail).toContain("status=solved");
    expect(event.payload.detail).toContain("steps=42");
    expect(event.payload.detail).toContain("seed=studio:0123456789abcdef");
    expect(event.payload.detail).toContain("assisted=true");
    expect(event.payload.detail).toContain("truncated=true");
    expect(event.payload.detail!.length).toBeLessThanOrEqual(MAX_EVENT_TEXT_LEN);
  });

  test("trims later trace frames to fit the event text cap", () => {
    const event = studioRunEvidence(
      run({
        levelId: "level-with-a-deliberately-long-but-valid-identifier",
        trace: {
          frames: Array.from({ length: STUDIO_RUN_TRACE_FRAME_LIMIT }, (_, i) => ({
            line: i + 1,
            x: i % 9,
            y: Math.floor(i / 9),
            note: `move-${String(i).padStart(26, "x")}`,
          })),
          totalFrames: STUDIO_RUN_TRACE_FRAME_LIMIT,
          truncated: false,
        },
      }),
    );
    expect(gameEventInputError(event)).toBeNull();
    if (event.payload.kind !== "local_rule_result") return;
    expect(event.payload.detail).toContain("trace=move-");
    expect(event.payload.detail).not.toContain("move-xxxxxxxxxxxxxxxxxxxxxxxx23");
    expect(event.payload.detail).toContain("truncated=true");
    expect(event.payload.detail!.length).toBeLessThanOrEqual(MAX_EVENT_TEXT_LEN);
  });

  test("falls back to base metadata with no trace instead of throwing", () => {
    const event = studioRunEvidence(
      run({
        levelId: "level-".repeat(120),
        seed: "seed-".repeat(120),
        trace: {
          frames: [{ line: 1, x: 0, y: 0, note: "move" }],
          totalFrames: 1,
          truncated: false,
        },
      }),
    );
    expect(gameEventInputError(event)).toBeNull();
    if (event.payload.kind !== "local_rule_result") return;
    expect(event.payload.detail).toContain("trace=none");
    expect(event.payload.detail).toContain("truncated=true");
    expect(event.payload.detail!.length).toBeLessThanOrEqual(MAX_EVENT_TEXT_LEN);
  });
});
