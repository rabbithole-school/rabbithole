import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const { announceForAccessibility, launchRun } = vi.hoisted(() => ({
  announceForAccessibility: vi.fn(),
  launchRun: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => launchRun,
}));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Success: "success" },
}));
vi.mock("expo-symbols", () => ({
  SymbolView: "SymbolView",
}));
vi.mock("@/components/Glass", () => ({
  GlassBar: ({ children }: { children: React.ReactNode }) =>
    createElement("GlassBar", null, children),
}));
vi.mock("@/components/AppTextInput", () => ({
  AppTextInput: "AppTextInput",
}));
vi.mock("@/lib/convex", () => ({
  api: {
    simulatorRuns: {
      launchRun: "simulatorRuns.launchRun",
      stopRun: "simulatorRuns.stopRun",
    },
  },
}));
vi.mock("@/theme", () => ({
  fonts: { medium: "medium", semibold: "semibold", regular: "regular" },
  useColors: () => ({
    border: "#d1d5db",
    fg: "#111827",
    fgMuted: "#6b7280",
    orange: "#c2410c",
    violet: "#7c3aed",
    violetMuted: "#c4b5fd",
    violetSolid: "#7c3aed",
    gray200: "#e5e7eb",
    white: "#ffffff",
  }),
}));
vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  const Pressable = ({
    children,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => react.createElement("Pressable", props as never, children);

  return {
    ActivityIndicator: passthrough,
    Alert: { alert: vi.fn() },
    AccessibilityInfo: {
      announceForAccessibility,
    },
    Pressable,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: passthrough,
    View: passthrough,
  };
});

import { RunTray } from "../RunTray";

const spec = {
  microWorld: true,
  tickBudget: { iterationTicks: 3, seasonTicks: 3 },
} as never;

function renderTray(hasCompletedRun: boolean, deckVersion = 1) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      createElement(RunTray, {
        sessionId: "session_1" as never,
        spec,
        deckDirty: false,
        deckVersion,
        hasCompletedRun,
        activeRun: null,
        onLaunched: vi.fn(),
      }),
    );
  });
  return tree;
}

describe("RunTray prediction accessibility", () => {
  it("launches a zero-run baseline directly without a prediction", async () => {
    launchRun.mockResolvedValue({ runId: "run_1" });
    const tree = renderTray(false);

    await act(async () => {
      tree.root.findByProps({ accessibilityLabel: "Start simulation" }).props.onPress();
    });

    expect(launchRun).toHaveBeenCalledWith({ sessionId: "session_1" });
  });

  it("announces and exposes selected/disabled states for a later-run prediction", () => {
    const tree = renderTray(true);

    act(() => {
      tree.root.findByProps({ accessibilityLabel: "Start simulation" }).props.onPress();
    });

    expect(announceForAccessibility).toHaveBeenCalledWith(
      "Prediction required. Choose what you expect this deck to do before running it.",
    );
    expect(tree.root.findByProps({ accessibilityLabel: "better" }).props.accessibilityState).toEqual({
      selected: false,
    });
    expect(
      tree.root.findByProps({ accessibilityLabel: "Start simulation" }).props
        .accessibilityState,
    ).toEqual({
      disabled: true,
    });

    act(() => {
      tree.root.findByProps({ accessibilityLabel: "better" }).props.onPress();
    });

    expect(tree.root.findByProps({ accessibilityLabel: "better" }).props.accessibilityState).toEqual({
      selected: true,
    });
    expect(
      tree.root.findByProps({ accessibilityLabel: "Start simulation" }).props
        .accessibilityState,
    ).toEqual({
      disabled: false,
    });
  });

});
