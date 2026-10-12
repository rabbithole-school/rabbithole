import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { composerPayloadKey, createSendLock } from "../sendLock";

// ─────────────────────────────────────────────────────────────────────────
// Regression for the reported duplicate scholar message on the iPad: a
// scholar's typed answer was sometimes persisted TWICE in a tutor session.
//
// The session screen has no render harness (mounting it needs dozens of
// mocked Convex queries), so the failing sequence is reproduced against the
// exact control flow of `onSend`'s claim+persist phase in
// native/src/app/session/[id].tsx: read the composer text → (await) flush
// artifact saves → (await) sessions.sendMessage → only THEN clear the
// composer. The `unguarded` harness below is the pre-fix code shape and
// reproduces the duplicate; the `guarded` harness adds the one production
// change (the synchronous sendLock claim) and sends once.
// ─────────────────────────────────────────────────────────────────────────

type Harness = {
  submit: () => Promise<void>;
  type: (text: string) => void;
  /**
   * Stands in for React committing the queued `setInput("")`. Until it runs,
   * the already-rendered submit handler still closes over the old text — which
   * is exactly the window the composer-snapshot ref exists to close.
   */
  commitRender: () => void;
  sent: string[];
  isLocked: () => boolean;
};

/**
 * The claim+persist phase of onSend. Both guards are switchable so a test can
 * show what each one alone does and does not catch.
 */
function makeComposer(options: {
  /** The send lock: closes the window while the mutation is in flight. */
  guarded: boolean;
  /** The composer-snapshot ref: closes the window after it, before the commit. */
  snapshotGuard?: boolean;
  sendMessage: (text: string) => Promise<void>;
  /**
   * Stands in for the pre-mutation work onSend does between the claim and the
   * mutation (the steer + turn bookkeeping). A throw here must still free the
   * claim, or the composer is wedged for the rest of the mount.
   */
  prologue?: () => void;
}): Harness {
  const lock = createSendLock();
  const sent: string[] = [];
  // The committed composer value. `submit` reads it at call time, the way the
  // rendered handler closes over it.
  let input = "";
  let sentComposer: string | null = null;
  const pendingCommits: Array<() => void> = [];
  return {
    type: (text: string) => {
      input = text;
      sentComposer = null;
    },
    commitRender: () => {
      while (pendingCommits.length) pendingCommits.shift()!();
    },
    sent,
    isLocked: () => lock.isLocked(),
    submit: async () => {
      const text = input.trim();
      if (!text) return;
      const snapshot = composerPayloadKey(text, null);
      if (options.snapshotGuard && sentComposer === snapshot) return;
      if (options.guarded && !lock.acquire()) return;
      let claimHeld = options.guarded;
      const releaseSendClaim = () => {
        if (!claimHeld) return;
        claimHeld = false;
        lock.release();
      };
      try {
        // Stands in for flushPendingArtifactSaves() — the first await, which
        // is what lets a second submit re-enter before the mutation runs.
        await Promise.resolve();
        options.prologue?.();
        await options.sendMessage(text);
        sent.push(text);
        // The composer is cleared only after the mutation resolves, so a
        // rejected send never loses the scholar's text — and the clear is a
        // React state update, so it lands on a LATER task (commitRender).
        pendingCommits.push(() => {
          input = "";
        });
        sentComposer = snapshot;
        releaseSendClaim();
      } catch {
        // Mutation rejected: the text stays in the composer, nothing stamped.
      } finally {
        // Safety net for every bail-out before the composer was cleared.
        releaseSendClaim();
      }
    },
  };
}

