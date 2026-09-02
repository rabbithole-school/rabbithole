import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { SimulatorSpec } from "../../../vendor/simulator/contract";

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    Alert: { alert: vi.fn() },
    Pressable: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      react.createElement("pressable", props, children),
    ScrollView: react.forwardRef(
      ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }, ref) =>
        react.createElement("scroll-view", { ...props, ref }, children),
    ),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: passthrough,
    View: passthrough,
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => children ?? null },
  Easing: { out: () => ({}), cubic: {} },
  useAnimatedStyle: (style: () => unknown) => style(),
  useReducedMotion: () => false,
  useSharedValue: (initial: number) => ({
    get: () => initial,
    set: () => {},
  }),
  withTiming: (value: number) => value,
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("@/lib/convex", () => ({ api: { simulatorBenches: { saveDeck: "saveDeck" } } }));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", medium: "medium", regular: "regular", semibold: "semibold" },
  useColors: () => ({
    bg: "#fff",
    border: "#ddd",
    cyan: "#0cc",
    cyanSubtle: "#eff",
    fg: "#222",
    fgMuted: "#666",
    gray300: "#aaa",
    green: "#080",
    orange: "#f80",
    violet: "#7040c0",
    violetMuted: "#b9a0e8",
    violetSubtle: "#f2edff",
    white: "#fff",
  }),
}));
vi.mock("@/components/AppTextInput", () => ({
  AppTextInput: (props: Record<string, unknown>) => createElement("text-input", props),
}));
vi.mock("./Sheet", () => ({ Sheet: ({ children }: { children?: ReactNode }) => children ?? null }));
vi.mock("./SpeciesIcon", () => ({ SpeciesIconImage: () => null }));
vi.mock("./TournamentCard", () => ({ TournamentCard: () => null }));

import { PromptDeckSheet } from "./PromptDeckSheet";

const spec = {
  version: 1,
  templateVersion: 1,
  templateId: "ecosystemGrid",
  speciesSlots: [{
    slotId: "otters",
    label: "Otters",
    countMin: 1,
    countMax: 4,
    defaultCount: 2,
    senses: [],
  }],
  tickBudget: { iterationTicks: 10, seasonTicks: 10, absoluteMaxTicks: 20 },
  interpreter: { kind: "scripted", interpreterId: "compiled-policy-v1" },
  microWorld: false,
  config: {
    width: 4,
    height: 4,
    boundary: "bounded",
    initialResourceDensity: 0.5,
    resourceRegrowthPerTick: 0.1,
    corpseDecayTicks: 2,
    baseMetabolicCost: 1,
    reproductionEnergyThreshold: 5,
    maxAutomata: 4,
    environmentalNoise: { enabled: false, amplitude: 0 },
  },
  criterion: { kind: "measured", metricKey: "survival", direction: "maximize" },
} satisfies SimulatorSpec;

describe("PromptDeckSheet", () => {
  it("does not autofocus a prompt when a focused species opens the deck", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        createElement(PromptDeckSheet, {
          open: true,
          onClose: vi.fn(),
          sessionId: "session" as never,
          spec,
          deck: [{ slotId: "otters", count: 2, prompt: "" }],
          deckVersion: 1,
          focusedSlotId: "otters",
          speciesIcons: {},
          compiledPolicies: [],
          onSelectRun: vi.fn(),
        }),
      );
    });

    const [prompt] = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === "Otters prompt",
    );
    expect(prompt).toBeDefined();
    expect(prompt.props.autoFocus).toBe(false);
  });
});
