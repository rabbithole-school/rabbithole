import { describe, expect, test } from "vitest";
import {
  clearAllArtifactSaves,
  clearArtifactSave,
  flushAllArtifactSaves,
  registerArtifactSave,
} from "../artifactSaveRegistry";

describe("artifact save registry", () => {
  test("keeps a mounted editor registered after successful flushes", async () => {
    const id = "mounted-editor";
    let calls = 0;
    const unregister = registerArtifactSave(id, async () => {
      calls += 1;
    });

    await flushAllArtifactSaves();
    await flushAllArtifactSaves();
    expect(calls).toBe(2);

    unregister();
    await Promise.resolve();
    clearArtifactSave(id);
  });

  test("keeps a failed unmount flush blocking until the draft is resolved", async () => {
    const id = "conflicted-editor";
    const conflict = new Error("revision conflict");
    const unregister = registerArtifactSave(id, async () => {
      throw conflict;
    });

    unregister();
    await expect(flushAllArtifactSaves()).rejects.toBe(conflict);

    clearArtifactSave(id);
  });

  test("lets a remounted editor replace a stale conflict blocker", async () => {
    const id = "remounted-editor";
    const unregisterStale = registerArtifactSave(id, async () => {
      throw new Error("stale conflict");
    });
    unregisterStale();

    let resolved = false;
    const unregisterCurrent = registerArtifactSave(id, async () => {
      resolved = true;
    });
    await flushAllArtifactSaves();
    expect(resolved).toBe(true);

    unregisterCurrent();
    await Promise.resolve();
    clearArtifactSave(id);
  });

  test("clears stale blockers when their session unmounts", async () => {
    registerArtifactSave("old-session", async () => {
      throw new Error("old conflict");
    });
    clearAllArtifactSaves();
    await expect(flushAllArtifactSaves()).resolves.toBeUndefined();
  });
});
