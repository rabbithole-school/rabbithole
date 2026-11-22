import { createElement, type ReactElement } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session route's Quest lookup, the header pill it hands the screens, and
 * the "How does it work?" sheet (TRA-720), rendered for real with the platform
 * mocked: which session counts as the Quest's, and that a send in flight
 * can't be dismissed and resent from a fresh sheet.
 */

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props as never, children as never);
  return {
    ActivityIndicator: host("spinner"),
    KeyboardAvoidingView: host("kav"),
    Platform: { OS: "ios" },
    Pressable: host("pressable"),
    Text: host("text"),
    View: host("view"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});
vi.mock("@/components/FreezableModal", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    Modal: ({ visible, children, ...props }: { visible: boolean; children?: unknown }) =>
      visible ? react.createElement("modal", props as never, children as never) : null,
  };
});
vi.mock("@/components/AppTextInput", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { AppTextInput: (props: object) => react.createElement("textinput", props) };
});
vi.mock("@/components/HeaderPillButton", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    TEACHER_HANDOFF_ICON: "paperplane",
    HeaderPillButton: (props: object) => react.createElement("pill", props),
  };
});
vi.mock("phosphor-react-native", () => ({ MicrophoneIcon: () => null, StopIcon: () => null }));
vi.mock("expo-haptics", () => ({
  selectionAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  NotificationFeedbackType: { Success: "success" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/theme", () => ({
  palette: { navy: { 900: "#000" } },
  fonts: { bold: "b", regular: "r", semibold: "s" },
  useColors: () => new Proxy({}, { get: () => "#000" }),
}));
vi.mock("@/hooks/useNow", () => ({ useNow: () => 0 }));
vi.mock("@/hooks/useStreamingDictation", () => ({
  useStreamingDictation: () => ({
    state: "idle",
    error: null,
    toggleRecording: () => {},
    cancelRecording: () => {},
  }),
}));
vi.mock("@/lib/convex", () => ({
  api: {
    questProposals: { forSelf: "questProposals:forSelf" },
    questShowing: { markReadyToShow: "questShowing:markReadyToShow" },
  },
}));
let approved: Array<Record<string, unknown>> = [];
vi.mock("@/hooks/useContainedQuery", () => ({
  useContainedQuery: (_query: unknown, args: unknown) =>
    args === "skip" ? { data: undefined } : { data: { approved, waiting: [], offered: [] } },
}));
const markReady = vi.fn<(args: unknown) => Promise<void>>();
vi.mock("convex/react", () => ({ useMutation: () => markReady }));

import { QuestShowingProvider, useQuestReadyPill } from "./QuestShowing";

const quest = {
  unitId: "u-croc",
  activityId: "a-croc",
  readyToShowAt: null,
  shownAt: null,
  inMyWords: null,
};

function Header({ onPill }: { onPill: (pill: ReactElement | null) => void }) {
  onPill(useQuestReadyPill());
  return null;
}

function renderRoute(activityId: string | null) {
  let pill: ReactElement | null = null;
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(
      createElement(
        QuestShowingProvider,
        { sessionId: "s1" as never, unitId: "u-croc" as never, activityId: activityId as never },
        createElement(Header, { onPill: (p) => (pill = p) }),
      ),
    );
  });
  return { tree, pill: () => pill };
}

const buttons = (root: ReactTestInstance) =>
  root.findAll((node) => node.props.accessibilityRole === "button");
const button = (root: ReactTestInstance, label: string) =>
  buttons(root).find((b) =>
    b.findAll((n) => (n.type as unknown) === "text").some((t) => t.children.includes(label)),
  );

beforeEach(() => {
  approved = [quest];
  markReady.mockReset();
});

describe("QuestShowingProvider", () => {
  it("gives the Quest's maker session the pill", () => {
    const { pill } = renderRoute("a-croc");
    expect(pill()?.props.label).toBe("I’m ready to show");
  });

  it("gives another activity in the Quest's unit no pill", () => {
    const { pill } = renderRoute("a-extra");
    expect(pill()).toBeNull();
  });

  it("shows the checkmark state once the kid has said so", () => {
    approved = [{ ...quest, readyToShowAt: 1, inMyWords: "It opens." }];
    const { pill } = renderRoute("a-croc");
    expect(pill()?.props.label).toBe("Ready to show");
  });

  it("can't be dismissed while a send is on its way, and closes when it lands", async () => {
    let land!: () => void;
    markReady.mockReturnValue(new Promise<void>((resolve) => (land = resolve)));
    const { tree, pill } = renderRoute("a-croc");
    const root = tree.root;

    act(() => pill()?.props.onPress());
    const modal = () => root.findAll((n) => (n.type as unknown) === "modal");
    expect(modal()).toHaveLength(1);
    act(() => root.findByType("textinput" as never).props.onChangeText("You type an angle."));
    act(() => button(root, "Send")?.props.onPress());
    expect(markReady).toHaveBeenCalledTimes(1);

    // The backdrop, Cancel and the system's dismiss all leave it open.
    act(() => modal()[0].props.onRequestClose());
    const backdrop = root.findAll(
      (n) => (n.type as unknown) === "pressable" && n.props.accessibilityRole === undefined,
    )[0];
    act(() => backdrop.props.onPress());
    act(() => button(root, "Cancel")?.props.onPress());
    expect(modal()).toHaveLength(1);

    await act(async () => {
      land();
      await Promise.resolve();
    });
    expect(modal()).toHaveLength(0);
    expect(markReady).toHaveBeenCalledTimes(1);
  });
});
