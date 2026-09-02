import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSession,
  routerPush,
  toasterError,
} = vi.hoisted(() => ({
  createSession: vi.fn(),
  routerPush: vi.fn(),
  toasterError: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: <T,>(factory: () => T) => factory(),
    useState: <T,>(initial: T) => [initial, vi.fn()] as const,
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("convex/react", () => ({
  useMutation: (mutation: string) =>
    mutation === "sessions.create" ? createSession : vi.fn(),
  useQuery: (query: string) => {
    if (query === "sessions.get") {
      return { unitId: "unit", activityId: "current", assignmentId: "assignment" };
    }
    if (query === "units.get") return { _id: "unit", title: "Unit" };
    if (query === "activities.getPublic") return { _id: "current", title: "Current" };
    if (query === "activityCompletions.listForScholarInUnit") {
      return [{ activityId: "current" }];
    }
    if (query === "activities.listByUnitPublic") {
      return [
        { _id: "current", title: "Current", kind: "online" },
        { _id: "next", title: "Next", kind: "online" },
      ];
    }
    if (query === "sessions.list") return [];
    return null;
  },
}));
vi.mock("@/convex/_generated/api", () => ({
  api: {
    activities: { getPublic: "activities.getPublic", listByUnitPublic: "activities.listByUnitPublic" },
    activityCompletions: {
      listForScholarInUnit: "activityCompletions.listForScholarInUnit",
      markComplete: "activityCompletions.markComplete",
      unmarkComplete: "activityCompletions.unmarkComplete",
    },
    lessons: { getPublic: "lessons.getPublic" },
    sessions: { create: "sessions.create", get: "sessions.get", list: "sessions.list" },
    units: { get: "units.get" },
  },
}));
vi.mock("@/hooks/useRemote", () => ({ useRemote: () => ({ stamp: (path: string) => path }) }));
vi.mock("@/hooks/useWebAssignment", () => ({
  useWebAssignment: () => ({ donePrompt: null, launch: vi.fn(), resolveDonePrompt: vi.fn() }),
}));
vi.mock("@/hooks/useGameActivity", () => ({
  useGameActivity: () => ({ dismiss: vi.fn(), launch: vi.fn(), prompt: null }),
}));
vi.mock("@/lib/toaster", () => ({ toaster: { error: toasterError } }));

import { useSessionActivityNav } from "./SessionActivityNav";

describe("useSessionActivityNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSession.mockRejectedValue(new Error("Assignment is archived"));
  });

  it("shows one error toast and does not navigate when continuing cannot create a session", async () => {
    const nav = useSessionActivityNav("session" as never, "scholar" as never, null);

    await nav.continueToNext();

    expect(toasterError).toHaveBeenCalledTimes(1);
    expect(toasterError).toHaveBeenCalledWith({
      title: "Couldn't start that activity",
      description: "Please try again.",
    });
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("shows one error toast and does not navigate when tree selection cannot create a session", async () => {
    const nav = useSessionActivityNav("session" as never, "scholar" as never, null);

    await nav._modal.handleSelectFromTree({
      type: "activity",
      unitId: "unit" as never,
      lessonId: "lesson" as never,
      activityId: "next" as never,
      kind: "online",
      title: "Next",
      description: null,
    });

    expect(toasterError).toHaveBeenCalledTimes(1);
    expect(toasterError).toHaveBeenCalledWith({
      title: "Couldn't start that activity",
      description: "Please try again.",
    });
    expect(routerPush).not.toHaveBeenCalled();
  });
});
