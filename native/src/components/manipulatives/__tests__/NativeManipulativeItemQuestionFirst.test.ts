import { createElement, type ElementType, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// Question first, strategy optional. A kind whose board has a derivable
// numeric answer (`derivedQuestion`: distribute → the product) headlines the
// QUESTION, offers a numeric answer box, and keeps Done live even when the
// scholar never touched the board. The typed value rides inside the submitted
// state JSON. A kind with no derived question (partition) keeps the old
// contract: Done waits for a reported state, no answer box.
//
// Same in-playlist harness as NativeManipulativeItemQueuedSubmission.test.ts
// (interactive PracticePrimaryAction, `submitAnswerOverride`), but the kind
// mock here NEVER reports a state — that is the whole point.
// ─────────────────────────────────────────────────────────────────────────

const { items, passthrough, scrollToEnd, dismissKeyboard } = vi.hoisted(() => ({
  items: new Map<string, { manipulativeSpec: string; stem: string; hint: string }>(),
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
  scrollToEnd: vi.fn(),
  dismissKeyboard: vi.fn(),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: passthrough,
  Keyboard: { dismiss: dismissKeyboard },
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => createElement("pressable", { onPress, disabled, accessibilityLabel }, children),
  ScrollView: passthrough,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: passthrough,
  // Keeps props (unlike `passthrough`) so the stage wrapper's `onTouchStart`
  // — the manipulative's first-interaction clock (TRA-221) — is reachable.
  View: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("view", props, children),
}));
vi.mock("react-native-gesture-handler", async () => {
  const { useImperativeHandle } = await vi.importActual<typeof import("react")>("react");
  return {
    ScrollView: ({ ref, children, ...props }: {
      ref?: import("react").Ref<{ scrollToEnd: typeof scrollToEnd }>;
      children?: ReactNode;
    }) => {
      useImperativeHandle(ref, () => ({ scrollToEnd }));
      return createElement("scroll-view", props, children);
    },
  };
});
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("keyboard-stage", props, children) },
}));
vi.mock("@/hooks/useKeyboardInset", () => ({
  useKeyboardInset: () => ({ style: { paddingBottom: 320 } }),
}));
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: (_query: unknown, { itemId }: { itemId: string }) => items.get(itemId),
}));
vi.mock("@/lib/convex", () => ({
  api: { practiceSkills: { getManipulativeItem: "get", submitAnswer: "submit" } },
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular", semibold: "semibold" },
  useColors: () => ({
    bg: "#fff",
    bgSubtle: "#f8f8f8",
    border: "#ddd",
    charcoal: "#111",
    charcoalSubtle: "#666",
    cyan: "#0cc",
    cyanMuted: "#099",
    cyanSubtle: "#eff",
    fgMuted: "#666",
    gray50: "#eee",
    navy: "#111",
    orangeSubtle: "#fee",
    statusGreen: "#080",
    statusRed: "#c00",
    violet: "#808",
    violetMuted: "#606",
    violetSubtle: "#fef",
    white: "#fff",
  }),
}));
vi.mock("@/components/practice/PracticeVerdictStamp", () => ({
  PracticeVerdictStamp: ({ feedback }: { feedback: string | null }) =>
    createElement("verdict-stamp", { feedback }),
}));
// A REAL (interactive) stand-in — the whole point of this file, unlike the
// no-op stub NativeManipulativeItem.test.ts uses.
vi.mock("@/components/practice/NativePracticeControls", () => ({
  PracticePrimaryAction: ({
    label,
    accessibilityLabel,
    disabled,
    onAction,
  }: {
    label: string;
    accessibilityLabel: string;
    disabled?: boolean;
    onAction: () => void;
  }) =>
    createElement(
      "pressable",
      { accessibilityLabel, disabled, onPress: onAction },
      label,
    ),
  useGuardedPracticeAction: (action: () => void, enabled: boolean) => () => {
    if (enabled) action();
  },
}));
vi.mock("@/lib/practiceShell", () => ({ makePracticeShellStyles: () => ({}) }));
vi.mock("@/lib/webEmbedConfig", () => ({
  allowedHostsForUrl: () => [],
  manipulativeEmbedUrl: () => "https://example.com/embed",
}));
vi.mock("@/lib/externalAppHost", () => ({ openManipulativeEmbed: vi.fn() }));
vi.mock("../kit", async () => {
  const { createContext } = await vi.importActual<typeof import("react")>("react");
  return {
    ManipulativeIdleContext: createContext(true),
    ManipulativeScrollContext: createContext(null),
    successNotify: vi.fn(),
    warningNotify: vi.fn(),
  };
});
// Keeps props so the test can type into the box via `onChangeText`.
vi.mock("@/components/AppTextInput", () => ({
  AppTextInput: (props: Record<string, unknown>) => createElement("answer-input", props),
}));
// Never reports a state: an untouched board.
vi.mock("../NativeManipulative", async () => {
  const { createElement, useContext } = await vi.importActual<typeof import("react")>("react");
  const { ManipulativeIdleContext } = await import("../kit");
  return {
    isNativeManipulativeKind: () => true,
    NativeManipulative: () => createElement("idle-state", {
      "data-testid": "idle-state",
      idle: useContext(ManipulativeIdleContext),
    }),
  };
});

import { NativeManipulativeItem } from "../NativeManipulativeItem";
import type {
  NativeManipulativeSubmission,
  NativeManipulativeSubmitArgs,
} from "../NativeManipulativeItem";

