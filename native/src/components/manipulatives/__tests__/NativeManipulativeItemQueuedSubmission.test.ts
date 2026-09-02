import { createElement, useEffect, type ElementType, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// NativeManipulativeItem.test.ts drives the standalone NativeManipulativeHost
// launcher, which has no parent run and so never supplies
// `submitAnswerOverride` — it also stubs PracticePrimaryAction to render
// nothing, which is fine for that file's item-local-state focus but leaves no
// button to press. This file is purpose-built for the OTHER caller: the
// in-playlist practice screen, which ALWAYS supplies `submitAnswerOverride`
// so Done routes through the shared practice machine instead of a direct
// `submitAnswer` mutation. PracticePrimaryAction is mocked here as a REAL
// pressable (not a no-op) so Done/Next can actually be tapped.
// ─────────────────────────────────────────────────────────────────────────

const { items, passthrough } = vi.hoisted(() => ({
  items: new Map<string, { manipulativeSpec: string; stem: string; hint: string }>(),
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock("react-native", () => ({
  ActivityIndicator: passthrough,
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
  View: passthrough,
}));
vi.mock("react-native-gesture-handler", () => ({ ScrollView: passthrough }));
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
    ManipulativeScrollContext: createContext(null),
    successNotify: vi.fn(),
    warningNotify: vi.fn(),
  };
});
// Calls onStateChange once on mount so Done becomes enabled — the mock in
// NativeManipulativeItem.test.ts deliberately never does this (that file
// never presses Done at all).
vi.mock("../NativeManipulative", () => ({
  isNativeManipulativeKind: () => true,
  NativeManipulative: ({
    onStateChange,
  }: {
    spec: { prompt: string };
    onStateChange: (s: unknown) => void;
  }) => {
    useEffect(() => {
      onStateChange({ solved: true });
    }, [onStateChange]);
    return null;
  },
}));

import { NativeManipulativeItem } from "../NativeManipulativeItem";
import { successNotify, warningNotify } from "../kit";
import type {
  NativeManipulativeSubmission,
  NativeManipulativeSubmitArgs,
} from "../NativeManipulativeItem";

const SCHOLAR = "scholar-1" as never;
// A raw JSX-intrinsic-typed alias for the "pressable"/"verdict-stamp" host
// element strings both react-native mocks above render through
// createElement — neither is a real DOM/RN element the @types/react
// ElementType union recognizes, so findAllByType/findByType need this same
// escape hatch the file already used for "verdict-stamp".
const PRESSABLE = "pressable" as unknown as ElementType;

function item(prompt = "solve") {
  return {
    manipulativeSpec: JSON.stringify({ kind: "partition", concept: "Fractions", prompt }),
    stem: prompt,
    hint: "Try it.",
  };
}

/** A minimally-realistic submitAnswer result satisfying every required field
 *  of the real mutation's return validator (convex/practiceSkills.ts
 *  submitAnswer) — the component only ever reads `.correct` for its OWN
 *  rendering, but the type is exact, so the fixture must be too. */
function gradedResult(correct: boolean) {
  return {
    correct,
    skillKey: "skill-1",
    skillLabel: "Fractions",
    repetition: 1,
    proficiency: "practicing" as const,
    accelerated: false,
    turnedFluent: false,
    dispatchCompleted: [],
  };
}

/** An explicitly-typed submitAnswerOverride mock. `vi.fn()` infers its
 *  parameter tuple from the implementation closure passed to it (here,
 *  none) rather than from the prop it will later be assigned to, so an
 *  untyped `vi.fn(async () => ...)` resolves `.mock.calls[n]` to an empty
 *  tuple. Naming the function type explicitly fixes `.mock.calls[n][0]` to
 *  the real `NativeManipulativeSubmitArgs` the component actually calls it
 *  with. */
function mockSubmitAnswerOverride() {
  return vi.fn<(args: NativeManipulativeSubmitArgs) => Promise<NativeManipulativeSubmission>>();
}

function press(tree: ReturnType<typeof create>, label: string) {
  const node = tree.root
    .findAllByType(PRESSABLE)
    .find((candidate) => candidate.props.accessibilityLabel === label);
  if (!node) throw new Error(`No pressable found for "${label}"`);
  node.props.onPress();
}

describe("NativeManipulativeItem (parent-routed submission)", () => {
  afterEach(() => {
    items.clear();
    vi.restoreAllMocks();
  });

  it("routes Done through submitAnswerOverride instead of a direct mutation", async () => {
    items.set("m1", item());
    const submitAnswerOverride = mockSubmitAnswerOverride().mockImplementation(async () => ({
      status: "graded" as const,
      result: gradedResult(true),
    }));
    const onGraded = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        createElement(NativeManipulativeItem, {
          itemId: "m1",
          scholarId: SCHOLAR,
          shell: {} as never,
          isLast: false,
          submitAnswerOverride,
          onGraded,
        }),
      );
    });

    await act(async () => press(tree, "Done"));

    expect(submitAnswerOverride).toHaveBeenCalledTimes(1);
    expect(submitAnswerOverride.mock.calls[0][0]).toMatchObject({
      scholarId: SCHOLAR,
      itemId: "m1",
    });
    expect(onGraded).toHaveBeenCalledWith(gradedResult(true));
    expect(successNotify).not.toHaveBeenCalled();
    expect(warningNotify).not.toHaveBeenCalled();
    // A real grade enables Next/Finish exactly like a queued one does.
    expect(
      tree.root.findAllByType(PRESSABLE).some((p) => p.props.accessibilityLabel === "Next question"),
    ).toBe(true);

    await act(async () => tree.unmount());
  });

  it("shows durable queued feedback with no claimed grade, and Next stays enabled", async () => {
    items.set("m2", item());
    const submitAnswerOverride = mockSubmitAnswerOverride().mockImplementation(async () => ({
      status: "queued" as const,
      queuedCount: 1,
    }));
    const onGraded = vi.fn();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        createElement(NativeManipulativeItem, {
          itemId: "m2",
          scholarId: SCHOLAR,
          shell: {} as never,
          isLast: true,
          submitAnswerOverride,
          onGraded,
        }),
      );
    });

    await act(async () => press(tree, "Done"));

    // No verdict claimed: onGraded never fires for a queued outcome, and the
    // verdict stamp receives no feedback.
    expect(onGraded).not.toHaveBeenCalled();
    expect(
      tree.root.findByType("verdict-stamp" as never).props.feedback,
    ).toBeNull();
    expect(JSON.stringify(tree.toJSON())).toContain(
      "Saved — we'll check this one when the earlier answers finish.",
    );
    // Finish (isLast) is enabled immediately — a queued answer must not trap
    // the scholar on the item.
    const finish = tree.root
      .findAllByType(PRESSABLE)
      .find((p) => p.props.accessibilityLabel === "Finish practice");
    expect(finish).toBeTruthy();
    expect(finish!.props.disabled).toBeFalsy();

    await act(async () => tree.unmount());
  });

  it("retries on a non-durable failure while leaving receipt ownership to the parent machine", async () => {
    items.set("m3", item());
    const submitAnswerOverride = mockSubmitAnswerOverride()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({ status: "graded" as const, result: gradedResult(false) });
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        createElement(NativeManipulativeItem, {
          itemId: "m3",
          scholarId: SCHOLAR,
          shell: {} as never,
          isLast: false,
          submitAnswerOverride,
        }),
      );
    });

    await act(async () => press(tree, "Done"));
    expect(JSON.stringify(tree.toJSON())).toContain("storage unavailable");
    // Done is back (not Next/Finish) — the scholar may try again.
    expect(
      tree.root.findAllByType(PRESSABLE).some((p) => p.props.accessibilityLabel === "Done"),
    ).toBe(true);

    await act(async () => press(tree, "Done"));
    expect(submitAnswerOverride).toHaveBeenCalledTimes(2);
    expect(submitAnswerOverride.mock.calls[0][0].clientEventId).toBeUndefined();
    expect(submitAnswerOverride.mock.calls[1][0].clientEventId).toBeUndefined();

    await act(async () => tree.unmount());
  });
});
