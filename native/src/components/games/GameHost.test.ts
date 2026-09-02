import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { passthrough, pendingMutation } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
  pendingMutation: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: passthrough,
  Alert: { alert: vi.fn() },
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: vi.fn() }),
  },
  Modal: passthrough,
  Pressable: passthrough,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: passthrough,
  View: passthrough,
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: passthrough,
  SafeAreaView: passthrough,
}));

vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("convex/react", () => ({ useConvex: () => ({ mutation: pendingMutation }) }));
vi.mock("@/lib/convex", () => ({
  api: {
    games: {
      abandon: "games.abandon",
      checkpoint: "games.checkpoint",
      reportCrash: "games.reportCrash",
      requestCompletion: "games.requestCompletion",
      start: "games.start",
    },
  },
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular" },
  useColors: () => ({
    bgSubtle: "#fff",
    border: "#ddd",
    charcoal: "#222",
    charcoalSubtle: "#666",
    navy: "#111",
  }),
}));
vi.mock("@/games/registry", () => ({ loadGame: vi.fn() }));
vi.mock("@/components/games/GameCoachSheet", () => ({ GameCoachSheet: () => null }));

import { GameHost } from "./GameHost";
import { closeGame, openGameActivity } from "@/lib/gameHost";

describe("GameHost", () => {
  afterEach(() => {
    act(() => closeGame());
    vi.clearAllMocks();
  });

  it("mounts a requested game without a render-time exception", () => {
    act(() => {
      openGameActivity({ activityId: "activity" as never, activityTitle: "Test game" });
    });

    expect(() => {
      act(() => {
        const renderer = create(createElement(GameHost));
        renderer.unmount();
      });
    }).not.toThrow();
  });
});
