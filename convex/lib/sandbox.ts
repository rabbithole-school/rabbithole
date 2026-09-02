"use node";

/**
 * A tiny, hostile-input-safe JavaScript sandbox for the tutor's `check_work`
 * tool. Origin: a blind pilot caught the scholar-facing tutor presenting an
 * UNSOLVABLE Caesar-cipher puzzle it had generated from its weights. LLMs are
 * unreliable at letter-level / arithmetic mechanics, so the tutor needs a way
 * to VERIFY mechanically-checkable content it composed BEFORE showing it to the
 * scholar.
 *
 * This runs the tutor's own throwaway check code inside a QuickJS WASM VM with
 * NO host functions exposed — no `require`, `process`, `fetch`, `setTimeout`,
 * no path to the Node host or the network. Each call gets a fresh runtime that
 * is hard-capped on:
 *   - memory   (SANDBOX_MEMORY_LIMIT_BYTES — an allocation bomb dies "out of memory")
 *   - wall time (SANDBOX_TIME_BUDGET_MS via an interrupt handler — an infinite
 *                loop dies "interrupted")
 *   - stack    (SANDBOX_MAX_STACK_BYTES)
 *   - result size (SANDBOX_MAX_RESULT_CHARS — the JSON result is rejected if larger)
 * and the result must be JSON-serializable.
 *
 * The VM is loaded from the SINGLEFILE variant (WASM embedded as base64) rather
 * than the default wasmfile variant, so the whole thing survives esbuild
 * bundling into a Convex "use node" action — there's no separate .wasm file for
 * the bundler to drop. See convex/sandboxActions.ts for the action wrapper.
 *
 * Pure (no Convex imports) so it can be unit-tested directly under vitest.
 */
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from "quickjs-emscripten";
import releaseSyncVariant from "@jitl/quickjs-singlefile-cjs-release-sync";

/** 64 MB — enough for real letter/arithmetic checks, small enough to kill a bomb. */
export const SANDBOX_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** 250 ms wall budget — an infinite loop is interrupted at this deadline. */
export const SANDBOX_TIME_BUDGET_MS = 250;
/** Native call-stack cap for the VM. */
export const SANDBOX_MAX_STACK_BYTES = 512 * 1024;
/** ~8 KB — the JSON-serialized result is rejected past this. */
export const SANDBOX_MAX_RESULT_CHARS = 8 * 1024;
/** Reject obviously-oversized source before we even spin up a VM. */
export const SANDBOX_MAX_CODE_LENGTH = 50_000;

export interface SandboxOptions {
  memoryLimitBytes?: number;
  timeBudgetMs?: number;
  maxStackBytes?: number;
  maxResultChars?: number;
}

export type SandboxResult =
  | { ok: true; value: unknown; durationMs: number }
  | { ok: false; error: string; durationMs: number };

// The WASM module is expensive to instantiate; build it once per process and
// reuse it across calls. Each call still gets its own disposable runtime, so
// there's no cross-call state leak.
let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  }
  return modulePromise;
}

/**
 * Wrap the tutor's code so that:
 *   - it runs as a function body (the tutor `return`s the value to check),
 *   - the value is JSON-serialized INSIDE the VM (so non-serializable results
 *     surface as a clean error rather than crossing the boundary),
 *   - and the serialized size is capped INSIDE the VM (so we never pull a
 *     multi-MB string back into the host).
 * The completion value of the whole expression is the JSON string.
 */
function buildProgram(code: string, maxResultChars: number): string {
  return `(function () {
  "use strict";
  var __result = (function () {
${code}
  })();
  var __json = JSON.stringify(__result === undefined ? null : __result);
  if (typeof __json !== "string") {
    throw new TypeError("check result is not JSON-serializable");
  }
  if (__json.length > ${maxResultChars}) {
    throw new RangeError("check result exceeds the ${maxResultChars}-character size cap");
  }
  return __json;
})()`;
}

/**
 * Run `code` in the sandbox and return its JSON-serializable result (or a clean
 * error string). NEVER throws for sandboxed failures (loops, bombs, escape
 * attempts, bad JS) — those come back as `{ ok: false, error }`.
 */
export async function runSandboxedCheck(
  code: string,
  opts: SandboxOptions = {},
): Promise<SandboxResult> {
  const start = Date.now();
  const memoryLimitBytes = opts.memoryLimitBytes ?? SANDBOX_MEMORY_LIMIT_BYTES;
  const timeBudgetMs = opts.timeBudgetMs ?? SANDBOX_TIME_BUDGET_MS;
  const maxStackBytes = opts.maxStackBytes ?? SANDBOX_MAX_STACK_BYTES;
  const maxResultChars = opts.maxResultChars ?? SANDBOX_MAX_RESULT_CHARS;

  if (typeof code !== "string" || code.trim().length === 0) {
    return { ok: false, error: "No code to check.", durationMs: 0 };
  }
  if (code.length > SANDBOX_MAX_CODE_LENGTH) {
    return {
      ok: false,
      error: `Check code is too long (max ${SANDBOX_MAX_CODE_LENGTH} characters).`,
      durationMs: Date.now() - start,
    };
  }

  const QuickJS = await getModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(maxStackBytes);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + timeBudgetMs),
  );
  const vm = runtime.newContext();

  try {
    const evalResult = vm.evalCode(buildProgram(code, maxResultChars));
    const durationMs = Date.now() - start;

    if (evalResult.error) {
      const dumped = vm.dump(evalResult.error) as {
        name?: string;
        message?: string;
      } | string | null;
      evalResult.error.dispose();
      let error: string;
      if (dumped && typeof dumped === "object") {
        error = [dumped.name, dumped.message].filter(Boolean).join(": ") ||
          "Check failed with an unknown error.";
      } else {
        error = String(dumped ?? "Check failed with an unknown error.");
      }
      return { ok: false, error, durationMs };
    }

    const json = vm.dump(evalResult.value);
    evalResult.value.dispose();
    if (typeof json !== "string") {
      return {
        ok: false,
        error: "check result is not JSON-serializable",
        durationMs,
      };
    }
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return {
        ok: false,
        error: "check produced an unparseable result",
        durationMs,
      };
    }
    return { ok: true, value, durationMs };
  } catch (err) {
    // A host-level failure (e.g. the VM ran out of memory building the result).
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
