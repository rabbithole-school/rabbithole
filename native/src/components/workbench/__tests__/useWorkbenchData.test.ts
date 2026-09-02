/**
 * Guards the two invariants of the Workbench lazy-open that pull in opposite
 * directions, and which a plausible-looking refactor breaks one of every time:
 *
 *  1. a REJECTED ensure must not re-fire on its own (otherwise a teacher on a
 *     scholar-unopened bench storms the mutation forever), and
 *  2. retry() must ACTUALLY re-fire it (the web twin shipped a retry that only
 *     re-armed a ref — mutating a ref changes no dependency, so the effect
 *     never re-ran and the scholar stayed stuck on the error state).
 *
 * `useMutation` is mocked as a STABLE reference because that is what
 * convex/react guarantees (it useMemo's on [client, functionName]) — the
 * no-loop property depends on it, so the fake must not be more stable than the
 * real thing in a way that hides a regression.
 */

import { createElement, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryResult, ensureMock } = vi.hoisted(() => ({
  queryResult: { current: null as unknown },
  ensureMock: vi.fn<(args: { sessionId: string }) => Promise<unknown>>(),
}));

vi.mock("convex/react", () => ({
  useQuery: () => queryResult.current,
  useMutation: () => ensureMock,
}));
vi.mock("@/lib/convex", () => ({
  api: {
    simulatorBenches: {
      getBench: "simulatorBenches.getBench",
      ensureBench: "simulatorBenches.ensureBench",
      listNotebook: "simulatorBenches.listNotebook",
    },
    simulatorRuns: {
      get: "simulatorRuns.get",
      listForBench: "simulatorRuns.listForBench",
      queueState: "simulatorRuns.queueState",
    },
  },
}));

import { useWorkbenchBench, useWorkbenchRuns } from "../useWorkbenchData";

type Bench = ReturnType<typeof useWorkbenchBench>;
type Runs = ReturnType<typeof useWorkbenchRuns>;

/** Live handle on the hook's latest return value, captured out of band (in an
 *  effect, never during render) so the probe stays a pure component. */
const seen: { current: Bench | null } = { current: null };
const seenRuns: { current: Runs | null } = { current: null };

function Harness({ sessionId }: { sessionId: string }) {
  const value = useWorkbenchBench(sessionId as never);
  useEffect(() => {
    seen.current = value;
  });
  return null;
}

function RunsHarness({ sessionId }: { sessionId: string }) {
  const value = useWorkbenchRuns(sessionId as never);
  useEffect(() => {
    seenRuns.current = value;
  });
  return null;
}

/** The hook's return value as of the last committed render. */
function latest(): Bench {
  if (!seen.current) throw new Error("Harness has not rendered yet");
  return seen.current;
}

/** Mount the hook and let the ensure promise settle. */
async function mount(sessionId = "session_a") {
  let tree: ReturnType<typeof create> | null = null;
  await act(async () => {
    tree = create(createElement(Harness, { sessionId }));
  });
  return tree as unknown as ReturnType<typeof create>;
}

beforeEach(() => {
  seen.current = null;
  seenRuns.current = null;
  queryResult.current = null; // aggregate missing → the lazy open fires
  ensureMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWorkbenchBench lazy open", () => {
  it("does not re-fire a rejected ensure on its own", async () => {
    ensureMock.mockRejectedValue(new Error("Only the scholar can open this Workbench"));

    const tree = await mount();

    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(latest().ensureError).toBe("Only the scholar can open this Workbench");

    // Re-render a few times: the failure state must be a fixed point, not a spin.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        tree.update(createElement(Harness, { sessionId: "session_a" }));
      });

    }
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  describe("useWorkbenchRuns", () => {
    it("keeps the loading state distinct from an empty run history", async () => {
      queryResult.current = undefined;
      await act(async () => {
        create(createElement(RunsHarness, { sessionId: "session_a" }));
      });
      expect(seenRuns.current).toBeUndefined();

      queryResult.current = [];
      await act(async () => {
        create(createElement(RunsHarness, { sessionId: "session_a" }));
      });
      expect(seenRuns.current).toEqual([]);
    });
  });

  it("retry() actually re-fires the ensure", async () => {
    ensureMock.mockRejectedValue(new Error("Could not open this Workbench"));

    await mount();
    expect(ensureMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      latest().retry();
    });

    expect(ensureMock).toHaveBeenCalledTimes(2);
    expect(ensureMock).toHaveBeenLastCalledWith({ sessionId: "session_a" });
  });

  it("clears the error while a retry is in flight, then restores it on failure", async () => {
    let rejectOpen: ((reason: Error) => void) | null = null;
    ensureMock
      .mockRejectedValueOnce(new Error("first failure"))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOpen = reject;
          }),
      );

    await mount();
    expect(latest().ensureError).toBe("first failure");

    // In flight → no error, so the screen shows "opening the bench…" rather than
    // a stale failure the scholar already acted on.
    await act(async () => {
      latest().retry();
    });
    expect(latest().ensureError).toBeNull();

    await act(async () => {
      rejectOpen?.(new Error("second failure"));
    });
    expect(latest().ensureError).toBe("second failure");
  });

  it("opens again when the hook is pointed at a different session", async () => {
    ensureMock.mockRejectedValue(new Error("nope"));

    const tree = await mount("session_a");
    expect(ensureMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.update(createElement(Harness, { sessionId: "session_b" }));
    });

    expect(ensureMock).toHaveBeenCalledTimes(2);
    expect(ensureMock).toHaveBeenLastCalledWith({ sessionId: "session_b" });
  });

  it("does not open a bench that already exists", async () => {
    queryResult.current = { compiledPolicies: [{ status: "ready" }] };

    await mount();

    expect(ensureMock).not.toHaveBeenCalled();
    expect(latest().ensureError).toBeNull();
    expect(latest().isLoading).toBe(false);
  });

  it.each(["failed", "compiling"])(
    "heals a %s policy once per session, silently",
    async (status) => {
      queryResult.current = { compiledPolicies: [{ status }] };
      ensureMock.mockRejectedValue(
        new Error("Only the scholar can open this Workbench"),
      );

      const tree = await mount();

      expect(ensureMock).toHaveBeenCalledTimes(1);
      // A teacher's heal attempt throws; that must stay invisible.
      expect(latest().ensureError).toBeNull();

      await act(async () => {
        tree.update(createElement(Harness, { sessionId: "session_a" }));
      });
      expect(ensureMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        tree.update(createElement(Harness, { sessionId: "session_b" }));
      });
      expect(ensureMock).toHaveBeenCalledTimes(2);
      expect(ensureMock).toHaveBeenLastCalledWith({ sessionId: "session_b" });
    },
  );
});
