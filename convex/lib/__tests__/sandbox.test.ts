// @vitest-environment node
import { describe, it, expect } from "vitest";
import { runSandboxedCheck, SANDBOX_MAX_RESULT_CHARS } from "../sandbox";

/**
 * Properties of the tutor's `check_work` sandbox (convex/lib/sandbox.ts). This
 * is the safety surface that lets the tutor verify its OWN mechanically-checkable
 * content (a cipher, an arithmetic chain) before presenting it — so these tests
 * pin the escape hatches shut: hostile input must fail CLEANLY, never crash the
 * host or reach it.
 */
describe("runSandboxedCheck — happy path", () => {
  it("returns a computed numeric result", async () => {
    const r = await runSandboxedCheck(`return 2 + 40;`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
      expect(typeof r.durationMs).toBe("number");
    }
  });

  it("serializes objects and arrays", async () => {
    const r = await runSandboxedCheck(`return { a: 1, b: [1, 2, 3], c: "x" };`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1, b: [1, 2, 3], c: "x" });
  });

  it("coerces a bare `undefined` result to null (not an error)", async () => {
    const r = await runSandboxedCheck(`const x = 1;`); // no return
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it("verifies a Caesar-cipher round-trip (the pilot-shaped case)", async () => {
    // The exact failure that motivated this tool: the tutor composes a cipher
    // and must confirm it actually decodes back to the intended message.
    const r = await runSandboxedCheck(`
      const shift = 3;
      const rot = (s, k) => s.replace(/[a-z]/g, (c) =>
        String.fromCharCode(((c.charCodeAt(0) - 97 + k + 26) % 26) + 97));
      const plain = "meet at dawn";
      const cipher = rot(plain, shift);
      const back = rot(cipher, -shift);
      return { cipher, decodesBack: back === plain };
    `);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = r.value as { cipher: string; decodesBack: boolean };
      expect(v.cipher).toBe("phhw dw gdzq");
      expect(v.decodesBack).toBe(true);
    }
  });
});

describe("runSandboxedCheck — resource caps", () => {
  it("kills an infinite loop via the wall-time budget", async () => {
    const r = await runSandboxedCheck(`while (true) {}`, { timeBudgetMs: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/interrupt/i);
      // Bounded — the deadline stopped it, it didn't run for the test timeout.
      expect(r.durationMs).toBeLessThan(5000);
    }
  });

  it("kills a memory bomb via the memory cap", async () => {
    // Long time budget so the MEMORY limit (not the clock) is what stops it.
    const r = await runSandboxedCheck(
      `const a = []; while (true) { a.push(new Array(100000).fill(7)); }`,
      { memoryLimitBytes: 16 * 1024 * 1024, timeBudgetMs: 5000 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/memory/i);
  });

  it("rejects an oversized result", async () => {
    const r = await runSandboxedCheck(
      `return "x".repeat(${SANDBOX_MAX_RESULT_CHARS + 500});`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/size cap|exceeds/i);
  });

  it("rejects a non-JSON-serializable result", async () => {
    const r = await runSandboxedCheck(`return () => 1;`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/serializable/i);
  });
});

describe("runSandboxedCheck — no host escape", () => {
  it("has no `require`", async () => {
    const r = await runSandboxedCheck(`return require("fs");`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/require.*not defined/i);
  });

  it("has no `process`", async () => {
    const r = await runSandboxedCheck(`return process.env.SECRET;`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/process.*not defined/i);
  });

  it("has no `fetch`", async () => {
    const r = await runSandboxedCheck(`return fetch("http://example.com");`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fetch.*not defined/i);
  });

  it("has no timers", async () => {
    const r = await runSandboxedCheck(`return setTimeout(() => {}, 0);`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/setTimeout.*not defined/i);
  });

  it("cannot reach a host `process` via globalThis", async () => {
    const r = await runSandboxedCheck(`return typeof globalThis.process;`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("undefined");
  });

  it("cannot reach the host through the Function constructor", async () => {
    const r = await runSandboxedCheck(
      `return Function("return typeof process")();`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("undefined");
  });
});

describe("runSandboxedCheck — malformed input", () => {
  it("rejects empty code without spinning up a VM", async () => {
    const r = await runSandboxedCheck("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no code/i);
  });

  it("surfaces a syntax error cleanly", async () => {
    const r = await runSandboxedCheck(`return )(;`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/syntax/i);
  });

  it("surfaces a thrown error cleanly", async () => {
    const r = await runSandboxedCheck(`throw new Error("boom");`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/boom/);
  });
});
