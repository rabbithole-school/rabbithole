// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ArtifactDeliverableButton,
  type ArtifactDeliverableButtonProps,
} from "@/components/ArtifactDeliverableButton";
import { system } from "@/lib/theme";
import { FINISH_AND_SEND_CONFIRM } from "@/shared/finishAndSend";
import { MissionControl } from "./MissionControl";

vi.mock("convex/react", () => ({
  useMutation: () => retrySetup,
  useQuery: vi.fn(),
}));
// The session page's Quest lookup (TRA-720): null off a Quest, undefined
// while it loads, the Quest's row on one.
let questSession: unknown = null;
vi.mock("@/components/QuestShowing", () => ({
  useQuestSession: () => questSession,
}));

const criteria = [
  { id: "mission-1", label: "Your cart's weight", description: "Private rule" },
  { id: "mission-2", label: "Your cart's journey", description: "Private answer" },
];
const spec: ArtifactDeliverableButtonProps["deliverableSpec"] = {
  kind: "artifact",
  prompt: "Build your app and try it out.",
  mode: "auto",
  criteria,
};
const submit = vi.fn<() => Promise<void>>();
const retrySetup = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.mocked(useQuery).mockReturnValue(null);
  submit.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  questSession = null;
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function render(child: ReactNode) {
  await act(async () => {
    root.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, { value: system, children: child }),
    );
  });
}

async function renderButton(overrides: Partial<ArtifactDeliverableButtonProps> = {}) {
  await render(createElement(ArtifactDeliverableButton, {
    sessionId: "test-session" as ArtifactDeliverableButtonProps["sessionId"],
    activityId: "test-activity" as ArtifactDeliverableButtonProps["activityId"],
    artifactId: "test-artifact" as ArtifactDeliverableButtonProps["artifactId"],
    deliverableSpec: spec,
    finishOnly: true,
    onSubmit: submit,
    ...overrides,
  }));
}

function button() {
  const element = container.querySelector("button");
  if (!element) throw new Error("Missing footer button");
  return element;
}

describe("finish-only artifact submission", () => {
  test.each(["pending", "error", "ready"] as const)(
    "asks before sending when criteria are %s, without preparing or retrying",
    async (criteriaStatus) => {
      await renderButton({
        deliverableSpec: {
          ...spec,
          criteriaStatus,
          criteria: criteriaStatus === "ready" ? criteria : [],
          criteriaError: criteriaStatus === "error" ? "Setup failed" : null,
        },
      });
      expect(button().textContent).toBe("Finish and send");
      expect(button().disabled).toBe(false);
      expect(container.textContent).not.toContain("check");

      vi.mocked(window.confirm).mockReturnValueOnce(false);
      await act(async () => button().click());
      expect(window.confirm).toHaveBeenCalledWith(
        `${FINISH_AND_SEND_CONFIRM.title}\n\n${FINISH_AND_SEND_CONFIRM.body}`,
      );
      expect(submit).not.toHaveBeenCalled();

      await act(async () => button().click());
      expect(submit).toHaveBeenCalledOnce();
      expect(retrySetup).not.toHaveBeenCalled();
    },
  );

  test("keeps submission unavailable for observers and while work is busy", async () => {
    for (const overrides of [
      { onSubmit: undefined },
      { checkDisabled: true },
      { isAiCheckingRubric: true },
    ]) {
      await renderButton(overrides);
      expect(button().disabled).toBe(true);
      await act(async () => button().click());
    }
    expect(window.confirm).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test("keeps earned flair labeled with the session's criteria", async () => {
    vi.mocked(useQuery).mockImplementation((...args) =>
      getFunctionName(args[0]) === "deliverables:getForSessionActivity"
        ? {
            _id: "test-deliverable",
            flairEarned: [{ criterionId: "mission-1", earnedAt: 1 }],
          }
        : null,
    );
    await renderButton();
    const chips = container.querySelectorAll('button[aria-label^="Flair earned:"]');
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("aria-label")).toContain("Your cart's weight");
    expect(container.textContent).toContain("Finish and send");
  });

  test("ordinary rubric-backed work still checks without asking to finish", async () => {
    await renderButton({ finishOnly: false });
    expect(button().textContent).toBe("Check my work");
    await act(async () => button().click());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });

  test("ordinary auto criteria still prepare and offer retry on failure", async () => {
    await renderButton({
      finishOnly: false,
      deliverableSpec: { ...spec, criteria: [], criteriaStatus: "pending" },
    });
    expect(button().textContent).toBe("Preparing check\u2026");
    expect(button().disabled).toBe(true);
    await renderButton({
      finishOnly: false,
      deliverableSpec: { ...spec, criteria: [], criteriaStatus: "error" },
    });
    expect(button().textContent).toBe("Try preparing check again");
    await act(async () => button().click());
    expect(retrySetup).toHaveBeenCalledWith({
      sessionId: "test-session",
      retryErroredCriteria: true,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  test("ordinary no-rubric work still confirms before finishing", async () => {
    await renderButton({
      finishOnly: false,
      deliverableSpec: { ...spec, mode: "none", criteria: [] },
    });
    expect(button().textContent).toBe("Finish and send");
    vi.mocked(window.confirm).mockReturnValue(false);
    await act(async () => button().click());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("a Quest's session (TRA-720)", () => {
  // The header's "I'm ready to show" is a Quest's one hand-in.
  const quest = { unitId: "unit-1" };

  test("offers no Finish and send, nor while the Quest is still being looked up", async () => {
    for (const state of [quest, undefined]) {
      questSession = state;
      await renderButton({
        finishOnly: false,
        deliverableSpec: { ...spec, mode: "none", criteria: [] },
      });
      expect(container.querySelector("button")).toBeNull();
      await renderButton();
      expect(container.querySelector("button")).toBeNull();
    }
  });

  test("keeps its flair", async () => {
    vi.mocked(useQuery).mockImplementation((...args) =>
      getFunctionName(args[0]) === "deliverables:getForSessionActivity"
        ? {
            _id: "test-deliverable",
            flairEarned: [{ criterionId: "mission-1", earnedAt: 1 }],
          }
        : null,
    );
    questSession = quest;
    await renderButton();
    expect(container.querySelectorAll('button[aria-label^="Flair earned:"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("Finish and send");
  });

  test("keeps Check my work, which hands nothing in", async () => {
    questSession = quest;
    await renderButton({ finishOnly: false });
    expect(button().textContent).toBe("Check my work");
  });
});

describe("Your mission disclosure", () => {
  test("renders nothing for empty or non-mission criteria", async () => {
    for (const items of [[], [{ id: "maker-explanation", label: "Your explanation" }]]) {
      await render(createElement(MissionControl, { criteria: items }));
      expect(container.querySelector("button")).toBeNull();
      expect(container.textContent).toBe("");
    }
  });

  test("opens a plain, ordered list of labels through a real button and portal", async () => {
    await render(createElement(MissionControl, { criteria }));
    expect(button().textContent).toBe("Your mission");
    await act(async () => button().click());
    const popover = document.querySelector('[role="dialog"][data-state="open"]');
    expect(popover).not.toBeNull();
    expect(container.contains(popover)).toBe(false);
    expect(Array.from(popover!.querySelectorAll("li"), (item) => item.textContent))
      .toEqual(["Your cart's weight", "Your cart's journey"]);
    expect(popover!.textContent).toBe("Your missionYour cart's weightYour cart's journey");
    expect(popover!.querySelector("button, input, [role='checkbox']")).toBeNull();
  });
});
