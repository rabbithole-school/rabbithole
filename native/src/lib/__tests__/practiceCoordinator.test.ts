import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPracticeCoordinators,
  acquirePracticeCoordinator,
  releasePracticeCoordinator,
} from "../practiceCoordinator";
import type { PracticeCommand } from "../../../vendor/shared/practiceMachine";

// ─────────────────────────────────────────────────────────────────────────
// The coordinator is where mutual exclusion and ordering actually live, so
// these tests are about the two properties the reducer deliberately does not
// provide: only one caller may start a command, and commands sharing an
// ordering domain never interleave.
// ─────────────────────────────────────────────────────────────────────────

const SCHOLAR = "scholar-1";

function submitCommand(id: string): PracticeCommand {
  return {
    kind: "submitAnswer",
    id,
    domain: `outbox:${SCHOLAR}`,
    entry: {
      clientEventId: id,
      itemId: "item-1",
      answer: "1",
      record: true,
      skillLabel: "s",
      queuedAt: 0,
    },
  };
}

function hapticCommand(id: string): PracticeCommand {
  return { kind: "haptic", id, style: "success" };
}

beforeEach(() => {
  __resetPracticeCoordinators();
});

describe("claiming", () => {
  it("grants a claim to exactly one caller", () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    expect(c.tryClaim("submit:evt-1")).toBe(true);
    // This is the Strict-Mode case: a second effect invocation asking for the
    // same command must be refused SYNCHRONOUSLY, before it can start work.
    expect(c.tryClaim("submit:evt-1")).toBe(false);
  });

  it("refuses without any await between the check and the insert", async () => {
    // Simulates two effect invocations racing in the same turn. If the claim
    // were an async dispatch, both would observe "free" and both would run.
    const c = acquirePracticeCoordinator(SCHOLAR);
    const results = [c.tryClaim("submit:evt-1"), c.tryClaim("submit:evt-1")];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("lets a genuinely new occurrence run after the first settles", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    let runs = 0;
    const drain: PracticeCommand = {
      kind: "drainOutbox",
      id: `drain:${SCHOLAR}`,
      domain: `outbox:${SCHOLAR}`,
    };
    await c.execute(drain, async () => {
      runs += 1;
    });
    // A later reconnect legitimately drains again under the same semantic id.
    await c.execute(drain, async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });
});

describe("execute", () => {
  it("runs the winner and silently declines the loser", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const command = submitCommand("submit:evt-1");
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = c.execute(command, async () => {
      started += 1;
      await gate;
    });
    // While the first is still in flight, a duplicate must not start.
    const second = await c.execute(command, async () => {
      started += 1;
    });
    expect(second).toBe(false);
    expect(started).toBe(1);

    release();
    expect(await first).toBe(true);
    expect(started).toBe(1);
  });

  it("releases the claim even when the command throws", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const command = submitCommand("submit:evt-1");
    await expect(
      c.execute(command, async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");
    // A failed submit must be retryable; a wedged claim would strand the item.
    expect(c.isClaimed(command.id)).toBe(false);
  });
});

describe("ordering domains", () => {
  it("never interleaves two commands in the same domain", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const order: string[] = [];
    const run = async (command: PracticeCommand) => {
      order.push(`start:${command.id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${command.id}`);
    };
    await Promise.all([
      c.execute(submitCommand("submit:a"), run),
      c.execute(submitCommand("submit:b"), run),
    ]);
    // Strict alternation, never start/start/end/end: a live answer overtaking
    // an older queued one is exactly the bug the barrier exists to prevent.
    expect(order).toEqual([
      "start:submit:a",
      "end:submit:a",
      "start:submit:b",
      "end:submit:b",
    ]);
  });

  it("keeps breaker issuance behind the lifecycle write that authorizes it", async () => {
    // The server refuses a recovery session until the lifecycle records
    // support, so these two share one domain on purpose.
    const c = acquirePracticeCoordinator(SCHOLAR);
    const domain = "breaker-lifecycle:attempt-1";
    const order: string[] = [];
    const lifecycle: PracticeCommand = {
      kind: "recordBreakerLifecycle",
      id: "breaker:attempt-1:repairCompleted",
      domain,
      triggerAttemptId: "attempt-1",
      operation: "repairCompleted",
    };
    const fresh: PracticeCommand = {
      kind: "serveBreakerFresh",
      id: "breaker:attempt-1:fresh",
      domain,
      triggerAttemptId: "attempt-1",
    };
    const run = async (command: PracticeCommand) => {
      order.push(`start:${command.kind}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${command.kind}`);
    };
    await Promise.all([c.execute(lifecycle, run), c.execute(fresh, run)]);
    expect(order).toEqual([
      "start:recordBreakerLifecycle",
      "end:recordBreakerLifecycle",
      "start:serveBreakerFresh",
      "end:serveBreakerFresh",
    ]);
  });

  it("lets different domains proceed concurrently", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const order: string[] = [];
    const resume: PracticeCommand = {
      kind: "saveResume",
      id: `resume-save:${SCHOLAR}`,
      domain: `resume:${SCHOLAR}`,
      version: 1,
      resumeIdx: 1,
    };
    const run = async (command: PracticeCommand) => {
      order.push(`start:${command.kind}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${command.kind}`);
    };
    await Promise.all([c.execute(submitCommand("submit:a"), run), c.execute(resume, run)]);
    // A resume write must not sit behind a slow submit; they are independent.
    expect(order.slice(0, 2)).toEqual(["start:submitAnswer", "start:saveResume"]);
  });

  it("runs an ephemeral command immediately, outside every domain", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const order: string[] = [];
    const run = async (command: PracticeCommand) => {
      order.push(`start:${command.kind}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${command.kind}`);
    };
    await Promise.all([
      c.execute(submitCommand("submit:a"), run),
      c.execute(hapticCommand("ui:1"), run),
    ]);
    // Both are in flight before either finishes — a haptic must never queue
    // behind a slow submit. (The ephemeral one actually starts first: a domain
    // command defers a microtask through the mutex, which is precisely the
    // cost an ephemeral command is exempt from.)
    expect(order.slice(0, 2).sort()).toEqual(["start:haptic", "start:submitAnswer"]);
    expect(order.slice(2).sort()).toEqual(["end:haptic", "end:submitAnswer"]);
  });

  it("executes an emitted list in order", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const seen: string[] = [];
    await c.executeAll(
      [submitCommand("submit:a"), hapticCommand("ui:1"), submitCommand("submit:b")],
      async (command) => {
        seen.push(command.id);
      },
    );
    expect(seen).toEqual(["submit:a", "ui:1", "submit:b"]);
  });

  it("collapses a Strict Mode duplicate within one committed batch", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    const seen: string[] = [];
    const command = hapticCommand("ui:strict");
    await c.executeAll([command, command], async (current) => {
      seen.push(current.id);
    });
    expect(seen).toEqual(["ui:strict"]);

    // A genuinely later occurrence is a new batch and remains eligible.
    await c.executeAll([command], async (current) => {
      seen.push(current.id);
    });
    expect(seen).toEqual(["ui:strict", "ui:strict"]);
  });

  it("reports a command claimed by an in-flight prior mount", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    expect(c.tryClaim("submit:remount")).toBe(true);
    const run = vi.fn(async () => {});
    const refused = await c.executeAll(
      [submitCommand("submit:remount")],
      run,
    );
    expect(refused).toEqual(["submit:remount"]);
    expect(run).not.toHaveBeenCalled();
    c.release("submit:remount");
  });

  it("lets a replacement mount wait for the prior claim to settle", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    c.tryClaim("submit:remount");
    let released = false;
    const waiting = c.waitForRelease("submit:remount").then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    c.release("submit:remount");
    await waiting;
    expect(released).toBe(true);
  });
});

