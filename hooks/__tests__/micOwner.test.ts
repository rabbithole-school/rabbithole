import { afterEach, describe, expect, it, vi } from "vitest";

// `useIsMicBusy` itself can't be rendered here (edge-runtime, no DOM/React
// test renderer in this repo — see useSmoothedQuery.test.ts for the same
// constraint), so this exercises the exported claim/release API that backs
// it: `useIsMicBusy(token)` reduces to `micOwner !== null && micOwner !==
// token`, i.e. "busy" means a DIFFERENT token holds the mic, never your own.
// This is the module the chat composer (useStreamingDictation), the writing
// box, and the practice handoff mic (useVoiceDictation) all share to
// single-owner the mic (TRA-370: the chat mic wasn't wired to it at all).

// micOwner is a module-level singleton; reset the module between tests so
// one test's claim can't leak into the next.
async function freshMicOwner() {
  vi.resetModules();
  return import("@/hooks/micOwner");
}

describe("micOwner", () => {
  it("claimMic grants an unheld mic and is idempotent for the same token", async () => {
    const { claimMic } = await freshMicOwner();
    const token = Symbol("owner");
    expect(claimMic(token)).toBe(true);
    // Re-claiming with the SAME token (e.g. a re-render) keeps succeeding —
    // this is the "busy by me, not by someone else" case a mic button must
    // never disable itself for.
    expect(claimMic(token)).toBe(true);
  });

  it("claimMic refuses a DIFFERENT token while one is held", async () => {
    const { claimMic } = await freshMicOwner();
    const a = Symbol("a");
    const b = Symbol("b");
    expect(claimMic(a)).toBe(true);
    expect(claimMic(b)).toBe(false);
  });

  it("releaseMic only releases when the token matches (idempotent no-op otherwise)", async () => {
    const { claimMic, releaseMic } = await freshMicOwner();
    const a = Symbol("a");
    const b = Symbol("b");
    claimMic(a);

    // b never held the mic — releasing with the wrong token must not steal
    // or clear a's claim.
    releaseMic(b);
    expect(claimMic(b)).toBe(false); // still held by a

    releaseMic(a);
    expect(claimMic(b)).toBe(true); // now free for b
  });

  afterEach(() => {
    vi.resetModules();
  });
});