function deferred() {
  let resolveFn!: () => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

describe("tutor send: double submit inside the pre-resolve window", () => {
  it("reproduces the duplicate without the send lock", async () => {
    const pending = deferred();
    const composer = makeComposer({
      guarded: false,
      sendMessage: () => pending.promise,
    });
    composer.type("the answer is 3");

    // Return pressed twice (or Return + a tap on the send arrow) before the
    // mutation resolves: both submits read the SAME unchanged input.
    const first = composer.submit();
    const second = composer.submit();
    pending.resolve();
    await Promise.all([first, second]);

    expect(composer.sent).toEqual(["the answer is 3", "the answer is 3"]);
  });

  it("persists one message when two submits land before the mutation resolves", async () => {
    const pending = deferred();
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: true,
      sendMessage: () => pending.promise,
    });
    composer.type("the answer is 3");

    const first = composer.submit();
    const second = composer.submit();
    pending.resolve();
    await Promise.all([first, second]);

    expect(composer.sent).toEqual(["the answer is 3"]);
  });

  it("the lock alone still duplicates across the composer-clear commit gap", async () => {
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: false,
      sendMessage: () => Promise.resolve(),
    });
    composer.type("the answer is 3");
    await composer.submit();
    // The clear is queued but React has not committed it, so the rendered
    // handler still closes over the old text and the claim is already free.
    await composer.submit();

    expect(composer.sent).toEqual(["the answer is 3", "the answer is 3"]);
  });

  it("holds that window shut with the composer snapshot", async () => {
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: true,
      sendMessage: () => Promise.resolve(),
    });
    composer.type("the answer is 3");
    await composer.submit();
    // Same submit, same pre-commit moment as the test above.
    await composer.submit();

    expect(composer.sent).toEqual(["the answer is 3"]);
  });

  it("still sends a genuinely retyped identical short answer", async () => {
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: true,
      sendMessage: () => Promise.resolve(),
    });
    composer.type("3");
    await composer.submit();
    composer.commitRender();
    // The scholar types the same one-character answer again a turn later. The
    // snapshot guard must not eat it — typing is what clears the stamp.
    composer.type("3");
    await composer.submit();

    expect(composer.sent).toEqual(["3", "3"]);
  });

  it("still lets a scholar steer with new text once the send has landed", async () => {
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: true,
      sendMessage: () => Promise.resolve(),
    });
    composer.type("the answer is 3");
    await composer.submit();
    // The tutor is now streaming its reply; a new submit steers.
    composer.type("wait, I meant 4");
    await composer.submit();

    expect(composer.sent).toEqual(["the answer is 3", "wait, I meant 4"]);
  });

  it("releases the claim when the pre-mutation work throws", async () => {
    let attempt = 0;
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: true,
      sendMessage: () => Promise.resolve(),
      prologue: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("steer blew up");
      },
    });
    composer.type("the answer is 3");
    await composer.submit();
    expect(composer.sent).toEqual([]);
    // A leaked claim would wedge the composer for the rest of the mount —
    // strictly worse than the duplicate this guards against.
    expect(composer.isLocked()).toBe(false);

    await composer.submit();
    expect(composer.sent).toEqual(["the answer is 3"]);
  });

  it("releases the claim when the mutation rejects so a retry still works", async () => {
    let attempt = 0;
    const composer = makeComposer({
      guarded: true,
      snapshotGuard: true,
      sendMessage: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error("offline"))
          : Promise.resolve();
      },
    });
    composer.type("the answer is 3");
    await composer.submit();
    expect(composer.sent).toEqual([]);

    // The text was never cleared, so the same submit retries it.
    await composer.submit();
    expect(composer.sent).toEqual(["the answer is 3"]);
  });
});

describe("createSendLock", () => {
  it("admits one holder at a time and re-arms on release", () => {
    const lock = createSendLock();
    expect(lock.acquire()).toBe(true);
    expect(lock.acquire()).toBe(false);
    expect(lock.isLocked()).toBe(true);
    lock.release();
    expect(lock.isLocked()).toBe(false);
    expect(lock.acquire()).toBe(true);
  });
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sessionSource = readFileSync(
  resolve(repoRoot, "native/src/app/session/[id].tsx"),
  "utf8",
);
// Assertions below are anchored INSIDE onSend. The screen has several other
// senders (the instruction handback, the retry path) that also call
// runTutorStream, so a file-wide indexOf would find those first and pass
// vacuously.
const onSendStart = sessionSource.indexOf("const onSend = useCallback(");
const onSendEnd = sessionSource.indexOf("const onRetryTurn = useCallback(");
const onSendSource = sessionSource.slice(onSendStart, onSendEnd);

describe("session screen wiring", () => {
  it("brackets onSend's claim+persist phase with the send lock", () => {
    expect(onSendStart).toBeGreaterThan(-1);
    expect(onSendEnd).toBeGreaterThan(onSendStart);
    expect(sessionSource).toContain("createSendLock()");

    // The claim must be synchronous — it has to sit above the first await in
    // onSend (the artifact flush), or a second submit slips through.
    const claim = onSendSource.indexOf(
      "if (!sendLockRef.current.acquire()) return;",
    );
    const flush = onSendSource.indexOf("await flushPendingArtifactSaves()");
    const mutation = onSendSource.indexOf("await sendMessage({");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(flush);
    expect(flush).toBeLessThan(mutation);

    // The no-text-loss guarantee stays: the composer is cleared after the
    // mutation, never before it.
    const clearComposer = onSendSource.indexOf('setInput("");');
    expect(clearComposer).toBeGreaterThan(-1);
    expect(mutation).toBeLessThan(clearComposer);

    // The snapshot the stale-closure guard compares against is stamped
    // SYNCHRONOUSLY next to that clear — a setState there would land on the
    // same later task as the clear and guard nothing — and it is read before
    // the claim is taken, so a refused resubmit never consumes one.
    const stamp = onSendSource.indexOf("sentComposerRef.current = composerSnapshot");
    expect(stamp).toBeGreaterThan(clearComposer);
    const snapshotGuard = onSendSource.indexOf(
      "sentComposerRef.current === composerSnapshot",
    );
    expect(snapshotGuard).toBeGreaterThan(-1);
    expect(snapshotGuard).toBeLessThan(claim);

    // The claim is freed only AFTER the composer is empty — the FIRST release
    // call must come after the clear. Releasing at the mutation instead would
    // leave the already-rendered submit handler able to re-read the text it
    // closed over and send it again.
    const releases = [...onSendSource.matchAll(/releaseSendClaim\(\);/g)].map(
      (m) => m.index,
    );
    expect(releases[0]).toBeGreaterThan(clearComposer);

    // ...and a release also sits in onSend's tail `finally`, past the stream,
    // so no early return or throw before the composer is cleared can leave the
    // composer wedged for the rest of the mount.
    const stream = onSendSource.indexOf("await runTutorStream(");
    expect(stream).toBeGreaterThan(clearComposer);
    expect(releases.at(-1)).toBeGreaterThan(stream);
  });
});