describe("lifetime", () => {
  it("shares one coordinator per scholar across mounts", () => {
    const a = acquirePracticeCoordinator(SCHOLAR);
    const b = acquirePracticeCoordinator(SCHOLAR);
    // Two mounts, one claim registry — otherwise each would happily start the
    // same command.
    expect(b).toBe(a);
    a.tryClaim("submit:evt-1");
    expect(b.tryClaim("submit:evt-1")).toBe(false);
  });

  it("keeps the registry alive while any reference remains", () => {
    const a = acquirePracticeCoordinator(SCHOLAR);
    acquirePracticeCoordinator(SCHOLAR);
    a.tryClaim("submit:evt-1");
    releasePracticeCoordinator(SCHOLAR); // one of two
    expect(acquirePracticeCoordinator(SCHOLAR).isClaimed("submit:evt-1")).toBe(true);
  });

  it("does not cancel in-flight durable work when the last reference drops", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = c.execute(submitCommand("submit:evt-1"), async () => {
      await gate;
      finished = true;
    });
    // Unmounting mid-submit must not abandon the answer.
    releasePracticeCoordinator(SCHOLAR);
    release();
    await running;
    expect(finished).toBe(true);
  });

  it("gives a genuinely fresh runtime a clean registry, as a reload would", () => {
    const a = acquirePracticeCoordinator(SCHOLAR);
    a.tryClaim("submit:evt-1");
    // A process reload destroys this object entirely; recovery comes from the
    // durable sources, not from a resurrected ledger.
    __resetPracticeCoordinators();
    expect(acquirePracticeCoordinator(SCHOLAR).isClaimed("submit:evt-1")).toBe(false);
  });

  it("keeps separate scholars' claims independent", () => {
    const a = acquirePracticeCoordinator("scholar-a");
    const b = acquirePracticeCoordinator("scholar-b");
    expect(a.tryClaim("submit:evt-1")).toBe(true);
    expect(b.tryClaim("submit:evt-1")).toBe(true);
  });
});

describe("review regression: remount must not defeat exclusivity", () => {
  it("keeps the SAME coordinator when the last reference drops mid-flight", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = c.execute(submitCommand("submit:evt-1"), async () => {
      await gate;
    });

    // The component unmounts while the submit is still open.
    releasePracticeCoordinator(SCHOLAR);
    // A remount must inherit the SAME claim registry and mutex. A fresh one
    // would happily start the very command still in flight, or run a later
    // command in the same ordering domain concurrently with it.
    const remounted = acquirePracticeCoordinator(SCHOLAR);
    expect(remounted).toBe(c);
    expect(remounted.isClaimed("submit:evt-1")).toBe(true);

    release();
    await running;
  });

  it("forgets the coordinator once both references and in-flight work reach zero", async () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = c.execute(submitCommand("submit:evt-1"), async () => {
      await gate;
    });
    releasePracticeCoordinator(SCHOLAR);
    expect(c.inFlight).toBe(1);

    release();
    await running;
    expect(c.inFlight).toBe(0);
    // Now genuinely idle and unreferenced, so a later acquire starts clean.
    const fresh = acquirePracticeCoordinator(SCHOLAR);
    expect(fresh).not.toBe(c);
  });

  it("still evicts immediately when nothing is in flight", () => {
    const c = acquirePracticeCoordinator(SCHOLAR);
    c.tryClaim("submit:evt-1");
    releasePracticeCoordinator(SCHOLAR);
    expect(acquirePracticeCoordinator(SCHOLAR)).not.toBe(c);
  });
});
