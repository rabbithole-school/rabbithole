import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createSession,
  gameLaunch,
  routerPush,
  toasterError,
  webLaunch,
} = vi.hoisted(() => ({
  createSession: vi.fn(),
  gameLaunch: vi.fn(),
  routerPush: vi.fn(),
  toasterError: vi.fn(),
  webLaunch: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useCallback: <T,>(callback: T) => callback };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("convex/react", () => ({ useMutation: () => createSession }));
vi.mock("@/convex/_generated/api", () => ({
  api: { sessions: { create: "sessions.create" } },
}));
vi.mock("@/hooks/useWebAssignment", () => ({
  useWebAssignment: () => ({
    donePrompt: null,
    launch: webLaunch,
    launching: false,
    resolveDonePrompt: vi.fn(),
  }),
}));
vi.mock("@/hooks/useGameActivity", () => ({
  useGameActivity: () => ({
    dismiss: vi.fn(),
    launch: gameLaunch,
    prompt: null,
    launching: false,
  }),
}));
vi.mock("@/lib/toaster", () => ({ toaster: { error: toasterError } }));

import { useJoinFocus, type JoinableFocus } from "./useJoinFocus";

const activityFocus = {
  activityId: "activity" as never,
  activityKind: "online",
  activityTitle: "A focused activity",
  assignmentId: "assignment" as never,
  webAllowedHosts: null,
  webUrl: null,
} satisfies JoinableFocus;

describe("useJoinFocus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows one error toast and does not navigate when session creation fails", async () => {
    createSession.mockRejectedValueOnce(new Error("Assignment is archived"));

    await useJoinFocus().join(activityFocus);

    expect(toasterError).toHaveBeenCalledTimes(1);
    expect(toasterError).toHaveBeenCalledWith({
      title: "Couldn't start that activity",
      description: "Please try again.",
    });
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("navigates to the created session", async () => {
    createSession.mockResolvedValueOnce({ id: "session" });

    await useJoinFocus().join(activityFocus);

    expect(routerPush).toHaveBeenCalledWith("/scholar/session");
    expect(toasterError).not.toHaveBeenCalled();
  });

  it("preserves web, game, practice, and picker branches", async () => {
    const { join } = useJoinFocus();
    const onNeedsPicker = vi.fn();

    await join({ ...activityFocus, activityKind: "web", webUrl: "https://example.com" });
    await join({ ...activityFocus, activityKind: "game", gameId: "game" });
    await join({
      ...activityFocus,
      activityKind: "problem_set",
      practiceSkillKey: "fractions",
    });
    await join({ ...activityFocus, activityId: null }, { onNeedsPicker });

    expect(webLaunch).toHaveBeenCalledTimes(1);
    expect(gameLaunch).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith("/scholar/practice?skill=fractions");
    expect(onNeedsPicker).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(toasterError).not.toHaveBeenCalled();
  });
});
