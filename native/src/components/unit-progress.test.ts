import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const { alert, createSession, routerPush, fixture } = vi.hoisted(() => ({
  alert: vi.fn(),
  createSession: vi.fn(),
  routerPush: vi.fn(),
  fixture: { activityKind: "online" },
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
  }) => react.createElement("div", props as never, children);
  return {
    ActivityIndicator: () => null,
    Alert: { alert },
    Pressable,
    ScrollView: passthrough,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: passthrough,
    View: passthrough,
  };
});
vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn() }),
  useMutation: () => createSession,
  useQuery: (query: string) => {
    if (query === "units.get") return { title: "A unit", emoji: "📚" };
    if (query === "lessons.listByUnitPublic") {
      return [{ _id: "lesson", title: "Lesson", order: 0, durationMinutes: null }];
    }
    if (query === "activities.listByUnitPublic") {
      return [{
        _id: "activity",
        lessonId: "lesson",
        title: "A focused activity",
        description: null,
        kind: fixture.activityKind,
        durationMinutes: null,
        order: 0,
        resources: [],
      }];
    }
    if (query === "activityCompletions.listForScholarInUnit") return [];
    if (query === "sessions.list") return [];
    return null;
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ unitId: "unit", assignmentId: "assignment" }),
  useRouter: () => ({ push: routerPush }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("@/lib/convex", () => ({
  api: {
    activities: {
      getPublic: "activities.getPublic",
      listByUnitPublic: "activities.listByUnitPublic",
    },
    activityCompletions: {
      listForScholarInUnit: "activityCompletions.listForScholarInUnit",
    },
    lessons: { listByUnitPublic: "lessons.listByUnitPublic" },
    sessions: { create: "sessions.create", list: "sessions.list" },
    units: { get: "units.get" },
  },
}));
vi.mock("@/lib/externalAppHost", () => ({ openWebActivity: vi.fn() }));
vi.mock("@/lib/gameHost", () => ({ openGameActivity: vi.fn() }));
vi.mock("@/lib/webEmbedConfig", () => ({ webEmbedUrlError: () => null }));
vi.mock("@/components/ResourceShareCard", () => ({ ResourceShareCard: () => null }));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular", semibold: "semibold" },
  palette: {
    gray: { 50: "#eee", 100: "#ddd", 200: "#ccc" },
    green: { 50: "#efe", 200: "#cec" },
    violet: { 50: "#fef", 200: "#ece" },
  },
  useColors: () => ({
    bg: "#fff",
    bgSubtle: "#f7f7f7",
    border: "#ddd",
    charcoal: "#222",
    charcoalSubtle: "#666",
    green: "#080",
    gray300: "#aaa",
    navy: "#123",
    violet: "#456",
    violetSubtle: "#f0e",
    white: "#fff",
  }),
}));

import UnitProgressScreen from "../app/unit-progress";

describe("UnitProgressScreen", () => {
  afterEach(() => {
    vi.clearAllMocks();
    fixture.activityKind = "online";
  });

  it("shows one error alert and does not navigate when Continue cannot create a session", async () => {
    createSession.mockRejectedValueOnce(new Error("Assignment is archived"));
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(UnitProgressScreen));
    });
    const continueButton = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === "Continue to A focused activity",
    )[0];

    await act(async () => {
      await continueButton.props.onPress();
    });

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      "Couldn't start that activity",
      "Please try again.",
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("starts a simulator activity from the unit progress Continue action", async () => {
    fixture.activityKind = "simulator";
    createSession.mockResolvedValueOnce({ id: "session" });
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(UnitProgressScreen));
    });
    const continueButton = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === "Continue to A focused activity",
    )[0];

    await act(async () => {
      await continueButton.props.onPress();
    });

    expect(createSession).toHaveBeenCalledWith({
      activityId: "activity",
      assignmentId: "assignment",
    });
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/session/[id]",
      params: { id: "session", title: "A focused activity" },
    });
  });

  it("starts a vibecode activity from the unit progress Continue action", async () => {
    fixture.activityKind = "vibecode";
    createSession.mockResolvedValueOnce({ id: "session" });
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(UnitProgressScreen));
    });
    const continueButton = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === "Continue to A focused activity",
    )[0];

    await act(async () => {
      await continueButton.props.onPress();
    });

    expect(createSession).toHaveBeenCalledWith({
      activityId: "activity",
      assignmentId: "assignment",
    });
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/session/[id]",
      params: { id: "session", title: "A focused activity" },
    });
  });
});
