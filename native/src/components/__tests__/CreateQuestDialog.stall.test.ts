import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The X and backdrop used to be disabled while a quest start was pending. The
// Convex client queues a write behind a dead socket and never rejects it, so
// on a locked fleet iPad (no Home gesture) a stalled start left no way out.
// This pins the exit: closing stays possible mid-start, and abandons it.
// ─────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  createQuest: vi.fn(),
  createSession: vi.fn(),
  scheduleBake: vi.fn(),
  handOff: false,
  pickerProps: [] as { onSpecificBuild?: () => void }[],
}));

// Freeze Mode's modal wrapper adds an overlay this test doesn't exercise;
// hand back the mocked React Native Modal.
vi.mock("@/components/FreezableModal", async () => ({
  Modal: (await import("react-native")).Modal,
}));
vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  const element =
    (tag: string) =>
    ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
      react.createElement(tag, props as never, children);
  return {
    ActivityIndicator: () => react.createElement("spinner"),
    KeyboardAvoidingView: passthrough,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
      visible ? react.createElement("modal", null, children) : null,
    Platform: { OS: "ios" },
    Pressable: element("button"),
    ScrollView: passthrough,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: element("text"),
    View: passthrough,
  };
});
vi.mock("convex/react", () => ({
  useMutation: (ref: string) =>
    ({
      "units.createQuest": mocks.createQuest,
      "sessions.create": mocks.createSession,
      "units.scheduleCustomQuestBake": mocks.scheduleBake,
    })[ref],
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));
vi.mock("expo-haptics", () => ({
  selectionAsync: () => Promise.resolve(),
  notificationAsync: () => Promise.resolve(),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/lib/convex", () => ({
  api: {
    units: {
      createQuest: "units.createQuest",
      scheduleCustomQuestBake: "units.scheduleCustomQuestBake",
    },
    sessions: { create: "sessions.create" },
  },
}));
vi.mock("@/theme", () => ({
  fonts: {},
  palette: { navy: { 900: "#000" } },
  useColors: () => ({}),
}));
vi.mock("@/components/AppTextInput", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    AppTextInput: (props: Record<string, unknown>) =>
      react.createElement("input", props as never),
  };
});
// The real picker is covered by BakePathPicker.*.test.ts; here it only
// records its props and, when told to, hands off a specific build on mount.
vi.mock("@/components/BakePathPicker", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    BakePathPicker: (props: {
      onSpecificBuild?: () => void;
      onSelect: (choice: unknown) => void;
    }) => {
      mocks.pickerProps.push(props);
      react.useEffect(() => {
        if (mocks.handOff) props.onSpecificBuild?.();
        else props.onSelect("endless-chat");
      }, []); // mount only
      return null;
    },
    ENDLESS_CHAT: "endless-chat",
    bakePathArg: (choice: unknown) =>
      choice === "endless-chat" ? undefined : choice,
  };
});
vi.mock("../../../vendor/shared/missionCopy", () => ({
  BUILD_IT_PATH: {
    emoji: "🛠️",
    title: "Build it",
    blurb: "Build the thing you described.",
    shape: "buildFirst",
  },
}));

import { CreateQuestDialog } from "../CreateQuestDialog";

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

function buttonWithText(root: ReactTestInstance, text: string): ReactTestInstance {
  const match = root
    .findAllByType("button")
    .find((button) => textOf(button).includes(text));
  if (!match) throw new Error(`No button with text ${text}`);
  return match;
}

async function renderAtPathStep(onClose: () => void) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(CreateQuestDialog, { open: true, onClose }));
  });
  const root = renderer.root;
  await act(async () => {
    root.findAllByType("input")[0].props.onChangeText("Why do octopuses have 3 hearts?");
  });
  await act(async () => {
    buttonWithText(root, "Continue").props.onPress();
  });
  return root;
}

describe("CreateQuestDialog while a quest start is stalled", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.handOff = false;
    mocks.pickerProps = [];
  });

  it("keeps the X live mid-start, and a late resolve after closing goes nowhere", async () => {
    let resolveQuest!: (value: { unitId: string }) => void;
    mocks.createQuest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuest = resolve;
        }),
    );
    mocks.createSession.mockResolvedValue({ id: "session-1" });
    const onClose = vi.fn();
    const root = await renderAtPathStep(onClose);

    await act(async () => {
      buttonWithText(root, "Start exploring").props.onPress();
    });
    expect(mocks.createQuest).toHaveBeenCalledTimes(1);
    expect(root.findAllByType("spinner")).toHaveLength(1);

    const close = root.findByProps({ accessibilityLabel: "Close" });
    expect(close.props.disabled).toBeFalsy();
    await act(async () => {
      close.props.onPress();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The queued write lands after the scholar has left: the abandoned attempt
    // must not chain on to a session, nor navigate anywhere.
    await act(async () => {
      resolveQuest({ unitId: "unit-1" });
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("launches a specific build without a menu when the picker hands off", async () => {
    mocks.handOff = true;
    mocks.createQuest.mockResolvedValue({ unitId: "unit-1" });
    mocks.createSession.mockResolvedValue({ id: "session-1" });
    mocks.scheduleBake.mockResolvedValue(null);
    const onClose = vi.fn();
    await renderAtPathStep(onClose);

    expect(mocks.createQuest).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleBake).toHaveBeenCalledWith(
      expect.objectContaining({
        bakePath: expect.objectContaining({ shape: "buildFirst" }),
      }),
    );
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the starting line mid-launch, and a failed launch returns to the menu once", async () => {
    mocks.handOff = true;
    let rejectQuest!: (e: Error) => void;
    mocks.createQuest.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectQuest = reject;
        }),
    );
    const root = await renderAtPathStep(vi.fn());
    expect(textOf(root)).toContain("🛠️ Starting your build…");
    expect(root.findAllByType("spinner")).toHaveLength(1);

    await act(async () => {
      rejectQuest(new Error("Offline"));
    });
    expect(textOf(root)).not.toContain("Starting your build");
    expect(textOf(root)).toContain("Offline");
    // The picker is back, without the hand-off, so it shows its menu rather
    // than relaunching the build in a loop.
    expect(mocks.pickerProps.at(-1)?.onSpecificBuild).toBeUndefined();
    expect(mocks.createQuest).toHaveBeenCalledTimes(1);
  });
});
