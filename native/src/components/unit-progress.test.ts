import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The `react-native` mocks below render Text/View as passthroughs, so the
 *  rendered tree is raw strings nested in arrays and host elements. */
const renderedText = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join(" ");
  if (node && typeof node === "object" && "children" in node) {
    return renderedText((node as { children: unknown }).children);
  }
  return "";
};

const { alert, createSession, routerPush, fixture } = vi.hoisted(() => ({
  alert: vi.fn(),
  createSession: vi.fn(),
  routerPush: vi.fn(),
  fixture: {
    activityKind: "online",
    completed: false,
    unit: null as Record<string, unknown> | null,
  },
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
    if (query === "units.get") {
      return fixture.unit ?? { title: "A unit", emoji: "📚" };
    }
    if (query === "users.currentUser") return { _id: "scholar" };
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
    if (query === "activityCompletions.listForScholarInUnit") {
      return fixture.completed
        ? [{ activityId: "activity", lessonId: "lesson", completedAt: 1 }]
        : [];
    }
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
    sessions: {
      create: "sessions.create",
      list: "sessions.list",
      startFreePlay: "sessions.startFreePlay",
      questFromParkedIdea: "sessions.questFromParkedIdea",
    },
    quests: { appendBuildStep: "quests.appendBuildStep" },
    units: { get: "units.get" },
    users: { currentUser: "users.currentUser" },
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
    fixture.completed = false;
    fixture.unit = null;
  });

  // TRA-519 B6: a Quest build step waiting on its learning step reads as
  // locked with why, and is never the Continue target (no tap action).
  it("shows a locked Quest build step with its unlock line and no Continue", () => {
    fixture.activityKind = "vibecode";
    fixture.unit = {
      title: "My Quest",
      emoji: "🧭",
      authorScholarId: "scholar",
      mission: { text: "Find out why bridges sag", setAt: 1 },
      questLocks: { activity: { prerequisiteTitle: "Name the rule" } },
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(UnitProgressScreen));
    });
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Unlocks when you finish Name the rule");
    // B5: the scholar's own Quest shows its mission line.
    expect(text).toContain("Mission:");
    expect(text).toContain("Find out why bridges sag");
    expect(
      renderer.root.findAll(
        (node) =>
          node.props.accessibilityLabel === "Continue to A focused activity",
      ),
    ).toHaveLength(0);
  });

  it("hides the mission line on a Quest the viewer did not author", () => {
    fixture.unit = {
      title: "Their Quest",
      authorScholarId: "someone-else",
      mission: { text: "Find out why bridges sag", setAt: 1 },
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(UnitProgressScreen));
    });
    expect(renderedText(renderer.toJSON())).not.toContain("Mission:");
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
    // An app activity (either stored shape reaches the client as "vibecode")
    // reads as "App", never the internal token (TRA-519).
    expect(renderedText(renderer.toJSON())).toContain("App");
    expect(renderedText(renderer.toJSON())).not.toContain("Vibecode");
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

  // The screen is mounted with `assignmentId`, which is the homework shape:
  // `activities.listByUnitPublic` then returns only what THAT assignment made
  // live, so finishing everything on screen says nothing about the unit.
  it("claims only the visible list when every activity on screen is done", () => {
    fixture.completed = true;
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(createElement(UnitProgressScreen));
    });

    const text = renderedText(renderer.toJSON());
    expect(text).toContain("1 of 1 done");
    expect(text).toContain("All done here.");
    expect(text).not.toContain("Unit complete");
    expect(text).not.toContain("every activity is done");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Both native unit-progress surfaces — this screen and the `useUnitProgress`
// hook behind `WhereAmIPanel` — used to turn `completedCount === activityTotal`
// into a "Unit complete" claim. That comparison runs over an ASSIGNMENT-scoped
// activity list, so a homework session carrying one activity out of a
// multi-lesson unit satisfied it on the first completion. The claim is retired
// rather than recalibrated (same call as the completion card): the real unit
// celebration is `maybeAwardUnitBadge` in `convex/lib/badgeAward.ts`, which
// walks every lesson in the unit with no assignment filter.
// ─────────────────────────────────────────────────────────────────────────
describe("native unit-progress surfaces", () => {
  const src = (path: string) =>
    readFileSync(resolve(__dirname, "..", path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("makes no unit-completion claim off an assignment-scoped count", () => {
    for (const path of ["app/unit-progress.tsx", "hooks/useUnitProgress.ts"]) {
      expect(src(path)).not.toContain("Unit complete");
    }
  });
});