const SCHOLAR = "scholar-1" as never;
const PRESSABLE = "pressable" as unknown as ElementType;
const ANSWER_INPUT = "answer-input" as unknown as ElementType;

const DISTRIBUTE = {
  kind: "distribute",
  id: "d",
  concept: "Distributive property",
  prompt: "Split the area model to find 6 × 13 using 6 × 10 + 6 × 3.",
  width: 13,
  height: 6,
  startColumn: 4,
  goal: { type: "splitAt", column: 10 },
};
const PARTITION = { kind: "partition", concept: "Fractions", prompt: "Shade one half." };

function seed(id: string, spec: object) {
  items.set(id, { manipulativeSpec: JSON.stringify(spec), stem: "stem", hint: "Try it." });
}

function mount(itemId: string, submitAnswerOverride: ReturnType<typeof mockOverride>) {
  return create(
    createElement(NativeManipulativeItem, {
      itemId,
      scholarId: SCHOLAR,
      shell: {} as never,
      isLast: false,
      submitAnswerOverride,
    }),
  );
}

function mockOverride() {
  return vi
    .fn<(args: NativeManipulativeSubmitArgs) => Promise<NativeManipulativeSubmission>>()
    .mockImplementation(async () => ({
      status: "graded" as const,
      result: {
        correct: true,
        skillKey: "s",
        skillLabel: "l",
        repetition: 1,
        proficiency: "practicing" as const,
        accelerated: false,
        turnedFluent: false,
        dispatchCompleted: [],
      },
    }));
}

function done(tree: ReturnType<typeof create>) {
  return tree.root.findAllByType(PRESSABLE).find((p) => p.props.accessibilityLabel === "Done")!;
}

describe("NativeManipulativeItem — question first, strategy optional", () => {
  afterEach(() => {
    items.clear();
    vi.restoreAllMocks();
  });

  it("headlines the derived question, demotes the strategy, and keeps Done live on an untouched board", async () => {
    seed("q1", DISTRIBUTE);
    const override = mockOverride();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = mount("q1", override);
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain("What is 6 × 13?");
    expect(text).toContain("(Use the area model to split the 13 into 10 and 3)");
    // The stored prompt (which restates the question) is not shown twice.
    expect(text).not.toContain("Split the area model to find");
    expect(done(tree).props.disabled).toBeFalsy();

    // Type the product; the board was never touched (state stays null).
    const input = tree.root.findByType(ANSWER_INPUT);
    await act(async () => input.props.onChangeText("78"));
    await act(async () => done(tree).props.onPress());

    expect(override).toHaveBeenCalledTimes(1);
    expect(JSON.parse(override.mock.calls[0][0].answer)).toEqual({ value: 78 });
    expect(dismissKeyboard).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it("reveals the focused answer as the keyboard shrinks the stage, without scrolling a board in use", async () => {
    seed("keyboard", DISTRIBUTE);
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = mount("keyboard", mockOverride()); });
    const stage = tree.root.findByType("keyboard-stage" as ElementType);
    expect(stage.props.style).toContainEqual({ paddingBottom: 320 });
    const scroll = tree.root.findByType("scroll-view" as ElementType);
    const input = tree.root.findByType(ANSWER_INPUT);
    scrollToEnd.mockClear();
    await act(async () => scroll.props.onLayout());
    expect(scrollToEnd).not.toHaveBeenCalled();
    await act(async () => input.props.onFocus());
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    scrollToEnd.mockClear();
    await act(async () => scroll.props.onLayout());
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    await act(async () => input.props.onBlur());
    scrollToEnd.mockClear();
    await act(async () => scroll.props.onLayout());
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    await act(async () => tree.unmount());
  });

  it("submits an untouched board with no number as-is (the server grades it a miss)", async () => {
    seed("q2", DISTRIBUTE);
    const override = mockOverride();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = mount("q2", override);
    });
    await act(async () => done(tree).props.onPress());
    expect(override).toHaveBeenCalledTimes(1);
    expect(override.mock.calls[0][0].answer).toBe("null");
    await act(async () => tree.unmount());
  });

  it("does not re-arm the idle cue after typing is cleared", async () => {
    seed("q3", DISTRIBUTE);
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = mount("q3", mockOverride()); });
    const idle = () => tree.root.findByProps({ "data-testid": "idle-state" }).props.idle;
    expect(idle()).toBe(true);
    await act(async () => tree.root.findByType(ANSWER_INPUT).props.onChangeText("78"));
    expect(idle()).toBe(false);
    await act(async () => tree.root.findByType(ANSWER_INPUT).props.onChangeText(""));
    expect(idle()).toBe(false);
    await act(async () => tree.unmount());
  });

  it("keeps the idle cue off after Done fails and allows a retry", async () => {
    seed("q4", DISTRIBUTE);
    const override = mockOverride().mockRejectedValueOnce(new Error("Offline"));
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = mount("q4", override); });
    await act(async () => done(tree).props.onPress());
    expect(done(tree).props.disabled).toBeFalsy();
    expect(tree.root.findByProps({ "data-testid": "idle-state" }).props.idle).toBe(false);
    await act(async () => tree.unmount());
  });

  it("a kind with no derived question keeps the old contract: no answer box, Done waits for a state", async () => {
    seed("p1", PARTITION);
    const override = mockOverride();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = mount("p1", override);
    });
    expect(JSON.stringify(tree.toJSON())).toContain("Shade one half.");
    expect(tree.root.findAllByType(ANSWER_INPUT)).toHaveLength(0);
    expect(done(tree).props.disabled).toBe(true);
    await act(async () => tree.unmount());
  });
});
